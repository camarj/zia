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
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ApprovalQueue,
  ApprovalSerializer,
  JsonlAuditLog,
  PolicyClassifier,
  type AuditLog,
  type WrappableTool,
  wrapToolsWithApproval,
} from "@zia/callbacks";
import { findProvider, isOAuthProvider, readFichaLlm, resolveModelFromFicha } from "@zia/providers";

import { buildPromptFromFicha } from "./prompt-builder.ts";
import {
  applyCacheRetention,
  assessCacheEligibility,
  DEFAULT_CACHE_RETENTION,
  type CacheEligibility,
  type CacheRetention,
} from "./cache.ts";

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
  /**
   * Optional audit-log backend. Defaults to JsonlAuditLog writing to
   * <fichaDir>/audit.jsonl. The composition root (apps/agent-runtime) injects
   * a SqliteAuditLog. Keeping this an interface means @zia/core never depends
   * on @zia/persistence (a pure TUI/cron agent must not pull native SQLite).
   */
  auditLog?: AuditLog;
  /**
   * Optional hook called for every medio/alto tool call before dispatching
   * to the queue. Receives the raw trailing SDK args:
   *   rest[0] = signal (AbortSignal | undefined)
   *   rest[1] = onUpdate (AgentToolUpdateCallback | undefined)
   *   rest[2] = ctx (ExtensionContext)
   *
   * M2 / D8 — channel-agnostic design: the entry point (tui-runner.ts,
   * rpc-runner.ts) provides this hook to bind a resolver at runtime without
   * coupling agent.ts to any channel. The TUI entry point uses it to call
   * resolver.bindUi(ctx.ui) on the first gated call.
   */
  onGatedCtx?: (rest: readonly unknown[]) => void;
  /**
   * Optional SessionManager override (ADR-1, gateway-core).
   *
   * When provided, this instance is passed directly to createAgentSessionRuntime
   * instead of the default SessionManager.create(cwd). GatewayRunner uses this
   * to give each session key its own pi.dev JSONL file, enabling concurrent
   * multi-session operation without tearing down a shared runtime.
   *
   * When absent, createZiaAgent defaults to SessionManager.create(cwd) — the
   * existing behaviour for TUI and cron callers is completely unchanged.
   *
   * @zia/core gains NO gateway or persistence concepts from this field.
   * SessionManager is already imported from the pi.dev SDK.
   */
  sessionManager?: SessionManager;
  /**
   * Optional working directory override (ADR-1, gateway-core).
   *
   * Defaults to process.cwd(). Exposed so callers (e.g. GatewayRunner) can
   * vary the cwd per session without changing the global process cwd.
   * TUI and cron callers that omit this field see no behaviour change.
   */
  cwd?: string;
  /**
   * In-process pi.dev extension factories to load for this agent.
   *
   * Passed straight to the resource loader's `extensionFactories`, which load
   * regardless of `noExtensions: true` — so host extension auto-discovery stays
   * OFF (per-agent isolation) while entry points can still inject their own
   * presentation/behaviour extensions. The TUI entry point uses this to register
   * the zia-branded header (see tui-runner.ts + tui-header-extension.ts).
   *
   * Channel-agnostic: extensions self-guard on `ctx.hasUI`, so TUI-only ones are
   * no-ops in RPC / print modes. Defaults to [] (no extensions).
   */
  extensionFactories?: ExtensionFactory[];
}

export interface ZiaAgentHandle {
  runtime: AgentSessionRuntime;
  /**
   * The live approval queue for this agent.
   *
   * Exposed so entry points (tui-runner.ts, rpc-runner.ts) can bind a resolver
   * or check pending approvals without requiring a new createZiaAgent call.
   *
   * M2 / D7 / D8: the queue starts with null resolver (fail-closed — loud error,
   * not silent noOp). The entry point MUST call queue.setResolver() to bind a
   * concrete resolver before gated tool calls can be approved. Until bound, every
   * gated call returns a clear "No approval channel attached" error result.
   */
  queue: ApprovalQueue;
  /**
   * Prompt-caching state for this agent (F-CORE-7).
   *
   * `retention` is the TTL applied to pi.dev's PI_CACHE_RETENTION lever;
   * `eligibility` reports whether the frozen system prompt will actually benefit
   * from Anthropic prompt caching. Exposed so the /status control command and
   * tests can surface cache configuration without driving a live turn.
   */
  cache: {
    retention: CacheRetention;
    eligibility: CacheEligibility;
  };
}

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export async function createZiaAgent(opts: CreateZiaAgentOptions): Promise<ZiaAgentHandle> {
  // Read ficha declaration first so we can register the credential against
  // pi.dev's AuthStorage before any session is created.
  const declaration = await readFichaLlm(opts.fichaDir);
  const model = await resolveModelFromFicha(opts.fichaDir, process.env);

  // The system prompt is built ONCE here and captured by the
  // systemPromptOverride closure below. That freeze is deliberate (F-CORE-7 +
  // Block 2 frozen-snapshot, ADR-M7): the stable prefix must be byte-identical
  // across every turn or Anthropic's auto-placed cache_control breakpoint misses.
  // Mid-session memory writes hit disk but are not re-read until the next session.
  const systemPrompt = await buildPromptFromFicha(opts.fichaDir);

  // F-CORE-7 prompt caching: pi.dev auto-applies the Anthropic cache_control
  // breakpoint; zia configures the TTL lever (validated upstream in the ficha
  // schema) and validates that the frozen prompt is actually cache-eligible.
  const cacheRetention: CacheRetention =
    declaration.cacheRetention ?? DEFAULT_CACHE_RETENTION;
  applyCacheRetention(cacheRetention);
  const cacheEligibility = assessCacheEligibility(declaration.provider, systemPrompt);

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
  // M2 / D8 — channel-agnostic: createZiaAgent does NOT instantiate or bind any
  // concrete resolver. The queue starts with null (fail-closed, D7). The entry
  // point (tui-runner.ts, rpc-runner.ts) calls queue.setResolver() with the
  // appropriate resolver for its channel. Until bound, every gated call returns
  // a loud "No approval channel attached" error result — it never silently
  // auto-approves.
  //
  // Wiring sequence:
  //   1. Build PolicyClassifier from POLICIES.md in fichaDir.
  //   2. Build ApprovalSerializer (concurrency mutex).
  //   3. Build ApprovalQueue with null resolver → fail-closed (D7).
  //   4. Build JsonlAuditLog writing to <fichaDir>/audit.jsonl.
  //   5. Wrap rawTools with wrapToolsWithApproval + the caller-supplied onGatedCtx.
  // ---------------------------------------------------------------------------
  const classifier = await PolicyClassifier.fromFichaDir(opts.fichaDir);
  const serializer = new ApprovalSerializer();
  // Start with null resolver — fail-closed (D7). Entry point must bind a resolver.
  const queue = new ApprovalQueue(null, serializer);

  const auditLog = opts.auditLog ?? new JsonlAuditLog(join(opts.fichaDir, "audit.jsonl"));

  const rawTools: WrappableTool[] = opts.rawTools ?? [];

  const gatedTools = wrapToolsWithApproval(rawTools, {
    classifier,
    queue,
    auditLog,
    onGatedCtx: opts.onGatedCtx,
  });

  const cwd = opts.cwd ?? process.cwd();
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
        // Inline, in-process extensions (e.g. the zia header). These load even
        // with noExtensions: true — that flag only suppresses on-disk host
        // discovery, never the explicit factories passed here.
        extensionFactories: opts.extensionFactories ?? [],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel,
        // F-CORE-1 fix: suppress pi.dev's native builtins (read/bash/edit/write —
        // they are coding-agent tools that would BYPASS the governance gate),
        // while keeping our gate-wrapped customTools active. `tools: []` does NOT
        // do this: an empty array is a truthy allowlist of zero tools, so pi.dev
        // filters out EVERYTHING including customTools — the model then receives an
        // empty tools array in the request and emits no tool calls. `noTools:
        // "builtin"` is the documented option that drops only the native builtins
        // and leaves extension/custom tools enabled (pi.dev docs/sdk.md).
        noTools: "builtin",
        // AQ-12: customTools receives ONLY the gate-wrapped array.
        // The raw tool array (rawTools) is NEVER assigned here directly.
        //
        // Cast: WrappableTool is a minimal structural subset of ToolDefinition.
        // label and details are now required on both sides (M1 fix), so the
        // structural gap is narrowed to: ToolDefinition uses typed generics
        // (TParams, TDetails) while WrappableTool uses unknown/Record<string,unknown>.
        // The cast is safe at runtime — pi.dev reads exactly the fields WrappableTool
        // provides. A full assignability cast is not possible without importing the
        // SDK's TSchema into the gate core (which would break SDK-free testability).
        customTools: gatedTools as unknown as ToolDefinition[],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: opts.sessionManager ?? SessionManager.create(cwd),
  });

  return {
    runtime,
    queue,
    cache: { retention: cacheRetention, eligibility: cacheEligibility },
  };
}
