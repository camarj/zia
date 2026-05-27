import type { Provider } from "./types.ts";

/**
 * Curated subset of pi.dev's native providers + a `custom` sentinel for
 * self-hosted OpenAI-compatible endpoints. Each entry maps a provider key to
 * a default credential env-var name (or an OAuth helper for OAuth providers).
 *
 * Adding a new provider: ensure the `key` matches pi.dev's `KnownProvider`
 * union exactly (see `@earendil-works/pi-ai/dist/types.d.ts`). Otherwise the
 * `resolver` will throw at runtime when calling `getModel(key, ...)`.
 *
 * The `custom` entry intentionally has no `credentialEnv` — its credential
 * (if any) is configured per-endpoint in the ficha, since baseUrls vary.
 */
export const providerCatalog: readonly Provider[] = [
  {
    key: "anthropic",
    label: "Anthropic Claude",
    type: "api-key",
    credentialEnv: "ANTHROPIC_API_KEY",
    defaultModels: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
  },
  {
    key: "openai",
    label: "OpenAI",
    type: "api-key",
    credentialEnv: "OPENAI_API_KEY",
    defaultModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1"],
  },
  {
    key: "google",
    label: "Google Gemini",
    type: "api-key",
    credentialEnv: "GEMINI_API_KEY",
    defaultModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    type: "api-key",
    credentialEnv: "DEEPSEEK_API_KEY",
    defaultModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    key: "groq",
    label: "Groq",
    type: "api-key",
    credentialEnv: "GROQ_API_KEY",
    defaultModels: ["llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct"],
  },
  {
    key: "xai",
    label: "xAI Grok",
    type: "api-key",
    credentialEnv: "XAI_API_KEY",
    defaultModels: ["grok-3", "grok-3-fast"],
  },
  {
    key: "together",
    label: "Together AI",
    type: "api-key",
    credentialEnv: "TOGETHER_API_KEY",
    defaultModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  {
    key: "openrouter",
    label: "OpenRouter (multi-provider aggregator)",
    type: "api-key",
    credentialEnv: "OPENROUTER_API_KEY",
    defaultModels: ["anthropic/claude-sonnet-4.6", "openai/gpt-4o-mini"],
  },
  {
    key: "mistral",
    label: "Mistral",
    type: "api-key",
    credentialEnv: "MISTRAL_API_KEY",
    defaultModels: ["mistral-large-latest", "mistral-small-latest"],
  },
  {
    key: "opencode-go",
    label: "OpenCode Go",
    type: "api-key",
    credentialEnv: "OPENCODE_GO_API_KEY",
    defaultModels: [],
  },
  {
    key: "amazon-bedrock",
    label: "Amazon Bedrock",
    type: "api-key",
    credentialEnv: "AWS_ACCESS_KEY_ID",
    defaultModels: ["anthropic.claude-sonnet-4-6", "anthropic.claude-opus-4-7"],
  },
  {
    key: "github-copilot",
    label: "GitHub Copilot (OAuth)",
    type: "oauth",
    oauthHelper: "github-copilot",
    defaultModels: ["claude-sonnet-4.5", "gpt-4o"],
  },
  {
    key: "openai-codex",
    label: "OpenAI Codex (OAuth — ChatGPT Plus/Pro)",
    type: "oauth",
    oauthHelper: "openai-codex",
    defaultModels: ["codex-mini-latest"],
  },
  {
    key: "custom",
    label: "Custom OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, ...)",
    type: "custom",
    defaultModels: [],
  },
];

/** Lookup by key. Returns `undefined` for unknown providers (caller surfaces
 * the error with the right message). */
export function findProvider(key: string): Provider | undefined {
  return providerCatalog.find((p) => p.key === key);
}
