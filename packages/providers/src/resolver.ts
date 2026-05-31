import { getModel } from "@earendil-works/pi-ai";

import { findProvider, providerCatalog } from "./catalog.ts";
import { readFichaLlm, readFichaProfile } from "./ficha.ts";
import { isOAuthProvider } from "./oauth.ts";
import type { FichaModelEntry } from "./ficha.ts";
import type { KnownProvider, Model } from "./types.ts";

// ---------------------------------------------------------------------------
// AuthStorageLike — structural interface (SPEC-MODELS-1 / INV-1)
//
// @zia/providers must NOT import @earendil-works/pi-coding-agent. Instead we
// declare the minimal shape of AuthStorage that resolveAvailableModels needs.
// AuthStorage from pi.dev satisfies this structurally at the call site in
// @zia/core/agent.ts.
// ---------------------------------------------------------------------------

export interface AuthStorageLike {
  setRuntimeApiKey(provider: string, key: string): void;
  hasAuth(provider: string): boolean;
}

// ---------------------------------------------------------------------------
// ZiaConfigError — structured error for actionable config failures (SPEC-MODELS-1-B)
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link resolveAvailableModels} when a required credential env-var
 * is missing for a provider that needs an API key. The message always names
 * the provider and the env-var so the operator knows exactly what to set.
 */
export class ZiaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZiaConfigError";
  }
}

// ---------------------------------------------------------------------------
// resolveModelFromFicha — existing export, UNCHANGED
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// resolveAvailableModels — NEW (SPEC-MODELS-1, PR1)
// ---------------------------------------------------------------------------

/** Return type: one entry per llm.available[] entry (or the default model
 * as a single-entry fallback), with the pi.dev Model and thinkingLevel. */
export type ResolvedModelEntry = {
  model: Model<any>;
  thinkingLevel?: "off" | "low" | "medium" | "high";
};

/**
 * Resolve all models declared in `llm.available[]` from the ficha into pi.dev
 * {@link Model} objects, registering API-key credentials into `authStorage`.
 *
 * Contract (SPEC-MODELS-1):
 * - Reads `FichaProfile.llm.available[]`; if absent or empty, falls back to
 *   `[{ model: defaultModel, thinkingLevel: defaultThinkingLevel }]` — same
 *   result as pre-PR1 single-model behaviour (SPEC-MODELS-1-C / EC-11).
 * - For each entry, calls `getModel(provider, modelId)` and registers
 *   `env[credentialEnv]` into `authStorage.setRuntimeApiKey(provider, key)`
 *   when `credentialEnv` is present and the env var is set.
 * - If `credentialEnv` is present but the env var is NOT set → throws
 *   {@link ZiaConfigError} with an actionable message naming provider + var
 *   (SPEC-MODELS-1-B).
 * - Custom/self-hosted providers (no `credentialEnv`): resolved without any
 *   auth registration (SPEC-MODELS-1-D).
 * - OAuth providers (no `credentialEnv`): resolved without env-var check;
 *   pi.dev's AuthStorage handles their token at session start.
 * - Returns the resolved array in the same order as `llm.available[]`
 *   (first entry = default model for session start).
 *
 * @param fichaDir  - path to the agent ficha directory
 * @param env       - process.env or test seam
 * @param authStorage - pi.dev AuthStorage (or compatible mock) to register keys into
 */
export async function resolveAvailableModels(
  fichaDir: string,
  env: NodeJS.ProcessEnv,
  authStorage: AuthStorageLike,
): Promise<ResolvedModelEntry[]> {
  const profile = await readFichaProfile(fichaDir);
  const available = profile.llm?.available;

  // SPEC-MODELS-1-C / EC-11: absent or empty available[] → single-entry fallback
  if (!available || available.length === 0) {
    const defaultModel = await resolveModelFromFicha(fichaDir, env);
    const declaration = await readFichaLlm(fichaDir);
    return [{ model: defaultModel, thinkingLevel: declaration.thinkingLevel }];
  }

  const results: ResolvedModelEntry[] = [];

  for (const entry of available) {
    const model = resolveEntryToModel(entry);

    // Register credential into authStorage when a credentialEnv is declared.
    if (entry.credentialEnv) {
      const key = env[entry.credentialEnv];
      if (!key) {
        // SPEC-MODELS-1-B: missing env var → ZiaConfigError with actionable msg
        throw new ZiaConfigError(
          `zia: credential env var "${entry.credentialEnv}" is not set for provider "${entry.provider}". ` +
            `Set ${entry.credentialEnv} in the agent's .env file or container environment.`,
        );
      }
      authStorage.setRuntimeApiKey(entry.provider, key);
    }
    // Custom providers (no credentialEnv) and OAuth providers are skipped —
    // custom endpoints handle auth at the endpoint level (SPEC-MODELS-1-D);
    // OAuth tokens are in pi.dev's auth.json, not env vars.

    results.push({ model, thinkingLevel: entry.thinkingLevel });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a pi.dev Model object from a single FichaModelEntry.
 * For the `custom` sentinel, builds a Model<'openai-completions'> using the
 * entry's baseUrl (defaults to empty string if absent — callers should validate).
 */
function resolveEntryToModel(entry: FichaModelEntry): Model<any> {
  if (entry.provider === "custom") {
    return buildCustomModel(entry.modelId, entry.baseUrl ?? "");
  }
  // For all catalog providers (api-key and OAuth alike), delegate to pi-ai.
  // The `provider` string is trusted — invalid providers cause pi-ai to throw
  // at call time with a clear "unknown model" message.
  return getModel(entry.provider as KnownProvider, entry.modelId as never);
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
