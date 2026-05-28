import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { findProvider, isOAuthProvider, readFichaLlm, resolveModelFromFicha } from "@zia/providers";

import { buildPromptFromFicha } from "./prompt-builder.ts";

type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface CreateZiaAgentOptions {
  fichaDir: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ZiaAgentHandle {
  runtime: AgentSessionRuntime;
}

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export async function createZiaAgent(opts: CreateZiaAgentOptions): Promise<ZiaAgentHandle> {
  // Read ficha declaration first so we can register the credential against
  // pi.dev's AuthStorage before any session is created.
  const declaration = await readFichaLlm(opts.fichaDir);
  const model = await resolveModelFromFicha(opts.fichaDir, process.env);

  const systemPrompt = await buildPromptFromFicha(opts.fichaDir);

  const authStorage = AuthStorage.create();
  if (isOAuthProvider(declaration.provider)) {
    // OAuth providers (github-copilot, openai-codex) keep their credentials in
    // auth.json, loaded automatically by AuthStorage.create(). Fail early with
    // an actionable hint if the user never authenticated — otherwise the error
    // surfaces deep inside the first LLM call as a cryptic "unauthorized".
    if (!authStorage.hasAuth(declaration.provider)) {
      throw new Error(
        `zia: no OAuth credentials found for "${declaration.provider}". ` +
          `Run \`pnpm --filter @zia/agent-runtime model ${opts.fichaDir}\` to authenticate.`,
      );
    }
  } else if (declaration.provider !== "custom") {
    // "custom" endpoints handle auth themselves; everything else is an api-key
    // provider whose key comes from an env var.
    const credentialEnv = declaration.credentialEnv ?? findProvider(declaration.provider)?.credentialEnv;
    const value = credentialEnv ? process.env[credentialEnv] : undefined;
    if (credentialEnv && value) {
      // Cast: the resolver already validated the provider key is in the catalog;
      // AuthStorage.setRuntimeApiKey takes a KnownProvider literal.
      authStorage.setRuntimeApiKey(declaration.provider as never, value);
    }
  }
  const modelRegistry = ModelRegistry.create(authStorage);

  const thinkingLevel = opts.thinkingLevel ?? declaration.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

  const cwd = process.cwd();
  const agentDir = getAgentDir();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: factoryCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: factoryCwd,
      authStorage,
      modelRegistry,
      resourceLoaderOptions: {
        systemPromptOverride: () => systemPrompt,
        appendSystemPromptOverride: () => [],
        // Per zia's per-agent isolation rule: the agent's identity MUST come
        // only from the ficha. Pi.dev's DefaultResourceLoader otherwise reads
        // CLAUDE.md / AGENTS.md / skills / prompt-templates / extensions from
        // the cwd, which leaks Claude Code's developer-facing persona into
        // the agent's system prompt.
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noExtensions: true,
        noThemes: true,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel,
        tools: [],
        customTools: [],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd),
  });

  return { runtime };
}
