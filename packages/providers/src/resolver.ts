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
 * as a single-entry fallback), with the pi.dev Model and thinkingLevel.
 *
 * S-1 decision (PR3): `label` and `modelId` are added here so PR4's
 * `ControlCommandsExtensionOpts.availableModels` can consume them directly
 * without re-deriving from `model.id`. The addition is strictly additive —
 * the spec contract (SPEC-MODELS-1) only mandates `{model, thinkingLevel?}`,
 * and extra fields on a return type are always backward-compatible.
 */
export type ResolvedModelEntry = {
  model: Model<any>;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Human-friendly label from llm.available[].label (undefined for the
   * single-entry fallback when no llm.available is declared). */
  label?: string;
  /** Model identifier string (mirrors FichaModelEntry.modelId). For the
   * single-entry fallback this is derived from the resolved model's id. */
  modelId: string;
  /** The credentials_env var name from the ficha available[] entry, if declared.
   * Used by createFallbackController to surface actionable skip warnings when
   * session.setModel() throws for an unauthenticated candidate (SPEC-FB-9). */
  credentialEnv?: string;
};

/**
 * Resolve all models declared in `llm.available[]` from the ficha into pi.dev
 * {@link Model} objects, registering API-key credentials into `authStorage`
 * on a **best-effort / lazy** basis.
 *
 * Alignment with Hermes §7 + pi.dev multi-model:
 * - Hermes: resolves credentials for the ACTIVE provider only; fallback_providers
 *   are walked on failure, not pre-authenticated at startup.
 * - pi.dev: `scopedModels = available.map(m => ({ model: getModel(...) }))`.
 *   `getModel()` builds a descriptor only — auth is resolved when the model
 *   is actually used via `session.setModel()`.
 *
 * Contract:
 * - Reads `FichaProfile.llm.available[]`; if absent or empty, returns a
 *   single-entry array with the default model (SPEC-MODELS-1-C / EC-11).
 *   The single-entry fallback is LAZY too: no throw here — the ACTIVE model's
 *   strict auth is enforced in `agent.ts` before this function is called.
 * - For each `available[]` entry, calls `resolveEntryToModel(entry)` to get
 *   the pi.dev descriptor.
 * - Auth registration is **best-effort** (lazy):
 *   - api-key entry whose env var IS present → `setRuntimeApiKey` (seamless switch).
 *   - api-key entry whose env var is MISSING → skip silently (no throw). Auth is
 *     resolved at switch time; if the key is absent then, pi.dev returns false
 *     from `setModel()` and the /model command surfaces a clear error (EC-7).
 *   - OAuth entry whose `hasAuth()` IS true → fine (token ready).
 *   - OAuth entry whose `hasAuth()` IS false → skip silently (no throw). Menu
 *     entry remains; switch may fail at use time — that is the correct behavior.
 *   - Custom/self-hosted (no credentialEnv, not OAuth) → nothing (SPEC-MODELS-1-D).
 * - Returns the resolved array in the SAME ORDER as `llm.available[]`.
 * - NEVER throws `ZiaConfigError` for missing credentials in the `available[]`
 *   loop. That strictness lives in `agent.ts` for the ACTIVE (default) model only.
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

  // SPEC-MODELS-1-C / EC-11: absent or empty available[] → single-entry fallback.
  // Lazy: no auth check here — the ACTIVE model's credential is verified strictly
  // in agent.ts before this call (restored active-model auth block).
  if (!available || available.length === 0) {
    const declaration = await readFichaLlm(fichaDir);
    // Best-effort credential registration for the default model (W-1):
    // register the api-key into authStorage if the env var is present so that
    // explicit registration is honored (pi.dev's getApiKey priority-1 over env).
    // We do NOT throw here — agent.ts enforces the strict check.
    if (!isOAuthProvider(declaration.provider) && declaration.provider !== "custom") {
      const credentialEnv =
        declaration.credentialEnv ?? findProvider(declaration.provider)?.credentialEnv;
      const value = credentialEnv ? env[credentialEnv] : undefined;
      if (credentialEnv && value) {
        authStorage.setRuntimeApiKey(declaration.provider, value);
      }
    }
    const defaultModel = await resolveModelFromFicha(fichaDir, env);
    return [{
      model: defaultModel,
      thinkingLevel: declaration.thinkingLevel,
      modelId: declaration.modelId,
      label: undefined,
    }];
  }

  // available[] present — build the menu (lazy auth, no throws).
  const results: ResolvedModelEntry[] = [];

  for (const entry of available) {
    const model = resolveEntryToModel(entry);

    // Best-effort credential registration: register the key IF present so that
    // switching to this model is seamless. If absent — skip silently. The active
    // model's key was already verified strictly in agent.ts.
    if (entry.credentialEnv) {
      const key = env[entry.credentialEnv];
      if (key) {
        // Key is present — register for seamless switch.
        authStorage.setRuntimeApiKey(entry.provider, key);
      }
      // Key absent — skip. Switch to this model will fail at use time (EC-7).
    }
    // OAuth providers (no credentialEnv): if hasAuth is true, token is ready.
    // If false — skip silently. Same lazy-at-use semantics.
    // Custom/self-hosted (no credentialEnv, not OAuth): no auth (SPEC-MODELS-1-D).

    results.push({
      model,
      thinkingLevel: entry.thinkingLevel,
      label: entry.label,
      modelId: entry.modelId,
      credentialEnv: entry.credentialEnv,
    });
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
