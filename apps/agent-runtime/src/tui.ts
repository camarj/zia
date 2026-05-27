import { resolve } from "node:path";
import process from "node:process";

import { runZiaAgentTui } from "@zia/core";

async function main(): Promise<void> {
  const fichaArg = process.argv[2];
  if (!fichaArg) {
    process.stderr.write(
      "Usage: pnpm --filter @zia/agent-runtime tui <ficha-dir>\n" +
        "Example: pnpm --filter @zia/agent-runtime tui agents/_template\n",
    );
    process.exit(1);
  }

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const fichaDir = resolve(baseDir, fichaArg);
  try {
    await runZiaAgentTui({ fichaDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

await main();
