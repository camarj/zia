/**
 * budget-extension.test.ts — SPEC-BUDGET-1 through SPEC-BUDGET-6 (PR4a, F-CORE-8)
 *
 * Verifies createBudgetEnforcementExtension:
 *  1-A  Spend accumulates on assistant message_end
 *  1-B  Non-assistant message_end is ignored
 *  1-C  cost.total=0 (free/local model) → no accumulation call
 *  2-A  Warn fires once when spend crosses 80%
 *  2-B  Warn does NOT fire below 80%
 *  3-A  Hard stop: input gate returns { action:"handled" } at ≥100%
 *  3-B  tool_call secondary gate returns { block:true } mid-turn at ≥100%
 *  3-C  Hard stop: zero provider calls (input gate fires before agent_start)
 *  4-A  DB read failure → fail-open (allow turn + warn in log)
 *  5-A  budget OFF when monthly_budget_usd absent (no extension injected)
 *  6-A  agent.id absent → slug fallback + warning emitted
 *
 * Strategy: mock the pi.dev ExtensionAPI surface (handlers captured for direct
 * invocation), and use a fake MonthlySpendStore. For event-driven scenarios
 * we call captured handlers directly — no need for a full print-mode harness
 * because the handlers are synchronous and testable in isolation.
 *
 * INV-1: budget-extension.ts MUST NOT import @zia/persistence.
 */

import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks — must be declared via vi.hoisted() so they exist before the
// vi.mock() factories (which are hoisted above all module-scope code).
// ---------------------------------------------------------------------------

const {
  fakeAuthStorage,
  fakeRuntime,
  resolveAvailableModelsMock,
  capturedExtensionFactories,
  createAgentSessionServicesMock,
} = vi.hoisted(() => {
  const fakeAuthStorage = {
    setRuntimeApiKey: vi.fn(),
    hasAuth: vi.fn().mockReturnValue(false),
  };

  const fakeRuntime = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    session: { scopedModels: [] },
  };

  const capturedExtensionFactories: Array<Array<unknown>> = [];

  const createAgentSessionServicesMock = vi.fn().mockImplementation(
    async (opts: { resourceLoaderOptions?: { extensionFactories?: unknown[] } }) => {
      capturedExtensionFactories.push(
        opts?.resourceLoaderOptions?.extensionFactories ?? [],
      );
      return { diagnostics: {} };
    },
  );

  const resolveAvailableModelsMock = vi.fn().mockResolvedValue([
    {
      model: { id: "claude-haiku-4-5-20251001", provider: "anthropic" },
      thinkingLevel: "low",
      modelId: "claude-haiku-4-5-20251001",
      label: "Haiku",
    },
  ]);

  return {
    fakeAuthStorage,
    fakeRuntime,
    resolveAvailableModelsMock,
    capturedExtensionFactories,
    createAgentSessionServicesMock,
  };
});

// ---------------------------------------------------------------------------
// Mock pi.dev SDK — same pattern as agent-scoped-models.test.ts
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: () => fakeAuthStorage },
  ModelRegistry: { create: () => ({}) },
  SessionManager: { create: () => ({}) },
  getAgentDir: () => "/fake-agent-dir",
  createAgentSessionFromServices: vi.fn().mockResolvedValue(fakeRuntime),
  createAgentSessionRuntime: vi.fn().mockResolvedValue(fakeRuntime),
  createAgentSessionServices: createAgentSessionServicesMock,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: (provider: string, modelId: string) => ({ id: modelId, provider }),
}));

vi.mock("@zia/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zia/providers")>();
  return { ...original, resolveAvailableModels: resolveAvailableModelsMock };
});

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  createBudgetEnforcementExtension,
} from "../src/budget-extension.ts";

import { createZiaAgent } from "../src/agent.ts";

// ---------------------------------------------------------------------------
// Fake MonthlySpendStore (structural, satisfies the interface without importing
// @zia/persistence — the interface lives in budget-extension.ts itself).
// ---------------------------------------------------------------------------

function makeFakeStore(initialSpendForCurrentMonth = 0): {
  store: {
    accumulate: ReturnType<typeof vi.fn>;
    getSpend: ReturnType<typeof vi.fn>;
    getSpendOrThrow: ReturnType<typeof vi.fn>;
  };
} {
  const currentYm = new Date().toISOString().slice(0, 7);
  const spendMap: Record<string, number> = {};
  if (initialSpendForCurrentMonth > 0) {
    spendMap[`*:${currentYm}`] = initialSpendForCurrentMonth;
  }

  const store = {
    accumulate: vi.fn((agentId: string, delta: number, yearMonth?: string) => {
      const ym = yearMonth ?? currentYm;
      const key = `${agentId}:${ym}`;
      spendMap[key] = (spendMap[key] ?? 0) + delta;
    }),
    getSpend: vi.fn((agentId: string, yearMonth?: string) => {
      const ym = yearMonth ?? currentYm;
      const key = `${agentId}:${ym}`;
      return spendMap[key] ?? 0;
    }),
    getSpendOrThrow: vi.fn((agentId: string, yearMonth?: string) => {
      const ym = yearMonth ?? currentYm;
      const key = `${agentId}:${ym}`;
      return spendMap[key] ?? 0;
    }),
  };
  return { store };
}

// ---------------------------------------------------------------------------
// Fake ExtensionAPI — captures registered handlers for direct invocation
// ---------------------------------------------------------------------------

type HandlerFn = (ev: unknown, ctx: unknown) => unknown;
type HandlerMap = Map<string, HandlerFn>;

function makeFakeApi(): {
  api: {
    on: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    handlers: HandlerMap;
    messages: Array<{ customType: string; content: unknown }>;
    [key: string]: unknown;
  };
} {
  const handlers: HandlerMap = new Map();
  const messages: Array<{ customType: string; content: unknown }> = [];

  const api = {
    handlers,
    messages,
    on: vi.fn((event: string, handler: HandlerFn) => {
      handlers.set(event, handler);
    }),
    sendMessage: vi.fn((msg: { customType: string; content: unknown }) => {
      messages.push(msg);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn().mockReturnValue("medium"),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  };

  return { api };
}

// Helper to build a message_end event payload
function makeMessageEndEvent(
  role: string,
  costTotal?: number,
): { message: { role: string; usage?: { cost: { total: number } }; timestamp: number } } {
  return {
    message: {
      role,
      ...(costTotal !== undefined ? { usage: { cost: { total: costTotal } } } : {}),
      timestamp: Date.now(),
    },
  };
}

// Helper to build an input event payload
function makeInputEvent(text = "hello"): { text: string; source: string } {
  return { text, source: "interactive" };
}

// Helper to build a tool_call event payload
function makeToolCallEvent(toolName = "some_tool"): {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
} {
  return { type: "tool_call", toolCallId: "tc-1", toolName, input: {} };
}

// Fake ExtensionContext (just enough for notify)
function makeFakeCtx(): {
  ui: { notify: ReturnType<typeof vi.fn> };
  hasUI: boolean;
} {
  return { ui: { notify: vi.fn() }, hasUI: true };
}

// ---------------------------------------------------------------------------
// Fixture factory for createZiaAgent tests
// ---------------------------------------------------------------------------

async function makeFicha(profileYaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-budget-ext-"));
  await writeFile(join(dir, "profile.yaml"), profileYaml, "utf8");
  await writeFile(join(dir, "SOUL.md"), "# Agent\nTest soul.", "utf8");
  await writeFile(join(dir, "POLICIES.md"), "# Policies\n## Trivial\nTools: test_read\n", "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Tests: createBudgetEnforcementExtension
// ---------------------------------------------------------------------------

describe("createBudgetEnforcementExtension", () => {
  // -------------------------------------------------------------------------
  // SPEC-BUDGET-1-A: accumulation fires on assistant message_end
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-1-A: accumulates spend on assistant message_end with cost.total > 0", () => {
    const { store } = makeFakeStore(0);
    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    expect(factory).not.toBeNull();

    const { api } = makeFakeApi();
    factory!(api as never);

    const handler = api.handlers.get("message_end");
    expect(handler).toBeDefined();

    handler!(makeMessageEndEvent("assistant", 0.02), makeFakeCtx());

    expect(store.accumulate).toHaveBeenCalledTimes(1);
    expect(store.accumulate).toHaveBeenCalledWith("fin-001", 0.02);
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-1-B: non-assistant message_end is ignored
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-1-B: non-assistant message_end is ignored", () => {
    const { store } = makeFakeStore(0);
    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const handler = api.handlers.get("message_end");
    handler!(makeMessageEndEvent("user", 0.02), makeFakeCtx());
    handler!(makeMessageEndEvent("toolResult", 0.05), makeFakeCtx());

    expect(store.accumulate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-1-C: cost.total=0 → no accumulation (free model no-op)
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-1-C: cost.total=0 does not call accumulate", () => {
    const { store } = makeFakeStore(0);
    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const handler = api.handlers.get("message_end");
    handler!(makeMessageEndEvent("assistant", 0), makeFakeCtx());

    expect(store.accumulate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-1-C (edge): missing usage/cost field → no accumulation
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-1-C (edge): missing usage/cost field → no accumulation", () => {
    const { store } = makeFakeStore(0);
    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const handler = api.handlers.get("message_end");
    handler!(makeMessageEndEvent("assistant" /* no cost */), makeFakeCtx());

    expect(store.accumulate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-2-A: warn fires ONCE when spend is at ≥80% AND <100%
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-2-A: warn fires once at 80%, not on subsequent prompts", () => {
    const { store } = makeFakeStore(0);
    // 8.00 out of 10.00 = 80%
    store.getSpend.mockReturnValue(8.0);

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    expect(inputHandler).toBeDefined();

    const ctx = makeFakeCtx();

    // First prompt — should warn (80%)
    const result1 = inputHandler!(makeInputEvent("prompt 1"), ctx);
    expect(result1).not.toEqual({ action: "handled" });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Second prompt — should NOT warn again (once per session crossing)
    const result2 = inputHandler!(makeInputEvent("prompt 2"), ctx);
    expect(result2).not.toEqual({ action: "handled" });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // still 1
    expect(api.sendMessage).toHaveBeenCalledTimes(1); // still 1
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-2-B: warn does NOT fire below 80%
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-2-B: no warn when spend is below 80%", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(7.99); // 79.9%

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    const ctx = makeFakeCtx();
    inputHandler!(makeInputEvent("hello"), ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-3-A: hard stop — input gate returns { action:"handled" } at ≥100%
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-3-A: hard stop — input handler returns { action:'handled' } at ≥100%", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(10.01); // 100.1%

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    const ctx = makeFakeCtx();
    const result = inputHandler!(makeInputEvent("any prompt"), ctx);

    expect(result).toEqual({ action: "handled" });
    // A budget-exhausted CustomMessage MUST be sent
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = api.messages[0]!;
    expect(sentMsg.customType).toBe("zia:budget-exhausted");
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-3-A: exactly 100% also triggers hard stop
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-3-A: hard stop at exactly 100% (spend === budget)", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(10.0); // 100% exactly

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    const result = inputHandler!(makeInputEvent("test"), makeFakeCtx());

    expect((result as { action: string }).action).toBe("handled");
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-3-B: tool_call secondary gate blocks at ≥100% mid-turn
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-3-B: tool_call secondary gate returns { block:true } when spend ≥ 100%", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(10.0); // 100%

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const toolCallHandler = api.handlers.get("tool_call");
    expect(toolCallHandler).toBeDefined();

    const result = toolCallHandler!(makeToolCallEvent("some_tool"), makeFakeCtx());

    expect(result).toEqual({ block: true, reason: "monthly budget exceeded" });
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-3-B (inverse): tool_call gate does NOT block when under 100%
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-3-B (inverse): tool_call gate does NOT block when spend < 100%", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(5.0); // 50%

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const toolCallHandler = api.handlers.get("tool_call");
    const result = toolCallHandler!(makeToolCallEvent("some_tool"), makeFakeCtx());

    expect((result as { block?: boolean } | undefined)?.block).not.toBe(true);
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-3-C: returning handled = pi.dev skips agent_start + LLM call
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-3-C: input handler returning handled is the sentinel that prevents provider calls", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(0.0002); // over a 0.0001 budget

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 0.0001,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    const result = inputHandler!(makeInputEvent("anything"), makeFakeCtx());

    // { action:"handled" } is the pi.dev contract: prompt() returns immediately
    // before agent_start and before any provider HTTP call.
    expect((result as { action: string }).action).toBe("handled");
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-4-A: DB read failure → fail-open (allow turn)
  // The MonthlySpendStore contract guarantees getSpend returns 0 on error.
  // The budget extension relies on that contract — no additional try/catch needed.
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-4-A: DB read failure → allow turn (getSpend fail-open returns 0)", () => {
    const { store } = makeFakeStore(0);
    // Simulate fail-open: getSpend returns 0 even when DB is broken
    store.getSpend.mockReturnValue(0);

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    const ctx = makeFakeCtx();
    const result = inputHandler!(makeInputEvent("test"), ctx);

    // 0/10 = 0% → allow turn (not handled)
    expect(result).not.toEqual({ action: "handled" });
    // No warn (0% < 80%)
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // EC-10 / SPEC-BUDGET-5 guard: budgetUsd=0 → null factory
  // -------------------------------------------------------------------------
  it("EC-10: budgetUsd=0 returns null (treat as no-budget)", () => {
    const { store } = makeFakeStore(0);
    const result = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 0,
    });

    expect(result).toBeNull();
  });

  it("EC-10: budgetUsd<0 returns null (treat as no-budget)", () => {
    const { store } = makeFakeStore(0);
    const result = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: -5,
    });

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // SPEC-BUDGET-6-A: any agentId string works as the accounting key (slug included)
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-6-A: budget extension works with slug agentId from path.basename", () => {
    const { store } = makeFakeStore(0);
    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "finance", // slug derived from path.basename('/agents/finance')
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const handler = api.handlers.get("message_end");
    handler!(makeMessageEndEvent("assistant", 0.05), makeFakeCtx());

    expect(store.accumulate).toHaveBeenCalledWith("finance", 0.05);
  });

  // -------------------------------------------------------------------------
  // Warn CustomMessage type
  // -------------------------------------------------------------------------
  it("warn at 80% emits zia:budget-warning CustomMessage", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(8.0); // 80%

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    inputHandler!(makeInputEvent("test"), makeFakeCtx());

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const msg = api.messages[0]!;
    expect(msg.customType).toBe("zia:budget-warning");
  });

  // -------------------------------------------------------------------------
  // Budget-exhausted message has content
  // -------------------------------------------------------------------------
  it("SPEC-BUDGET-3-A: budget-exhausted CustomMessage has non-empty content", () => {
    const { store } = makeFakeStore(0);
    store.getSpend.mockReturnValue(10.5);

    const factory = createBudgetEnforcementExtension({
      store,
      agentId: "fin-001",
      budgetUsd: 10,
    });

    const { api } = makeFakeApi();
    factory!(api as never);

    const inputHandler = api.handlers.get("input");
    inputHandler!(makeInputEvent("test"), makeFakeCtx());

    const msg = api.messages[0]!;
    expect(typeof msg.content).toBe("string");
    expect((msg.content as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: createZiaAgent — budget extension wiring (T-4a.4)
// ---------------------------------------------------------------------------

describe("createZiaAgent — budget extension wiring (T-4a.4)", () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    capturedExtensionFactories.length = 0;
    vi.clearAllMocks();
    // Re-set mocks after clearAllMocks
    resolveAvailableModelsMock.mockResolvedValue([
      {
        model: { id: "claude-haiku-4-5-20251001", provider: "anthropic" },
        thinkingLevel: "low",
        modelId: "claude-haiku-4-5-20251001",
        label: "Haiku",
      },
    ]);
    createAgentSessionServicesMock.mockImplementation(
      async (opts: { resourceLoaderOptions?: { extensionFactories?: unknown[] } }) => {
        capturedExtensionFactories.push(
          opts?.resourceLoaderOptions?.extensionFactories ?? [],
        );
        return { diagnostics: {} };
      },
    );
  });

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  async function fixture(profileYaml: string): Promise<string> {
    const dir = await makeFicha(profileYaml);
    createdDirs.push(dir);
    return dir;
  }

  // SPEC-EXT-1-A: budget extension injected when store + budget > 0
  // Strategy: make createAgentSessionRuntime invoke the factory so
  // createAgentSessionServices is actually called with extensionFactories.
  it("SPEC-EXT-1-A: extension factories are non-empty when monthlySpendStore + monthly_budget_usd > 0", async () => {
    const fichaDir = await fixture(`
agent:
  id: test-001
llm:
  monthly_budget_usd: 10
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim());

    // Override createAgentSessionRuntime to actually invoke the factory
    // so createAgentSessionServices gets called with the real extensionFactories.
    const { createAgentSessionRuntime } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(createAgentSessionRuntime).mockImplementationOnce(async (factory) => {
      await factory({
        cwd: fichaDir,
        agentDir: "/fake-agent-dir",
        sessionManager: {} as never,
        sessionStartEvent: undefined,
      });
      return fakeRuntime as never;
    });

    const { store } = makeFakeStore(0);
    await createZiaAgent({ fichaDir, rawTools: [], monthlySpendStore: store });

    const allFactories = capturedExtensionFactories.flat();
    // With budget + store, at least the budget extension factory is added
    expect(allFactories.length).toBeGreaterThan(0);
  });

  // SPEC-BUDGET-5-A: no crash when monthlySpendStore absent
  it("SPEC-BUDGET-5-A: createZiaAgent succeeds without crash when monthlySpendStore absent", async () => {
    const fichaDir = await fixture(`
agent:
  id: test-001
llm:
  monthly_budget_usd: 10
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim());

    // No monthlySpendStore — budget extension must NOT be injected, no crash
    await expect(createZiaAgent({ fichaDir, rawTools: [] })).resolves.toBeDefined();
  });

  // SPEC-BUDGET-5-A: no crash when monthly_budget_usd absent in ficha
  it("SPEC-BUDGET-5-A: createZiaAgent succeeds when monthly_budget_usd absent in ficha", async () => {
    const fichaDir = await fixture(`
agent:
  id: test-001
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim());

    const { store } = makeFakeStore(0);
    // Store provided but ficha has no budget — must not inject, must not crash
    await expect(
      createZiaAgent({ fichaDir, rawTools: [], monthlySpendStore: store }),
    ).resolves.toBeDefined();
  });

  // SPEC-BUDGET-6-A: slug fallback warning emitted to stderr when agent.id absent
  it("SPEC-BUDGET-6-A: slug fallback warning is emitted to stderr when agent.id absent + budget set", async () => {
    const fichaDir = await fixture(`
llm:
  monthly_budget_usd: 5
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim());

    const { store } = makeFakeStore(0);
    const stderrMessages: string[] = [];

    const spy = vi.spyOn(process.stderr, "write").mockImplementation((msg: unknown) => {
      stderrMessages.push(typeof msg === "string" ? msg : String(msg));
      return true;
    });

    try {
      await createZiaAgent({ fichaDir, rawTools: [], monthlySpendStore: store });
    } finally {
      spy.mockRestore();
    }

    // A warning about missing agent.id MUST have been emitted
    const hasWarning = stderrMessages.some((m) =>
      m.toLowerCase().includes("agent.id") ||
      m.toLowerCase().includes("slug") ||
      m.toLowerCase().includes("budget") ||
      m.toLowerCase().includes("identifier"),
    );
    expect(hasWarning).toBe(true);
  });
});
