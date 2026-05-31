/**
 * agent-scoped-models.test.ts — SPEC-SCOPED-1 (PR3, F-CORE-9)
 *
 * Verifies that createZiaAgent:
 *  A. populates scopedModels on the handle from llm.available[] in the ficha
 *  B. authenticates every entry before session creation
 *  C. falls back to a single-entry when llm.available is absent
 *  D. RPC set_model wiring correctness (scopedModels lets the SDK switch models)
 *  E. RPC cycle_model wraps correctly (mock-level: scopedModels length verified)
 *
 * Strategy: mock the pi.dev SDK + mock resolveAvailableModels from @zia/providers.
 * We do NOT test Ctrl+P keystrokes (TUI-only, manual smoke — EC-8 documented).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Build shared fakes BEFORE vi.mock hoisting so the factories close over them.
// resolveAvailableModelsMock MUST also live here — vi.mock factories are
// hoisted above all module-scope initializers, so any variable they close
// over must be created via vi.hoisted() to avoid TDZ errors.
// ---------------------------------------------------------------------------

const {
  fakeAuthStorage,
  fakeRuntime,
  createAgentSessionFromServicesMock,
  resolveAvailableModelsMock,
} = vi.hoisted(() => {
  const registeredKeys: Record<string, string> = {};
  const authChecks: Record<string, boolean> = {};

  const fakeAuthStorage = {
    setRuntimeApiKey: vi.fn((provider: string, key: string) => {
      registeredKeys[provider] = key;
    }),
    hasAuth: vi.fn((provider: string) => authChecks[provider] ?? false),
    _registeredKeys: registeredKeys,
    _authChecks: authChecks,
  };

  const fakeRuntime = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    session: {
      scopedModels: [] as Array<{ model: { id?: string; provider?: string }; thinkingLevel?: string }>,
    },
  };

  const createAgentSessionFromServicesMock = vi.fn().mockResolvedValue(fakeRuntime);
  const resolveAvailableModelsMock = vi.fn();

  return { fakeAuthStorage, fakeRuntime, createAgentSessionFromServicesMock, resolveAvailableModelsMock };
});

// ---------------------------------------------------------------------------
// Mock pi.dev SDK — same pattern as audit-log-injection.test.ts
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => fakeAuthStorage,
  },
  ModelRegistry: { create: () => ({}) },
  SessionManager: { create: () => ({}) },
  getAgentDir: () => "/fake-agent-dir",
  createAgentSessionFromServices: createAgentSessionFromServicesMock,
  createAgentSessionRuntime: vi.fn().mockResolvedValue(fakeRuntime),
  createAgentSessionServices: vi.fn().mockResolvedValue({ diagnostics: {} }),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: (provider: string, modelId: string) => ({
    id: modelId,
    provider,
    name: `${modelId} (mock)`,
    api: "anthropic",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  }),
}));

// ---------------------------------------------------------------------------
// Mock resolveAvailableModels from @zia/providers.
// resolveAvailableModelsMock is created via vi.hoisted() above — see the
// rationale in the hoisted block comment.
// ---------------------------------------------------------------------------

vi.mock("@zia/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zia/providers")>();
  return {
    ...original,
    resolveAvailableModels: resolveAvailableModelsMock,
  };
});

import { createZiaAgent } from "../src/agent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROFILE_YAML_WITH_AVAILABLE = `
agent:
  id: test-agent-001
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
  available:
    - provider: anthropic
      model: claude-haiku-4-5-20251001
      thinkingLevel: low
      label: "Haiku (fast)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-sonnet-4-6
      thinkingLevel: medium
      label: "Sonnet (balanced)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      label: "Opus (reasoning)"
      credentials_env: ANTHROPIC_API_KEY
`.trim();

const PROFILE_YAML_MINIMAL = `
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim();

const SOUL_MD = "# Test Agent\nA test soul for scopedModels wiring.";
const POLICIES_MD = "# Policies\n## Trivial\nTools: test_read\n";

function makeModel(provider: string, modelId: string): {
  id: string;
  provider: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
} {
  return {
    id: modelId,
    provider,
    name: `${modelId} (mock)`,
    api: "anthropic",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  };
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

async function makeFicha(profileYaml: string, soulMd = SOUL_MD, policiesMd = POLICIES_MD): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-scoped-models-"));
  await writeFile(join(dir, "profile.yaml"), profileYaml, "utf8");
  await writeFile(join(dir, "SOUL.md"), soulMd, "utf8");
  await writeFile(join(dir, "POLICIES.md"), policiesMd, "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createZiaAgent — scopedModels wiring (SPEC-SCOPED-1)", () => {
  const createdDirs: string[] = [];
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "fake-test-key-scoped";

    // Reset mocks and runtime state
    vi.clearAllMocks();
    createAgentSessionFromServicesMock.mockResolvedValue(fakeRuntime);
    fakeRuntime.session.scopedModels = [];
    Object.keys(fakeAuthStorage._registeredKeys).forEach((k) => delete fakeAuthStorage._registeredKeys[k]);
    Object.keys(fakeAuthStorage._authChecks).forEach((k) => delete fakeAuthStorage._authChecks[k]);
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  async function fixture(profileYaml = PROFILE_YAML_WITH_AVAILABLE): Promise<string> {
    const dir = await makeFicha(profileYaml);
    createdDirs.push(dir);
    return dir;
  }

  // -------------------------------------------------------------------------
  // SPEC-SCOPED-1-A: scopedModels populated from ficha (length 3)
  // -------------------------------------------------------------------------
  it("SPEC-SCOPED-1-A: handle.scopedModels contains all 3 entries from llm.available[]", async () => {
    const models = [
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), thinkingLevel: "low" as const },
      { model: makeModel("anthropic", "claude-sonnet-4-6"), thinkingLevel: "medium" as const },
      { model: makeModel("anthropic", "claude-opus-4-7"), thinkingLevel: "high" as const },
    ];
    resolveAvailableModelsMock.mockResolvedValue(models);

    const fichaDir = await fixture();
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    expect(handle.scopedModels).toHaveLength(3);
    expect(handle.scopedModels[0]?.model.id).toBe("claude-haiku-4-5-20251001");
    expect(handle.scopedModels[1]?.model.id).toBe("claude-sonnet-4-6");
    expect(handle.scopedModels[2]?.model.id).toBe("claude-opus-4-7");
  });

  // -------------------------------------------------------------------------
  // SPEC-SCOPED-1-B: all entries are authenticated (resolveAvailableModels
  // already calls authStorage.setRuntimeApiKey — verify it was called by PR1's
  // resolver; here we verify the authStorage shared with createAgentSession
  // is the same one resolveAvailableModels received).
  // -------------------------------------------------------------------------
  it("SPEC-SCOPED-1-B: resolveAvailableModels is called with the same authStorage used for the session", async () => {
    const models = [
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), thinkingLevel: "low" as const },
      { model: makeModel("anthropic", "claude-sonnet-4-6"), thinkingLevel: "medium" as const },
    ];
    resolveAvailableModelsMock.mockResolvedValue(models);

    const fichaDir = await fixture();
    await createZiaAgent({ fichaDir, rawTools: [] });

    // resolveAvailableModels MUST be called with fichaDir, process.env, and the shared authStorage
    expect(resolveAvailableModelsMock).toHaveBeenCalledTimes(1);
    const [calledFichaDir, calledEnv, calledAuthStorage] = resolveAvailableModelsMock.mock.calls[0]!;
    expect(calledFichaDir).toBe(fichaDir);
    expect(calledEnv).toBe(process.env);
    // The authStorage passed in must be the same object used for ModelRegistry.create
    expect(calledAuthStorage).toBe(fakeAuthStorage);
  });

  // -------------------------------------------------------------------------
  // SPEC-SCOPED-1-C: no llm.available → single-entry scopedModels (fallback)
  // -------------------------------------------------------------------------
  it("SPEC-SCOPED-1-C: single-entry scopedModels when no llm.available in ficha", async () => {
    const fallbackModels = [
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), thinkingLevel: undefined },
    ];
    resolveAvailableModelsMock.mockResolvedValue(fallbackModels);

    const fichaDir = await fixture(PROFILE_YAML_MINIMAL);
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    expect(handle.scopedModels).toHaveLength(1);
    expect(handle.scopedModels[0]?.model.id).toBe("claude-haiku-4-5-20251001");
  });

  // -------------------------------------------------------------------------
  // SPEC-SCOPED-1-D: RPC set_model wiring — the handle exposes scopedModels
  // so the pi.dev runtime can process set_model RPC.
  //
  // Note: createAgentSessionRuntime is mocked to return fakeRuntime directly
  // (without calling the factory), so createAgentSessionFromServices is never
  // invoked in this test context. We verify the observable contract instead:
  // handle.scopedModels matches the resolved entries, which is what gets
  // forwarded to the pi.dev session when the real runtime factory runs.
  // -------------------------------------------------------------------------
  it("SPEC-SCOPED-1-D: handle.scopedModels has all entries for set_model wiring", async () => {
    const models = [
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), thinkingLevel: "low" as const },
      { model: makeModel("anthropic", "claude-opus-4-7"), thinkingLevel: "high" as const },
    ];
    resolveAvailableModelsMock.mockResolvedValue(models);

    const fichaDir = await fixture();
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    // The handle exposes scopedModels — this is what gets forwarded to
    // createAgentSessionFromServices as `scopedModels` in the real runtime.
    expect(handle.scopedModels).toHaveLength(2);
    expect(handle.scopedModels[0]?.model.id).toBe("claude-haiku-4-5-20251001");
    expect(handle.scopedModels[0]?.thinkingLevel).toBe("low");
    expect(handle.scopedModels[1]?.model.id).toBe("claude-opus-4-7");
    expect(handle.scopedModels[1]?.thinkingLevel).toBe("high");
  });

  // -------------------------------------------------------------------------
  // SPEC-SCOPED-1-E: RPC cycle_model wraps — verify 3-entry scopedModels are
  // forwarded so the SDK can cycle through them.
  // -------------------------------------------------------------------------
  it("SPEC-SCOPED-1-E: all 3 scopedModels entries forwarded → cycle_model can wrap (wiring correctness)", async () => {
    const models = [
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), thinkingLevel: "low" as const },
      { model: makeModel("anthropic", "claude-sonnet-4-6"), thinkingLevel: "medium" as const },
      { model: makeModel("anthropic", "claude-opus-4-7"), thinkingLevel: "high" as const },
    ];
    resolveAvailableModelsMock.mockResolvedValue(models);

    const fichaDir = await fixture();
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    // After wiring, handle.scopedModels must have all 3 — the SDK can cycle
    // through them (entry[0] → entry[1] → entry[2] → wraps back to entry[0]).
    expect(handle.scopedModels).toHaveLength(3);
    // Cycling logic itself is inside pi.dev SDK (AgentSession.cycleModel) —
    // zia's contract is that scopedModels is populated correctly. EC-8.
    expect(handle.scopedModels[0]?.model.id).toBe("claude-haiku-4-5-20251001");
    expect(handle.scopedModels[1]?.model.id).toBe("claude-sonnet-4-6");
    expect(handle.scopedModels[2]?.model.id).toBe("claude-opus-4-7");
  });

  // -------------------------------------------------------------------------
  // Default model + thinkingLevel comes from resolvedModels[0].
  // Verified via handle.scopedModels[0] (the real session receives the same
  // first entry as its default model — createAgentSessionFromServices is
  // called with model=resolvedModels[0].model in production; here we verify
  // the handle exposes the correct ordering).
  // -------------------------------------------------------------------------
  it("default model is resolvedModels[0] — handle.scopedModels[0] is the default entry", async () => {
    const models = [
      { model: makeModel("anthropic", "claude-opus-4-7"), thinkingLevel: "high" as const },
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), thinkingLevel: "low" as const },
    ];
    resolveAvailableModelsMock.mockResolvedValue(models);

    const fichaDir = await fixture();
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    // The first entry in scopedModels is used as model + thinkingLevel for
    // the session; the handle exposes the full array in the same order.
    expect(handle.scopedModels[0]?.model.id).toBe("claude-opus-4-7");
    expect(handle.scopedModels[0]?.thinkingLevel).toBe("high");
    // Second entry is NOT the default (ordering preserved from available[])
    expect(handle.scopedModels[1]?.model.id).toBe("claude-haiku-4-5-20251001");
  });

  // -------------------------------------------------------------------------
  // resolveAvailableModels is called BEFORE createAgentSessionRuntime
  // (SPEC-SCOPED-1 contract: credentials registered before session creation)
  // -------------------------------------------------------------------------
  it("resolveAvailableModels is called before session runtime creation", async () => {
    const callOrder: string[] = [];

    resolveAvailableModelsMock.mockImplementation(async () => {
      callOrder.push("resolveAvailableModels");
      return [{ model: makeModel("anthropic", "claude-haiku-4-5-20251001"), thinkingLevel: "low" as const }];
    });

    const { createAgentSessionRuntime } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(createAgentSessionRuntime).mockImplementation(async () => {
      callOrder.push("createAgentSessionRuntime");
      // Cast: fakeRuntime is a minimal test double — it lacks most AgentSessionRuntime
      // members but is sufficient to verify call ordering without a live SDK session.
      return fakeRuntime as unknown as Awaited<ReturnType<typeof createAgentSessionRuntime>>;
    });

    const fichaDir = await fixture(PROFILE_YAML_MINIMAL);
    await createZiaAgent({ fichaDir, rawTools: [] });

    const resolveIdx = callOrder.indexOf("resolveAvailableModels");
    const runtimeIdx = callOrder.indexOf("createAgentSessionRuntime");
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(runtimeIdx).toBeGreaterThan(resolveIdx);
  });
});
