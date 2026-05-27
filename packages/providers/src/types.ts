import type { KnownProvider, Model } from "@earendil-works/pi-ai";

export type ProviderType = "api-key" | "oauth" | "custom";

export type OAuthHelper = "github-copilot" | "openai-codex";

export interface Provider {
  /** pi.dev provider key (e.g. "anthropic", "openai"). Type is `string` because
   * the catalog also includes the "custom" sentinel that is NOT a KnownProvider. */
  key: string;
  /** Human-friendly label used by the future `zia model` picker. */
  label: string;
  type: ProviderType;
  /** Default env-var name for api-key providers (e.g. "OPENAI_API_KEY"). */
  credentialEnv?: string;
  /** Identifier for the pi.dev OAuth helper to invoke. */
  oauthHelper?: OAuthHelper;
  /** Curated default models that the future `zia model` picker will surface first. */
  defaultModels: readonly string[];
}

export type ResolvedThinkingLevel = "off" | "low" | "medium" | "high";

/** Raw YAML shape after parsing `profile.yaml.llm.default`. Credential env-var
 * is optional here — the resolver fills it in from the catalog when absent. */
export interface FichaLlmDeclaration {
  provider: string;
  modelId: string;
  baseUrl?: string;
  credentialEnv?: string;
  thinkingLevel?: ResolvedThinkingLevel;
}

/** Re-exported for downstream consumers building Model objects against the
 * catalog's known providers. */
export type { KnownProvider, Model };
