import { join } from "node:path";

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
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ApprovalQueue,
  ApprovalSerializer,
  JsonlAuditLog,
  PolicyClassifier,
  TuiApprovalResolver,
  type WrappableTool,
  wrapToolsWithApproval,
} from "@zia/callbacks";
import { findProvider, isOAuthProvider, readFichaLlm, resolveModelFromFicha } from "@zia/providers";

import { buildPromptFromFicha } from "./prompt-builder.ts";

type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface CreateZiaAgentOptions {
  fichaDir: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Raw tools to expose to the agent. Every tool is wrapped through
   * wrapToolsWithApproval before being passed to pi.dev — no raw tool ever
   * reaches the LLM without passing the governance gate (AQ-12).
   *
   * Default: [] (no tools). Callers add tools here; the gate is always active
   * regardless of the number of tools.
   */
  rawTools?: WrappableTool[];
}

export interface ZiaAgentHandle {
  runtime: AgentSessionRuntime;
  /**
   * The live approval queue for this agent.
   * Exposed so entry points (tui-runner.ts, rpc-runner.ts) can swap resolvers
   * or check pending approvals without requiring a new createZiaAgent call.
   */
  queue: ApprovalQueue;
  /**
   * The TUI-specific resolver bound to the queue.
   * tui-runner.ts calls resolver.bindUi(ctx.ui) via the onGatedCtx hook
   * on the first medio/alto tool call — not at startup — because ctx.ui is
   * only available inside InteractiveMode's tool dispatch (D8, SPIKE AMB-1).
   */
  tuiResolver: TuiApprovalResolver;
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

  // ---------------------------------------------------------------------------
  // Governance gate composition (AQ-12, design §agent.ts wiring)
  //
  // Every tool reaches pi.dev only after passing through wrapToolsWithApproval.
  // No raw tool array is ever assigned directly to customTools — that would
  // bypass the gate (AQ-12 structural requirement, design D1).
  //
  // Wiring sequence:
  //   1. Build PolicyClassifier from POLICIES.md in fichaDir.
  //   2. Build ApprovalSerializer (concurrency mutex).
  //   3. Build ApprovalQueue with null resolver → fail-closed (D7) until bound.
  //   4. Build TuiApprovalResolver (queue-only, no ui yet — D8, SPIKE AMB-1).
  //      ctx.ui is only available inside InteractiveMode tool dispatch; the
  //      resolver binds it lazily via bindUi() called from the onGatedCtx hook.
  //   5. Immediately bind the TUI resolver onto the queue so gated calls route
  //      to it (not to the null-resolver fail-closed path).
  //   6. Build JsonlAuditLog writing to <fichaDir>/audit.jsonl.
  //   7. Wrap rawTools with wrapToolsWithApproval + the onGatedCtx hook.
  // ---------------------------------------------------------------------------
  const classifier = await PolicyClassifier.fromFichaDir(opts.fichaDir);
  const serializer = new ApprovalSerializer();
  // Start with null resolver so no approval can sneak through before binding (D7).
  const queue = new ApprovalQueue(null, serializer);
  // TUI resolver: queue is bound now; ui binding happens lazily on first gated call.
  const tuiResolver = new TuiApprovalResolver({ queue });
  // Now bind the resolver — gated calls will route to tuiResolver.resolve().
  queue.setResolver(tuiResolver);

  const auditLog = new JsonlAuditLog(join(opts.fichaDir, "audit.jsonl"));

  const rawTools: WrappableTool[] = opts.rawTools ?? [];

  // Hook: when a gated tool call arrives, extract ctx.ui from rest[2] (the
  // ExtensionContext arg in pi.dev's execute signature) and bind it to the
  // tuiResolver so the TUI confirm dialog becomes available (D8, SPIKE AMB-1).
  // rest layout per SDK: rest[0]=signal, rest[1]=onUpdate, rest[2]=ctx.
  const onGatedCtx = (rest: readonly unknown[]): void => {
    const ctx = rest[2];
    if (ctx !== null && typeof ctx === "object" && "ui" in ctx) {
      tuiResolver.bindUi((ctx as ExtensionContext).ui);
    }
  };

  const gatedTools = wrapToolsWithApproval(rawTools, {
    classifier,
    queue,
    auditLog,
    onGatedCtx,
  });

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
        // AQ-12: customTools receives ONLY the gate-wrapped array.
        // The raw tool array (rawTools) is NEVER assigned here directly.
        //
        // Cast: WrappableTool is a minimal structural subset of ToolDefinition
        // (label is optional in WrappableTool, required in ToolDefinition).
        // The cast is safe at runtime — pi.dev only reads the fields that
        // WrappableTool provides; label falls back to name when undefined.
        customTools: gatedTools as unknown as ToolDefinition[],
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

  return { runtime, queue, tuiResolver };
}
