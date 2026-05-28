import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { input, password, select } from "@inquirer/prompts";
import { isOAuthProvider, providerCatalog, type Provider } from "@zia/providers";

import { upsertCredential } from "./credential-writer.ts";
import { runOAuthFlow, type OAuthProviderId } from "./oauth-flow.ts";
import { updateProfileLlmDefault } from "./profile-writer.ts";
import { validateEndpoint } from "./validate-endpoint.ts";

const CUSTOM_MODEL_SENTINEL = "__custom_model_id__";
const CUSTOM_ENDPOINT_SENTINEL = "__custom_endpoint__";

/**
 * Interactive `zia model` flow — supports three credential paths:
 *
 *   1. API-key providers (Anthropic, OpenAI, …): prompt for key → write to .env
 *   2. Custom OpenAI-compatible endpoint (Ollama, vLLM, …): validate URL → no creds written
 *   3. OAuth providers (GitHub Copilot, OpenAI Codex): browser/device-code flow → auth.json
 *
 * Usage: `pnpm --filter @zia/agent-runtime model <ficha-dir>`
 *
 * On success:
 * - `${fichaDir}/profile.yaml` is updated under `llm.default`
 *   (preserving comments) with the chosen provider + model.
 * - For api-key providers: `${fichaDir}/.env` upserts the credential (chmod 600).
 * - For OAuth providers: credentials are persisted to `~/.pi/agent/auth.json`
 *   (or `$PI_CODING_AGENT_DIR/auth.json`) — NOT to .env.
 * - For custom endpoints: no credential file is written.
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
  const oauthProviders = providerCatalog.filter((p) => p.type === "oauth");

  const providerKey = await select<string>({
    message: "Provider:",
    choices: [
      ...apiKeyProviders.map((p) => ({
        name: p.label,
        value: p.key,
        description: p.credentialEnv,
      })),
      ...oauthProviders.map((p) => ({
        name: p.label,
        value: p.key,
        description: "OAuth — browser/device-code flow; token saved to auth.json",
      })),
      {
        name: "Custom OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, …)",
        value: CUSTOM_ENDPOINT_SENTINEL,
        description: "Self-hosted endpoint; no API key written",
      },
    ],
  });

  if (providerKey === CUSTOM_ENDPOINT_SENTINEL) {
    await runCustomEndpointFlow(fichaDir, arg);
    return;
  }

  if (isOAuthProvider(providerKey)) {
    await runOAuthProviderFlow(fichaDir, arg, providerKey as OAuthProviderId);
    return;
  }

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

async function runOAuthProviderFlow(
  fichaDir: string,
  fichaArg: string,
  providerKey: OAuthProviderId,
): Promise<void> {
  const oauthProvider = providerCatalog.find((p) => p.key === providerKey);
  if (!oauthProvider) {
    throw new Error(`zia: unexpected OAuth provider key "${providerKey}"`);
  }

  const modelId = await pickModelId(oauthProvider);

  process.stdout.write(`\nStarting OAuth flow for ${oauthProvider.label}…\n`);

  // OAuth credentials go to auth.json via AuthStorage — NOT to .env.
  await runOAuthFlow(providerKey);

  // Update profile.yaml to set this provider + model as llm.default.
  // No credentials_env is written — auth.json is the credential store.
  await updateProfileLlmDefault(fichaDir, {
    provider: providerKey,
    modelId,
  });

  process.stdout.write(
    `\nSaved ${providerKey} / ${modelId} to ${fichaDir}/profile.yaml.\n` +
      `OAuth token saved to auth.json (shared with the agent runtime).\n` +
      `Run: pnpm --filter @zia/agent-runtime tui ${fichaArg}\n`,
  );
}

async function runCustomEndpointFlow(fichaDir: string, fichaArg: string): Promise<void> {
  const baseUrl = await input({
    message: "Base URL (e.g. http://localhost:11434 or http://host:8000/v1):",
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed === "") return "base URL cannot be empty";
      try {
        // eslint-disable-next-line no-new
        new URL(trimmed);
        return true;
      } catch {
        return "must be a parseable URL (include protocol, e.g. http://)";
      }
    },
  });

  const modelId = await input({
    message: "Model id (as the endpoint expects it, e.g. llama3.1:8b):",
    validate: (v) => (v.trim() === "" ? "model id cannot be empty" : true),
  });

  // Validate BEFORE touching the filesystem so a bogus URL leaves
  // profile.yaml and .env untouched.
  try {
    await validateEndpoint(baseUrl.trim());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`zia: endpoint validation failed: ${message}\n`);
    process.exit(1);
  }

  await updateProfileLlmDefault(fichaDir, {
    provider: "custom",
    modelId: modelId.trim(),
    baseUrl: baseUrl.trim(),
  });

  process.stdout.write(
    `\nSaved custom / ${modelId.trim()} (${baseUrl.trim()}) to ${fichaDir}/profile.yaml.\n` +
      `No credential written — custom endpoints typically handle auth at the endpoint level.\n` +
      `Run: pnpm --filter @zia/agent-runtime tui ${fichaArg}\n`,
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
