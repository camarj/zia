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
import { getModel, type KnownProvider } from "@earendil-works/pi-ai";

import { loadFichaLlmConfig } from "./ficha-llm-config.ts";
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
  const llm = await loadFichaLlmConfig(opts.fichaDir);
  const apiKey = process.env[llm.credentialsEnv];
  if (!apiKey) {
    throw new Error(
      `zia: ${llm.credentialsEnv} is not set. Add it to .env at the repo root before launching the TUI.`,
    );
  }

  const systemPrompt = await buildPromptFromFicha(opts.fichaDir);

  const authStorage = AuthStorage.create();
  // TODO(sdd:llm-provider-cli): replace these casts with a typed catalog lookup.
  // pi-ai's getModel constrains both args to literal types; until the catalog
  // lands, we trust profile.yaml to declare valid provider/model strings.
  authStorage.setRuntimeApiKey(llm.provider as KnownProvider, apiKey);
  const modelRegistry = ModelRegistry.create(authStorage);

  const model = getModel(llm.provider as KnownProvider, llm.modelId as never);
  const thinkingLevel = opts.thinkingLevel ?? llm.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

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
