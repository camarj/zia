/**
 * agent-fallback-wiring.test.ts — SPEC-FB-1, SPEC-FB-8 (model-fallback, F-LLM-4)
 *
 * Verifies createZiaAgent's gated wiring of the fallback controller:
 *  SPEC-FB-1-A — fallback_on_error:true + >=2 scopedModels → controller wired +
 *                setAutoRetryEnabled(true) called (SPEC-FB-8-A)
 *  SPEC-FB-1-B — fallback_on_error:false → neither called, no warning
 *  SPEC-FB-1-C — fallback_on_error:true + 1 scopedModel → controller NOT called +
 *                stderr warning containing "fallback_on_error" and "no additional models"
 *
 * Strategy: mock the pi.dev SDK (same pattern as agent-scoped-models.test.ts),
 * mock resolveAvailableModels, and mock ./fallback-controller.ts so we can spy
 * on createFallbackController without exercising its internals. fakeRuntime.session
 * carries subscribe + setAutoRetryEnabled spies.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fakeAuthStorage,
  fakeRuntime,
  resolveAvailableModelsMock,
  createFallbackControllerMock,
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
      scopedModels: [] as unknown[],
      subscribe: vi.fn(() => () => {}),
      setAutoRetryEnabled: vi.fn(),
      setModel: vi.fn(),
      sendUserMessage: vi.fn(),
      sendCustomMessage: vi.fn(),
      model: { id: "m0" },
    },
  };

  const resolveAvailableModelsMock = vi.fn();
  const createFallbackControllerMock = vi.fn(
    (_opts: { session: unknown; scopedModels: unknown[]; agentId: string }) => ({
      dispose: vi.fn(),
    }),
  );

  return { fakeAuthStorage, fakeRuntime, resolveAvailableModelsMock, createFallbackControllerMock };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: () => fakeAuthStorage },
  ModelRegistry: { create: () => ({}) },
  SessionManager: { create: () => ({}) },
  getAgentDir: () => "/fake-agent-dir",
  createAgentSessionFromServices: vi.fn().mockResolvedValue(fakeRuntime),
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

vi.mock("@zia/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zia/providers")>();
  return {
    ...original,
    resolveAvailableModels: resolveAvailableModelsMock,
    resolveModelFromFicha: vi.fn().mockResolvedValue({
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      name: "claude-haiku-4-5-20251001 (mock)",
      api: "anthropic",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_000,
    }),
  };
});

// Mock the fallback controller module so we can spy on createFallbackController.
vi.mock("../src/fallback-controller.ts", () => ({
  createFallbackController: createFallbackControllerMock,
}));

import { createZiaAgent } from "../src/agent.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeModel(provider: string, modelId: string) {
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

const SOUL_MD = "# Test Agent\nFallback wiring soul.";
const POLICIES_MD = "# Policies\n## Trivial\nTools: test_read\n";

function fichaYaml(fallback: boolean | undefined, withAvailable: boolean): string {
  const flag = fallback === undefined ? "" : `\n  fallback_on_error: ${fallback}`;
  const available = withAvailable
    ? `
  available:
    - provider: anthropic
      model: claude-haiku-4-5-20251001
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-sonnet-4-6
      credentials_env: ANTHROPIC_API_KEY`
    : "";
  return `
agent:
  id: fb-wire-001
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001${flag}${available}
`.trim();
}

async function makeFicha(profileYaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-fb-wire-"));
  await writeFile(join(dir, "profile.yaml"), profileYaml, "utf8");
  await writeFile(join(dir, "SOUL.md"), SOUL_MD, "utf8");
  await writeFile(join(dir, "POLICIES.md"), POLICIES_MD, "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createZiaAgent — fallback controller wiring (SPEC-FB-1, SPEC-FB-8)", () => {
  const createdDirs: string[] = [];
  let originalEnv: typeof process.env;
  let stderrCalls: unknown[][];

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "fake-test-key-fb";
    vi.clearAllMocks();
    createFallbackControllerMock.mockReturnValue({ dispose: vi.fn() });
    stderrCalls = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrCalls.push([chunk]);
      return true;
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();
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

  // SPEC-FB-1-A + SPEC-FB-8-A
  it("wires the controller and calls setAutoRetryEnabled(true) when fallback_on_error:true and >=2 models (SPEC-FB-1-A, SPEC-FB-8-A)", async () => {
    resolveAvailableModelsMock.mockResolvedValue([
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), modelId: "claude-haiku-4-5-20251001" },
      { model: makeModel("anthropic", "claude-sonnet-4-6"), modelId: "claude-sonnet-4-6" },
    ]);

    const fichaDir = await fixture(fichaYaml(true, true));
    await createZiaAgent({ fichaDir, rawTools: [] });

    expect(createFallbackControllerMock).toHaveBeenCalledTimes(1);
    const opts = createFallbackControllerMock.mock.calls[0]![0];
    expect(opts.session).toBe(fakeRuntime.session);
    expect(opts.scopedModels).toHaveLength(2);
    expect(opts.agentId).toBe("fb-wire-001");
    expect(fakeRuntime.session.setAutoRetryEnabled).toHaveBeenCalledWith(true);
  });

  // SPEC-FB-1-B
  it("does NOT wire and emits no warning when fallback_on_error:false (SPEC-FB-1-B)", async () => {
    resolveAvailableModelsMock.mockResolvedValue([
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), modelId: "claude-haiku-4-5-20251001" },
      { model: makeModel("anthropic", "claude-sonnet-4-6"), modelId: "claude-sonnet-4-6" },
    ]);

    const fichaDir = await fixture(fichaYaml(false, true));
    await createZiaAgent({ fichaDir, rawTools: [] });

    expect(createFallbackControllerMock).not.toHaveBeenCalled();
    expect(fakeRuntime.session.setAutoRetryEnabled).not.toHaveBeenCalled();
    const warned = stderrCalls.some((c) =>
      String(c[0]).includes("fallback_on_error"),
    );
    expect(warned).toBe(false);
  });

  // SPEC-FB-1-B (absent flag behaves like false)
  it("does NOT wire when fallback_on_error is absent (SPEC-FB-1-B)", async () => {
    resolveAvailableModelsMock.mockResolvedValue([
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), modelId: "claude-haiku-4-5-20251001" },
      { model: makeModel("anthropic", "claude-sonnet-4-6"), modelId: "claude-sonnet-4-6" },
    ]);

    const fichaDir = await fixture(fichaYaml(undefined, true));
    await createZiaAgent({ fichaDir, rawTools: [] });

    expect(createFallbackControllerMock).not.toHaveBeenCalled();
    expect(fakeRuntime.session.setAutoRetryEnabled).not.toHaveBeenCalled();
  });

  // SPEC-FB-1-C
  it("does NOT wire but emits a stderr warning when fallback_on_error:true and only 1 model (SPEC-FB-1-C)", async () => {
    resolveAvailableModelsMock.mockResolvedValue([
      { model: makeModel("anthropic", "claude-haiku-4-5-20251001"), modelId: "claude-haiku-4-5-20251001" },
    ]);

    const fichaDir = await fixture(fichaYaml(true, false));
    await createZiaAgent({ fichaDir, rawTools: [] });

    expect(createFallbackControllerMock).not.toHaveBeenCalled();
    expect(fakeRuntime.session.setAutoRetryEnabled).not.toHaveBeenCalled();
    const warning = stderrCalls
      .map((c) => String(c[0]))
      .find((s) => s.includes("fallback_on_error"));
    expect(warning).toBeDefined();
    expect(warning).toContain("no additional models");
  });
});
