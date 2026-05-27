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
import { getModel } from "@earendil-works/pi-ai";

import { buildPromptFromFicha } from "./prompt-builder.ts";

type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface CreateZiaAgentOptions {
  fichaDir: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ZiaAgentHandle {
  runtime: AgentSessionRuntime;
}

const ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

// Phase 0 ships with a fixed provider+model. Dynamic provider/model selection
// (multi-provider, custom endpoints, OAuth) lands in sdd/llm-provider-cli.
const FIXED_MODEL = getModel("anthropic", "claude-sonnet-4-6");

export async function createZiaAgent(opts: CreateZiaAgentOptions): Promise<ZiaAgentHandle> {
  const apiKey = process.env[ANTHROPIC_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `zia: ${ANTHROPIC_KEY_ENV} is not set. Add it to .env at the repo root before launching the TUI.`,
    );
  }

  const systemPrompt = await buildPromptFromFicha(opts.fichaDir);

  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("anthropic", apiKey);
  const modelRegistry = ModelRegistry.create(authStorage);

  const thinkingLevel = opts.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

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
        model: FIXED_MODEL,
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
