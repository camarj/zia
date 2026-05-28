import { getModel } from "@earendil-works/pi-ai";

import { findProvider, providerCatalog } from "./catalog.ts";
import { readFichaLlm } from "./ficha.ts";
import { isOAuthProvider } from "./oauth.ts";
import type { KnownProvider, Model } from "./types.ts";

/**
 * Read `${fichaDir}/profile.yaml`, look up the declared provider in the
 * catalog, and return a ready-to-use pi.dev {@link Model}.
 *
 * For native providers (anthropic, openai, ...) the resolver calls
 * `getModel(provider, modelId)` from `@earendil-works/pi-ai`. For the `custom`
 * sentinel it builds a `Model<'openai-completions'>` with the ficha's
 * `baseUrl` — used for self-hosted endpoints like Ollama, vLLM, LiteLLM.
 *
 * Credential resolution:
 * - api-key providers: env-var name from `credentials_env` override or catalog
 *   default. Throws with a `zia model` remediation hint when the var is unset.
 * - custom provider: no credential required here; the operator handles auth at
 *   the endpoint level.
 * - OAuth providers (github-copilot, openai-codex): credentials are owned by
 *   pi.dev's AuthStorage (persisted to auth.json). The resolver does NOT check
 *   env vars for these providers — AuthStorage.getApiKey() auto-refreshes when
 *   the agent runtime creates its session. See engram #556 for the full
 *   rationale (Option B: delegate OAuth to pi.dev, not .env blobs).
 *
 * @param env - process env (test seam). Defaults to `process.env`.
 */
export async function resolveModelFromFicha(
  fichaDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Model<any>> {
  const declaration = await readFichaLlm(fichaDir);

  if (declaration.provider === "custom") {
    if (!declaration.baseUrl) {
      throw new Error(
        `zia: profile.yaml declares provider "custom" but is missing baseUrl. Add llm.default.baseUrl pointing at your OpenAI-compatible endpoint (e.g. http://localhost:11434/v1).`,
      );
    }
    return buildCustomModel(declaration.modelId, declaration.baseUrl);
  }

  const entry = findProvider(declaration.provider);
  if (!entry) {
    const knownKeys = providerCatalog
      .map((p) => p.key)
      .filter((k) => k !== "custom")
      .join(", ");
    throw new Error(
      `zia: unknown provider "${declaration.provider}" in profile.yaml. Known: ${knownKeys}, custom.`,
    );
  }

  // OAuth providers: credentials live in auth.json managed by pi.dev's
  // AuthStorage. Skip env-var credential check entirely — the agent runtime's
  // AuthStorage.create() will load and auto-refresh the token at session start.
  if (isOAuthProvider(entry.key)) {
    return getModel(entry.key as KnownProvider, declaration.modelId as never);
  }

  const credentialEnv = declaration.credentialEnv ?? entry.credentialEnv;
  if (!credentialEnv) {
    throw new Error(
      `zia: provider "${entry.key}" has no default credential env-var. Add llm.default.credentials_env to profile.yaml.`,
    );
  }

  const credential = env[credentialEnv];
  if (!credential) {
    throw new Error(
      `zia: ${credentialEnv} is not set for provider "${entry.key}". Run \`zia model\` to configure credentials, or set the env var in agents/<name>/.env.`,
    );
  }

  // pi-ai's getModel is generic over literal types. The ficha declares the
  // provider as a free-form string; we trust the catalog match means the key
  // is a valid `KnownProvider`. Same trust applies to `modelId` — it must
  // exist in pi-ai's MODELS table for the chosen provider, otherwise pi-ai
  // throws at call time.
  return getModel(entry.key as KnownProvider, declaration.modelId as never);
}

function buildCustomModel(modelId: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: `${modelId} (custom)`,
    api: "openai-completions",
    provider: "custom",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  } as Model<"openai-completions">;
}
