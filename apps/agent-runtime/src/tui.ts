import { resolve } from "node:path";
import process from "node:process";

import { runZiaAgentTui } from "@zia/core";

const PLACEHOLDER_API_KEY = "sk-ant-REPLACE_ME";
const ENV_VAR = "ANTHROPIC_API_KEY";

async function main(): Promise<void> {
  const fichaArg = process.argv[2];
  if (!fichaArg) {
    process.stderr.write(
      "Usage: pnpm --filter @zia/agent-runtime tui <ficha-dir>\n" +
        "Example: pnpm --filter @zia/agent-runtime tui agents/_template\n",
    );
    process.exit(1);
  }

  const apiKey = process.env[ENV_VAR];
  if (!apiKey || apiKey === PLACEHOLDER_API_KEY) {
    process.stderr.write(
      `zia: ${ENV_VAR} is not set (or still the placeholder).\n` +
        "Set it in .env at the repo root before launching the TUI.\n",
    );
    process.exit(1);
  }

  const fichaDir = resolve(process.cwd(), fichaArg);
  await runZiaAgentTui({ fichaDir });
}

await main();
