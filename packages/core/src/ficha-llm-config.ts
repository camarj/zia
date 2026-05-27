import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface FichaLlmConfig {
  provider: string;
  modelId: string;
  credentialsEnv: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
}

// Default env var name per provider key. Phase 0 covers the common ones; the
// full catalog (and override via profile.yaml.llm.default.credentials_env)
// lands with sdd/llm-provider-cli.
const DEFAULT_CREDENTIAL_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export async function loadFichaLlmConfig(fichaDir: string): Promise<FichaLlmConfig> {
  const profilePath = join(fichaDir, "profile.yaml");
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (cause) {
    throw new Error(`zia: cannot read ${profilePath}`, { cause });
  }

  const doc = parse(raw) as unknown;
  const def = (doc as { llm?: { default?: unknown } })?.llm?.default;
  if (!def || typeof def !== "object") {
    throw new Error(
      `zia: ${profilePath} is missing llm.default. Declare provider, model, and (optionally) credentials_env.`,
    );
  }
  const block = def as Record<string, unknown>;
  const provider = block.provider;
  const modelId = block.model;
  if (typeof provider !== "string" || typeof modelId !== "string") {
    throw new Error(
      `zia: ${profilePath} llm.default must declare string fields provider and model.`,
    );
  }

  const credentialsEnv =
    typeof block.credentials_env === "string"
      ? block.credentials_env
      : DEFAULT_CREDENTIAL_ENV[provider];
  if (!credentialsEnv) {
    throw new Error(
      `zia: cannot infer credentials env var for provider "${provider}". Add llm.default.credentials_env to ${profilePath}.`,
    );
  }

  const rawThinking = block.thinkingLevel;
  const thinkingLevel =
    rawThinking === "off" ||
    rawThinking === "low" ||
    rawThinking === "medium" ||
    rawThinking === "high"
      ? rawThinking
      : undefined;

  return { provider, modelId, credentialsEnv, thinkingLevel };
}
