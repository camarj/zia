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
  process.once("SIGTERM", () => {
    void handle.dispose().then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void handle.dispose().then(() => process.exit(0));
  });

  try {
    // SPEC-API-3: pass handle.tools as rawTools into the agent.
    await runZiaAgentTui({ fichaDir, rawTools: handle.tools });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  } finally {
    // Dispose regardless of success or error (SPEC-LIFE-3 / design §3 teardown).
    await handle.dispose();
  }
}

await main();
