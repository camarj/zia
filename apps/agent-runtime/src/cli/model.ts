import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { input, password, select } from "@inquirer/prompts";
import { providerCatalog, type Provider } from "@zia/providers";

import { upsertCredential } from "./credential-writer.ts";
import { updateProfileLlmDefault } from "./profile-writer.ts";

const CUSTOM_MODEL_SENTINEL = "__custom_model_id__";

/**
 * Interactive `zia model` flow — PR 2 covers the api-key path only.
 * OAuth providers (github-copilot, openai-codex) and the `custom`
 * OpenAI-compatible endpoint flow land in PRs 3 and 4 of the
 * `llm-provider-cli` SDD.
 *
 * Usage: `pnpm --filter @zia/agent-runtime model <ficha-dir>`
 *
 * On success:
 * - `${fichaDir}/profile.yaml` is updated under `llm.default`
 *   (preserving comments) with the chosen provider + model.
 * - `${fichaDir}/.env` upserts the credential under the catalog's
 *   default env-var name with `chmod 600`.
 */
async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write(
      "Usage: pnpm --filter @zia/agent-runtime model <ficha-dir>\n" +
        "Example: pnpm --filter @zia/agent-runtime model agents/_template\n",
    );
    process.exit(1);
  }

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const fichaDir = resolve(baseDir, arg);

  if (!existsSync(fichaDir)) {
    process.stderr.write(`zia: ficha directory ${fichaDir} does not exist.\n`);
    process.exit(1);
  }
  if (!existsSync(resolve(fichaDir, "profile.yaml"))) {
    process.stderr.write(`zia: ${fichaDir} is missing profile.yaml. Run /new-agent first.\n`);
    process.exit(1);
  }

  const apiKeyProviders = providerCatalog.filter((p) => p.type === "api-key");

  const providerKey = await select<string>({
    message: "Provider:",
    choices: apiKeyProviders.map((p) => ({
      name: p.label,
      value: p.key,
      description: p.credentialEnv,
    })),
  });

  const provider = apiKeyProviders.find((p) => p.key === providerKey);
  if (!provider) {
    throw new Error(`zia: unexpected provider key "${providerKey}"`);
  }
  if (!provider.credentialEnv) {
    throw new Error(`zia: catalog entry for ${provider.key} is missing credentialEnv`);
  }

  const modelId = await pickModelId(provider);

  const existingKey = process.env[provider.credentialEnv];
  const apiKey = await password({
    message: existingKey
      ? `${provider.credentialEnv} (press Enter to keep current shell value):`
      : `${provider.credentialEnv}:`,
    mask: "*",
    validate: (value) => {
      if (!value || value.trim() === "") {
        return existingKey ? true : `${provider.credentialEnv} cannot be empty`;
      }
      return true;
    },
  });
  const credentialValue = apiKey && apiKey.trim() !== "" ? apiKey : existingKey;
  if (!credentialValue) {
    throw new Error(`zia: no value provided for ${provider.credentialEnv}`);
  }

  await updateProfileLlmDefault(fichaDir, {
    provider: provider.key,
    modelId,
  });
  await upsertCredential(fichaDir, provider.credentialEnv, credentialValue);

  process.stdout.write(
    `\nSaved ${provider.key} / ${modelId} to ${fichaDir}/profile.yaml.\n` +
      `Credential ${provider.credentialEnv} written to ${fichaDir}/.env (chmod 600).\n` +
      `Run: pnpm --filter @zia/agent-runtime tui ${arg}\n`,
  );
}

async function pickModelId(provider: Provider): Promise<string> {
  const fromCatalog = provider.defaultModels;
  if (fromCatalog.length === 0) {
    return input({
      message: `${provider.label} model id:`,
      validate: (v) => (v.trim() === "" ? "model id cannot be empty" : true),
    });
  }

  const choice = await select<string>({
    message: "Model:",
    choices: [
      ...fromCatalog.map((m) => ({ name: m, value: m })),
      { name: "Custom model id…", value: CUSTOM_MODEL_SENTINEL },
    ],
  });

  if (choice !== CUSTOM_MODEL_SENTINEL) {
    return choice;
  }

  return input({
    message: "Custom model id:",
    validate: (v) => (v.trim() === "" ? "model id cannot be empty" : true),
  });
}

// Surface inquirer's "user pressed Ctrl+C" cleanly instead of dumping a stack.
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/User force closed the prompt/i.test(message) || /aborted/i.test(message)) {
    process.stderr.write("Aborted.\n");
    process.exit(130);
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

// Helper read kept for future scenarios that read the YAML before prompting.
export async function readProfileRaw(fichaDir: string): Promise<string> {
  return readFile(resolve(fichaDir, "profile.yaml"), "utf8");
}
