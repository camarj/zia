import { resolve } from "node:path";
import process from "node:process";

import { runZiaAgentTui } from "@zia/core";
import { createMcpAdapter } from "@zia/tools";

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

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const fichaDir = resolve(baseDir, fichaArg);

  // Boot the MCP adapter — spawns all MCP servers declared in mcp.yaml and
  // produces WrappableTools to feed into the agent's rawTools slot.
  // SPEC-API-3: createMcpAdapter before createZiaAgent; pass handle.tools as rawTools.
  const handle = await createMcpAdapter(fichaDir);

  // SIGTERM / SIGINT: close MCP subprocesses cleanly before exit.
  // Registered once per process — no risk of double-dispose (handle.dispose is idempotent).
  // .catch ensures the process still exits even if dispose() rejects.
  process.once("SIGTERM", () => {
    void handle.dispose().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.once("SIGINT", () => {
    void handle.dispose().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  // W-1 fix: track exit code outside the try/catch so dispose() in finally
  // always runs before process.exit() — a process.exit(1) inside catch would
  // hard-stop the process and skip the finally block, orphaning MCP subprocesses.
  let exitCode = 0;
  try {
    // SPEC-API-3: pass handle.tools as rawTools into the agent.
    await runZiaAgentTui({ fichaDir, rawTools: handle.tools });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    exitCode = 1;
  } finally {
    // Dispose regardless of success or error (SPEC-LIFE-3 / design §3 teardown).
    // Runs before process.exit() so MCP subprocesses are never orphaned on crash.
    await handle.dispose();
  }
  process.exit(exitCode);
}

await main();
