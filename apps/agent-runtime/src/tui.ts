import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { parse as parseYaml } from "yaml";

import { messagePersistExtension, runZiaAgentTui } from "@zia/core";
import { FileBasedMemoryProvider, SqliteFtsMemoryProvider } from "@zia/memory";
import { openDatabase, SqliteAuditLog, SqliteMessageStore } from "@zia/persistence";
import { createBuiltinTools, createMcpAdapter } from "@zia/tools";

async function main(): Promise<void> {
  const fichaArg = process.argv[2];
  if (!fichaArg) {
    process.stderr.write(
      "Usage: pnpm --filter @zia/agent-runtime tui <ficha-dir>\n" +
        "Example: pnpm --filter @zia/agent-runtime tui agents/_template\n",
    );
    process.exit(1);
    return;
  }

  // Suppress pi.dev's "new version available · run pi update" startup banner —
  // it points at the SDK's upstream, which is noise for a zia agent. The branded
  // header (zia banner) is installed separately via the ziaHeaderExtension.
  // `??=` so an operator can still force the check back on with the env var.
  process.env.PI_SKIP_VERSION_CHECK ??= "1";

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const fichaDir = resolve(baseDir, fichaArg);

  // Load the ficha's own .env (written by `zia model`) BEFORE resolving the
  // model + credential, so a saved API key is available without re-exporting
  // it every run. This closes the loop: `zia model` persists the credential to
  // <fichaDir>/.env, and this is where the runtime reads it back.
  //
  // Precedence (matches Hermes provider-runtime §7 — explicit beats saved):
  // process.loadEnvFile never overrides a var already present in the shell, so
  // an explicit `export ANTHROPIC_API_KEY=...` still wins over the ficha .env.
  //
  // Skipped silently when the ficha has no .env — OAuth providers persist to
  // auth.json (loaded by AuthStorage.create()) and custom endpoints need no key.
  const fichaEnvPath = join(fichaDir, ".env");
  if (existsSync(fichaEnvPath)) {
    process.loadEnvFile(fichaEnvPath);
  }

  // Boot the MCP adapter — spawns all MCP servers declared in mcp.yaml and
  // produces WrappableTools to feed into the agent's rawTools slot.
  // SPEC-API-3: createMcpAdapter before createZiaAgent; pass handle.tools as rawTools.
  const handle = await createMcpAdapter(fichaDir);

  // The DB handle is opened INSIDE the try block below so that any failure
  // (read-only volume, WAL pragma failure, schema-version mismatch) still runs
  // the finally block and disposes the already-spawned MCP subprocesses (W-1).
  // Gateway slice: thread this same `db` handle into SessionStore when wiring gateways.
  let db: ReturnType<typeof openDatabase> | undefined;

  // SIGTERM / SIGINT: close MCP subprocesses and the DB cleanly before exit.
  // Registered BEFORE openDatabase so a signal during startup is still handled.
  // Registered once per process — no risk of double-dispose (handle.dispose is idempotent).
  // .catch ensures the process still exits even if dispose() rejects.
  process.once("SIGTERM", () => {
    void handle.dispose().then(() => { db?.close(); process.exit(0); }).catch(() => { db?.close(); process.exit(1); });
  });
  process.once("SIGINT", () => {
    void handle.dispose().then(() => { db?.close(); process.exit(0); }).catch(() => { db?.close(); process.exit(1); });
  });

  // W-1 fix: track exit code outside the try/catch so dispose() in finally
  // always runs before process.exit() — a process.exit(1) inside catch would
  // hard-stop the process and skip the finally block, orphaning MCP subprocesses.
  let exitCode = 0;
  try {
    // Open one SQLite DB for this agent container, co-located with the ficha.
    // This is the ONLY place @zia/persistence is imported — the composition root owns it.
    db = openDatabase(join(fichaDir, "zia.db"));
    const auditLog = new SqliteAuditLog(db);

    // B.4: MessageStore + builtin tools + message-persist extension wiring.
    // sessionKey identifies this TUI session in the messages table. Gateway
    // slice will supply real per-session keys; a single TUI session is correct here.
    const messageStore = new SqliteMessageStore(db);
    const sessionKey = `tui:${basename(fichaDir)}`;

    // SPEC-WIRE-1, ADR-M8: read optional memory.provider from profile.yaml.
    // Default is 'file' (FileBasedMemoryProvider, human-readable MEMORY.md).
    // 'sqlite' selects SqliteFtsMemoryProvider wired to the shared db handle.
    let memoryBackend: string = "file";
    try {
      const profileRaw = await readFile(join(fichaDir, "profile.yaml"), "utf8");
      const profileData = parseYaml(profileRaw) as Record<string, unknown> | null;
      const memoryBlock = profileData?.["memory"];
      if (
        memoryBlock !== null &&
        typeof memoryBlock === "object" &&
        "provider" in (memoryBlock as object)
      ) {
        const provider = (memoryBlock as Record<string, unknown>)["provider"];
        if (provider === "sqlite" || provider === "file") {
          memoryBackend = provider;
        }
      }
    } catch {
      // ENOENT or parse error → fall back to 'file' (no-throw, defensive)
    }

    const memoryProvider =
      memoryBackend === "sqlite"
        ? new SqliteFtsMemoryProvider(db)
        : new FileBasedMemoryProvider(join(fichaDir, "MEMORY.md"));

    // SPEC-WIRE-2: use options-object form (positional form removed in task 3.3).
    const builtinTools = createBuiltinTools(fichaDir, {
      searchFn: (q, lim) => messageStore.search(q, lim),
      memoryWriteFn: (body) => memoryProvider.write(body),
      memorySearchFn: (q, lim) => memoryProvider.search(q, lim),
    });

    // SPEC-API-3: rawTools = MCP tools + builtin tools; auditLog + extensionFactories wired.
    await runZiaAgentTui({
      fichaDir,
      rawTools: [...handle.tools, ...builtinTools],
      auditLog,
      extensionFactories: [messagePersistExtension(messageStore, sessionKey)],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    exitCode = 1;
  } finally {
    // Dispose MCP subprocesses and close the DB (WAL checkpoint) before exit.
    // db may be undefined if openDatabase threw — dispose the handle regardless.
    await handle.dispose();
    db?.close();
  }
  process.exit(exitCode);
}

await main();
