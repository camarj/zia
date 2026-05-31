import { basename, join } from "node:path";

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
import {
  findProvider,
  isOAuthProvider,
  readFichaLlm,
  readFichaProfile,
  resolveAvailableModels,
  resolveModelFromFicha,
  ZiaConfigError,
  type ResolvedModelEntry,
} from "@zia/providers";

import { buildPromptFromFicha } from "./prompt-builder.ts";
import {
  applyCacheRetention,
  assessCacheEligibility,
  DEFAULT_CACHE_RETENTION,
  type CacheEligibility,
  type CacheRetention,
} from "./cache.ts";
import {
  createBudgetEnforcementExtension,
  type MonthlySpendStore,
} from "./budget-extension.ts";

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
  /**
   * Optional monthly spend store for budget enforcement (F-CORE-8, SPEC-BUDGET-5).
   *
   * When provided AND ficha.llm.monthly_budget_usd > 0, the budget enforcement
   * extension is injected. When absent or when budget is absent/zero in the ficha,
   * no budget extension is added (feature OFF — no accumulation, no gate).
   *
   * The instance is created at the composition root (apps/agent-runtime) from the
   * same SQLite db handle used for SqliteAuditLog — @zia/core never imports
   * @zia/persistence (INV-1). MonthlySpendStore is a structural interface declared
   * in budget-extension.ts; SqliteMonthlySpendStore satisfies it structurally.
   */
  monthlySpendStore?: MonthlySpendStore;
}

export interface ZiaAgentHandle {
  runtime: AgentSessionRuntime;
  /**
   * Resolved models from llm.available[] (or the single-entry fallback when
   * llm.available is absent). Populated by resolveAvailableModels() before
   * the session runtime is created, so every model is pre-authenticated.
   *
   * Passed to the pi.dev session as `scopedModels`, enabling:
   *  - Ctrl+P cycling in TUI mode
   *  - RPC set_model / cycle_model commands
   *  - PR4's /model slash command (reads this array for the picker list)
   *
   * SPEC-SCOPED-1: readonly — callers inspect but never mutate this array.
   */
  readonly scopedModels: ReadonlyArray<ResolvedModelEntry>;
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

  // ---------------------------------------------------------------------------
  // ACTIVE MODEL AUTH (strict) — Hermes §7 + pi.dev multi-model realignment.
  //
  // The ACTIVE (boot) model comes from `llm.default`. Its credential is verified
  // strictly here before any session is created. This mirrors Hermes:
  //   "resolution precedence: explicit→config→env→defaults; saved choice is
  //    source of truth" — the default IS the active choice at startup.
  //
  // Three cases:
  //  1. OAuth provider (e.g. github-copilot): check hasAuth; throw ZiaConfigError
  //     with a `pnpm --filter @zia/agent-runtime model <fichaDir>` hint if not authed.
  //  2. api-key provider: resolve credentialEnv from declaration or catalog default;
  //     setRuntimeApiKey when the key is present. resolveModelFromFicha (called via
  //     resolveAvailableModels fallback path) already throws if the key is absent —
  //     so auth registration here is best-effort supplemental; the throw from
  //     resolveModelFromFicha is the enforced failure for missing api-key.
  //  3. custom provider: no auth required (endpoint-level auth at the caller).
  //
  // NOTE: resolveAvailableModels (the menu resolver below) is LAZY — it never
  // throws for missing credentials in llm.available[]. All strict checks are here.
  // ---------------------------------------------------------------------------
  if (isOAuthProvider(declaration.provider)) {
    // OAuth: credentials live in auth.json managed by pi.dev's AuthStorage.
    // AuthStorage.create() loads the token from getAgentDir()/auth.json — check
    // now before proceeding, so the error is surfaced at startup, not mid-session.
    if (!authStorage.hasAuth(declaration.provider)) {
      throw new ZiaConfigError(
        `zia: provider "${declaration.provider}" needs an OAuth login but no credentials were found. ` +
          `Run \`pnpm --filter @zia/agent-runtime model ${opts.fichaDir}\` to authenticate.`,
      );
    }
  } else if (declaration.provider !== "custom") {
    // api-key provider: resolve the env var name and register the key.
    // resolveModelFromFicha (called below) already throws when the key is unset,
    // so we only need to register it here when present (best-effort supplemental).
    const entry = findProvider(declaration.provider);
    const credentialEnv = declaration.credentialEnv ?? entry?.credentialEnv;
    if (credentialEnv) {
      const key = process.env[credentialEnv];
      if (key) {
        authStorage.setRuntimeApiKey(declaration.provider, key);
      }
      // key absent → resolveModelFromFicha below throws with the actionable message.
    }
  }

  // ---------------------------------------------------------------------------
  // F-CORE-9: resolve the switch MENU (llm.available[]) — LAZY auth.
  //
  // resolveAvailableModels builds descriptors for ALL available[] entries and
  // registers credentials ONLY for entries whose env var is PRESENT (best-effort).
  // It NEVER throws for missing keys in the available[] loop — that strictness
  // belongs to the active-model block above.
  //
  // Handles:
  //  - Best-effort credential registration for api-key entries with present keys
  //  - Single-entry fallback when llm.available is absent/empty (SPEC-MODELS-1-C)
  //  - Custom/ollama entries (no credentialEnv) pass through without auth
  //
  // The session BOOTS with `llm.default` (the active model), not available[0].
  // resolvedModels[0] is used here only as the fallback when available[] is absent.
  // ---------------------------------------------------------------------------
  const resolvedModels: ResolvedModelEntry[] = await resolveAvailableModels(
    opts.fichaDir,
    process.env,
    authStorage,
  );

  // Resolve the ACTIVE (boot) model from llm.default — strictly. This call
  // throws when the api-key is absent, naming the env var (the auth block above
  // already registered the key when present, so this is a no-double-work read).
  const activeModel = await resolveModelFromFicha(opts.fichaDir, process.env);
  const model = activeModel;
  const thinkingLevel = opts.thinkingLevel ?? declaration.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

  const modelRegistry = ModelRegistry.create(authStorage);

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

  // ---------------------------------------------------------------------------
  // F-CORE-8: resolve agentId and budget enforcement extension
  //
  // agentId comes from profile.yaml `agent.id`. When absent, we derive a slug
  // from path.basename(fichaDir) and emit a startup warning (SPEC-BUDGET-6).
  //
  // readFichaProfile reads the same file as readFichaLlm above. The slight
  // redundancy is intentional — readFichaLlm is the strict default-model reader;
  // readFichaProfile is the full profile reader. Combining them into one call
  // would require refactoring the existing readFichaLlm contract.
  //
  // The budget extension is injected IFF:
  //  1. opts.monthlySpendStore is provided (composition root wires the SQLite store)
  //  2. ficha.llm.monthly_budget_usd > 0 (budget declared and positive)
  // Both conditions must hold — one alone is insufficient (SPEC-BUDGET-5, EC-10).
  // ---------------------------------------------------------------------------
  let agentId: string;
  let budgetUsd: number | undefined;

  if (opts.monthlySpendStore !== undefined) {
    const fichaProfile = await readFichaProfile(opts.fichaDir);
    budgetUsd = fichaProfile.llm?.monthly_budget_usd;

    if (fichaProfile.agent?.id) {
      agentId = fichaProfile.agent.id;
    } else {
      agentId = basename(opts.fichaDir);
      process.stderr.write(
        `zia: ${opts.fichaDir}/profile.yaml is missing agent.id. ` +
        `Budget and audit records will use the directory name as the agent identifier. ` +
        `Add 'agent:\\n  id: <slug>' to silence this warning.\n`,
      );
    }
  } else {
    // No store provided — agentId is unused; budget extension will not be injected.
    agentId = basename(opts.fichaDir);
  }

  // Build the budget extension factory (null when budgetUsd <= 0 or store absent).
  const budgetExtensionFactory =
    opts.monthlySpendStore !== undefined && budgetUsd !== undefined && budgetUsd > 0
      ? createBudgetEnforcementExtension({
          store: opts.monthlySpendStore,
          agentId,
          budgetUsd,
        })
      : null;

  // Compose extension factories: caller-supplied + budget extension (if active).
  const allExtensionFactories: ExtensionFactory[] = [
    ...(opts.extensionFactories ?? []),
    ...(budgetExtensionFactory !== null ? [budgetExtensionFactory] : []),
  ];

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
        extensionFactories: allExtensionFactories,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel,
        // F-CORE-9: pass all resolved models so pi.dev can cycle through them
        // via Ctrl+P (TUI), RPC set_model, and RPC cycle_model (SPEC-SCOPED-1).
        // resolvedModels is captured from the outer scope (closure over the
        // resolved array created before this factory runs).
        scopedModels: resolvedModels,
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
    scopedModels: resolvedModels,
  };
}
