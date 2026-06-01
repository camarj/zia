/**
 * agent-active-model-auth.test.ts
 *
 * Regression tests for the active-model auth realignment (engram #704).
 *
 * The fix: `resolveAvailableModels` (the menu resolver) is LAZY — it never
 * throws for missing credentials in llm.available[]. Only the ACTIVE model
 * (llm.default) is authenticated strictly in createZiaAgent before session
 * creation. This mirrors Hermes §7 + pi.dev multi-model.
 *
 * Key regression scenario ("_template case"):
 *   - llm.default: opencode-go (with OPENCODE_GO_API_KEY set)
 *   - llm.available: [anthropic/opus, anthropic/sonnet, ...] (ANTHROPIC_API_KEY NOT set)
 *   - createZiaAgent MUST boot successfully — ANTHROPIC_API_KEY absence must NOT block startup.
 *
 * Complementary coverage:
 *   - Missing the DEFAULT model's key → still throws (active is strict).
 *   - handle.scopedModels still contains the anthropic descriptor(s) even when
 *     their key is absent (lazy menu — descriptors are always built).
 *   - OAuth active model without auth.json → still throws (tested in agent-resolver.test.ts,
 *     preserved by the restored agent.ts block).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — created before vi.mock factories are hoisted.
// ---------------------------------------------------------------------------

const { fakeRuntime, resolveAvailableModelsMock } = vi.hoisted(() => {
  const fakeRuntime = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    session: { scopedModels: [] as unknown[] },
  };

  // Default: returns a single opencode-go entry (matches the _template default)
  const resolveAvailableModelsMock = vi.fn().mockResolvedValue([
    {
      model: { id: "kimi-k2.6", provider: "opencode-go", name: "kimi-k2.6 (mock)", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 32_000 },
      thinkingLevel: "medium" as const,
      modelId: "kimi-k2.6",
      label: undefined,
    },
  ]);

  return { fakeRuntime, resolveAvailableModelsMock };
});

// ---------------------------------------------------------------------------
// Mock pi.dev SDK — prevents real network/session creation.
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => ({
      setRuntimeApiKey: vi.fn(),
      hasAuth: vi.fn().mockReturnValue(false),
    }),
  },
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
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  }),
}));

// ---------------------------------------------------------------------------
// Mock @zia/providers: resolveAvailableModels (lazy menu) and
// resolveModelFromFicha (active model — strict).
// resolveModelFromFicha is tested via its real implementation in agent-resolver
// tests; here we mock it to control the throw/success behaviour.
// ---------------------------------------------------------------------------

vi.mock("@zia/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zia/providers")>();
  return {
    ...original,
    resolveAvailableModels: resolveAvailableModelsMock,
    // Default: resolves successfully (active model key is present).
    // Individual tests override this to test strict failure paths.
    resolveModelFromFicha: vi.fn().mockResolvedValue({
      id: "kimi-k2.6",
      provider: "opencode-go",
      name: "kimi-k2.6 (mock)",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_000,
    }),
  };
});

import { createZiaAgent } from "../src/agent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeFicha(profileYaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-active-auth-"));
  await writeFile(join(dir, "profile.yaml"), profileYaml, "utf8");
  await writeFile(join(dir, "SOUL.md"), "# Test Agent\nTest soul.\n", "utf8");
  await writeFile(join(dir, "POLICIES.md"), "# Policies\n## Trivial\nTools: test_read\n", "utf8");
  return dir;
}

// The _template-style ficha: opencode-go default + multi-provider available[].
const TEMPLATE_PROFILE_YAML = `
agent:
  id: template-001
llm:
  default:
    provider: opencode-go
    model: kimi-k2.6
    thinkingLevel: medium
  available:
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      label: "Opus (razonamiento profundo)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-sonnet-4-6
      thinkingLevel: medium
      label: "Sonnet (default, balance)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: openai
      model: gpt-4o
      label: "GPT-4o (fallback no-Anthropic)"
      credentials_env: OPENAI_API_KEY
    - provider: custom
      model: llama3.1:70b
      label: "Llama local (sin costo)"
      baseUrl: http://localhost:11434/v1
`.trim();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createZiaAgent — active-model auth realignment (engram #704)", () => {
  const createdDirs: string[] = [];
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();

    // Reset resolveAvailableModelsMock to the _template scenario: returns the
    // full menu (4 entries) regardless of missing anthropic/openai keys.
    resolveAvailableModelsMock.mockResolvedValue([
      { model: { id: "claude-opus-4-7", provider: "anthropic" }, thinkingLevel: "high" as const, modelId: "claude-opus-4-7", label: "Opus" },
      { model: { id: "claude-sonnet-4-6", provider: "anthropic" }, thinkingLevel: "medium" as const, modelId: "claude-sonnet-4-6", label: "Sonnet" },
      { model: { id: "gpt-4o", provider: "openai" }, thinkingLevel: undefined, modelId: "gpt-4o", label: "GPT-4o" },
      { model: { id: "llama3.1:70b", provider: "custom" }, thinkingLevel: undefined, modelId: "llama3.1:70b", label: "Llama local" },
    ]);
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  async function fixture(yaml: string): Promise<string> {
    const dir = await makeFicha(yaml);
    createdDirs.push(dir);
    return dir;
  }

  // -------------------------------------------------------------------------
  // THE KEY REGRESSION TEST: _template scenario
  //
  // llm.default = opencode-go (key present) + llm.available[] has anthropic
  // entries whose ANTHROPIC_API_KEY is NOT set.
  // Expected: createZiaAgent BOOTS successfully — available[] key absence does
  // NOT block startup (lazy auth per Hermes §7 + pi.dev multi-model).
  // handle.scopedModels STILL contains all 4 available[] descriptors.
  // -------------------------------------------------------------------------
  it("_template regression: boots with only OPENCODE_GO_API_KEY even when ANTHROPIC_API_KEY + OPENAI_API_KEY are absent", async () => {
    // Set only the default model's key; available[] providers' keys are absent.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENCODE_GO_API_KEY = "fake-opencode-key";

    const fichaDir = await fixture(TEMPLATE_PROFILE_YAML);

    // Must NOT throw — absence of ANTHROPIC_API_KEY / OPENAI_API_KEY must NOT block startup.
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    // The handle must have all 4 menu entries (lazy descriptors always built).
    expect(handle.scopedModels).toHaveLength(4);
    expect(handle.scopedModels[0]?.model.id).toBe("claude-opus-4-7");
    expect(handle.scopedModels[1]?.model.id).toBe("claude-sonnet-4-6");
    expect(handle.scopedModels[2]?.model.id).toBe("gpt-4o");
    expect(handle.scopedModels[3]?.model.id).toBe("llama3.1:70b");
  });

  // -------------------------------------------------------------------------
  // Active model strictness: missing the DEFAULT model's key STILL throws.
  // The available[] key absence is lazy, but llm.default's key is strict.
  // -------------------------------------------------------------------------
  it("still throws when the ACTIVE (llm.default) model's key is missing, even if available[] keys are present", async () => {
    // The real resolveModelFromFicha would throw here; simulate by overriding the mock.
    const { resolveModelFromFicha } = await import("@zia/providers");
    vi.mocked(resolveModelFromFicha).mockRejectedValueOnce(
      new Error("zia: OPENCODE_GO_API_KEY is not set for provider \"opencode-go\". Run `zia model`..."),
    );

    delete process.env.OPENCODE_GO_API_KEY;
    // Available[] keys ARE present but that should not help.
    process.env.ANTHROPIC_API_KEY = "sk-present";

    const fichaDir = await fixture(TEMPLATE_PROFILE_YAML);

    await expect(createZiaAgent({ fichaDir })).rejects.toThrow(/OPENCODE_GO_API_KEY/);
  });

  // -------------------------------------------------------------------------
  // resolveAvailableModels is called with process.env — so best-effort
  // registration happens for available[] entries whose key IS present.
  // -------------------------------------------------------------------------
  it("calls resolveAvailableModels (lazy menu) regardless of available[] key availability", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENCODE_GO_API_KEY = "fake-opencode-key";

    const fichaDir = await fixture(TEMPLATE_PROFILE_YAML);
    await createZiaAgent({ fichaDir, rawTools: [] });

    // resolveAvailableModels must be called exactly once (the menu resolver).
    expect(resolveAvailableModelsMock).toHaveBeenCalledTimes(1);
    const [calledFichaDir, calledEnv] = resolveAvailableModelsMock.mock.calls[0]!;
    expect(calledFichaDir).toBe(fichaDir);
    expect(calledEnv).toBe(process.env);
  });

  // -------------------------------------------------------------------------
  // Minimal ficha (no llm.available) still works with lazy single-entry fallback.
  // -------------------------------------------------------------------------
  it("single-provider ficha (no llm.available) boots with only the default model's key", async () => {
    resolveAvailableModelsMock.mockResolvedValueOnce([
      { model: { id: "kimi-k2.6", provider: "opencode-go" }, thinkingLevel: "medium" as const, modelId: "kimi-k2.6", label: undefined },
    ]);

    process.env.OPENCODE_GO_API_KEY = "fake-opencode-key";

    const fichaDir = await fixture(`
agent:
  id: minimal-001
llm:
  default:
    provider: opencode-go
    model: kimi-k2.6
    thinkingLevel: medium
`.trim());

    const handle = await createZiaAgent({ fichaDir, rawTools: [] });
    expect(handle.scopedModels).toHaveLength(1);
    expect(handle.scopedModels[0]?.model.id).toBe("kimi-k2.6");
  });
});
