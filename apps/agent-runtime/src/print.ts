import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { parse as parseYaml } from "yaml";

import { messagePersistExtension, runZiaAgentPrint } from "@zia/core";
import { AutoApproveResolver } from "@zia/callbacks";
import { FileBasedMemoryProvider, SqliteFtsMemoryProvider } from "@zia/memory";
import { createMonthlySpendStore, openDatabase, SqliteAuditLog, SqliteMessageStore } from "@zia/persistence";
import { createBuiltinTools, createMcpAdapter } from "@zia/tools";

/**
 * Non-interactive print entry point — runs ONE prompt and exits.
 *
 * Usage: pnpm --filter @zia/agent-runtime print <ficha-dir> "<prompt>"
 *
 * Mirrors tui.ts's composition root exactly (DB, audit, message store, memory
 * provider, builtin tools, MCP adapter, message-persist extension) but drives
 * the agent with runZiaAgentPrint instead of the interactive TUI.
 *
 * Governance:
 *  - DEFAULT = fail-closed. medio/alto tool calls are DENIED (no human to
 *    approve) and audited as "system:fail-closed". Only trivial tools run.
 *    This is the safe default for cron/webhook use.
 *  - ZIA_PRINT_APPROVE_ALL=1 binds AutoApproveResolver — auto-approves every
 *    medio/alto call. For e2e tests / explicitly opted-in unattended runs ONLY.
 *
 * Output:
 *  - default: "text" mode — prints only the final assistant message.
 *  - ZIA_PRINT_JSON=1: "json" mode — streams all events as JSONL (for e2e
 *    assertions on which tools ran).
 */
async function main(): Promise<void> {
  const fichaArg = process.argv[2];
  const prompt = process.argv[3];
  if (!fichaArg || !prompt) {
    process.stderr.write(
      'Usage: pnpm --filter @zia/agent-runtime print <ficha-dir> "<prompt>"\n' +
        'Example: pnpm --filter @zia/agent-runtime print agents/_template "List your files"\n',
    );
    process.exit(1);
    return;
  }

  // Suppress pi.dev's update banner (noise for a zia agent).
  process.env.PI_SKIP_VERSION_CHECK ??= "1";

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const fichaDir = resolve(baseDir, fichaArg);

  // Load the ficha's own .env (written by `zia model`) BEFORE resolving the
  // model + credential — same precedence rules as the TUI entry point.
  const fichaEnvPath = join(fichaDir, ".env");
  if (existsSync(fichaEnvPath)) {
    process.loadEnvFile(fichaEnvPath);
  }

  // Boot the MCP adapter — spawns mcp.yaml servers and produces WrappableTools.
  const handle = await createMcpAdapter(fichaDir);

  let db: ReturnType<typeof openDatabase> | undefined;

  // Signal handlers registered before openDatabase so a signal during startup
  // still disposes the MCP subprocesses and closes the DB.
  process.once("SIGTERM", () => {
    void handle.dispose().then(() => { db?.close(); process.exit(0); }).catch(() => { db?.close(); process.exit(1); });
  });
  process.once("SIGINT", () => {
    void handle.dispose().then(() => { db?.close(); process.exit(0); }).catch(() => { db?.close(); process.exit(1); });
  });

  let exitCode = 0;
  try {
    db = openDatabase(join(fichaDir, "zia.db"));
    const auditLog = new SqliteAuditLog(db);

    // F-CORE-8: monthly spend store for budget enforcement (SPEC-EXT-2).
    // Created from the same db handle as SqliteAuditLog — one DB per agent.
    const monthlySpendStore = createMonthlySpendStore(db);

    const messageStore = new SqliteMessageStore(db);
    const sessionKey = `print:${basename(fichaDir)}`;

    // Read optional memory.provider from profile.yaml (default 'file').
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

    const builtinTools = createBuiltinTools(fichaDir, {
      searchFn: (q, lim) => messageStore.search(q, lim),
      memoryWriteFn: (body) => memoryProvider.write(body),
      memorySearchFn: (q, lim) => memoryProvider.search(q, lim),
    });

    // Governance: fail-closed by default; opt into auto-approve only via env.
    const approvalResolver =
      process.env.ZIA_PRINT_APPROVE_ALL === "1" ? new AutoApproveResolver() : undefined;

    // F-CORE-8: monthlySpendStore injected for budget enforcement (SPEC-EXT-2).
    exitCode = await runZiaAgentPrint({
      fichaDir,
      prompt,
      mode: process.env.ZIA_PRINT_JSON === "1" ? "json" : "text",
      approvalResolver,
      rawTools: [...handle.tools, ...builtinTools],
      auditLog,
      extensionFactories: [messagePersistExtension(messageStore, sessionKey)],
      monthlySpendStore,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    exitCode = 1;
  } finally {
    // runZiaAgentPrint (via runPrintMode) already disposed the pi.dev runtime.
    // We still own the MCP adapter and the DB handle.
    await handle.dispose();
    db?.close();
  }
  process.exit(exitCode);
}

await main();
