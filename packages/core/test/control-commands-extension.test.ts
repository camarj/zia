/**
 * control-commands-extension.test.ts — SPEC-CMD-1 through SPEC-CMD-4,
 * SPEC-EXT-1-A/B (PR4b, F-CORE-10)
 *
 * Verifies createControlCommandsExtension:
 *  CMD-1-A  /model no-args: lists all models, marks active
 *  CMD-1-B  /model <arg>: switches model via pi.setModel
 *  CMD-1-C  /model <no-match>: no setModel call, lists available
 *  CMD-1-D  /model <valid>: setModel returns false → error reported, no crash
 *  CMD-2-A  /memory: file exists w/ content
 *  CMD-2-B  /memory: file empty → "(MEMORY.md is empty)"
 *  CMD-2-C  /memory: file missing → "(MEMORY.md not found)"
 *  CMD-3-A  /status: full status with budget (agentId, model id+label, thinking level,
 *           "$X.XX" spend, "$X.XX" budget, "X.X%")
 *  CMD-3-B  /status: free model → "(free model" in output, "(not set)" for budget
 *  CMD-3-C  /status: no budget declared → "(not set)" for budget
 *  CMD-4-A  /help: lists all commands returned by pi.getCommands()
 *  EXT-1-A  Both extensions active when budget declared
 *  EXT-1-B  Commands extension active without budget
 *
 * Strategy:
 *  - Mock the pi.dev ExtensionAPI surface: registerCommand captures handlers,
 *    sendMessage captures output messages, setModel is async mock.
 *  - Command output is read from captured sendMessage calls (content field).
 *  - pi.setModel is async (Promise<boolean>) per the real SDK contract.
 *
 * INV-1: control-commands-extension.ts MUST NOT import @zia/persistence.
 */

import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks for createZiaAgent integration tests (SPEC-EXT-1-A/B)
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

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { createControlCommandsExtension } from "../src/control-commands-extension.ts";
import type { AvailableModelEntry } from "../src/control-commands-extension.ts";
import { createZiaAgent } from "../src/agent.ts";
import type { MonthlySpendStore } from "../src/budget-extension.ts";
import type { Model } from "@earendil-works/pi-ai";

// Build a full pi.dev Model<any> for fixtures. AvailableModelEntry.model is typed
// as Model<any> (mirrors pi.setModel's signature), so test fixtures must supply a
// complete model object. Only id/provider matter for these tests; the rest are
// structural filler. Single cast point keeps the fixtures honest.
function fakeModel(id: string, provider: string): Model<any> {
  return {
    id,
    provider,
    name: id,
    api: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  } as unknown as Model<any>;
}

// ---------------------------------------------------------------------------
// Fake MonthlySpendStore
// ---------------------------------------------------------------------------

function makeFakeStore(monthlySpend = 0): MonthlySpendStore {
  return {
    accumulate: vi.fn(),
    getSpend: vi.fn().mockReturnValue(monthlySpend),
    getSpendOrThrow: vi.fn().mockReturnValue(monthlySpend),
  };
}

// ---------------------------------------------------------------------------
// Available models test fixture
// ---------------------------------------------------------------------------

const fakeAvailableModels: AvailableModelEntry[] = [
  {
    model: fakeModel("claude-haiku-4-5-20251001", "anthropic"),
    thinkingLevel: "low",
    modelId: "claude-haiku-4-5-20251001",
    label: "Haiku (fast and cheap)",
  },
  {
    model: fakeModel("claude-sonnet-4-6", "anthropic"),
    thinkingLevel: "medium",
    modelId: "claude-sonnet-4-6",
    label: "Sonnet (default, balance)",
  },
  {
    model: fakeModel("claude-opus-4-7", "anthropic"),
    thinkingLevel: "high",
    modelId: "claude-opus-4-7",
    label: "Opus (deep reasoning)",
  },
];

// ---------------------------------------------------------------------------
// Fake pi ExtensionAPI — captures registerCommand handlers + sendMessage output
// ---------------------------------------------------------------------------

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function makeFakeApi(opts?: {
  /** Thinking level returned by getThinkingLevel(). */
  currentThinkingLevel?: string;
  /** true (default) = setModel resolves true; false = resolves false (missing creds) */
  setModelSuccess?: boolean;
}): {
  api: {
    on: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
    getCommands: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    getThinkingLevel: ReturnType<typeof vi.fn>;
    commands: Map<string, { handler: CommandHandler; description: string }>;
    messages: Array<{ customType: string; content: unknown; details?: unknown }>;
    [key: string]: unknown;
  };
} {
  const {
    currentThinkingLevel = "low",
    setModelSuccess = true,
  } = opts ?? {};

  const commands = new Map<string, { handler: CommandHandler; description: string }>();
  const messages: Array<{ customType: string; content: unknown; details?: unknown }> = [];

  // Capture model_select handlers registered via pi.on("model_select", ...).
  // The real ExtensionAPI fires this event whenever a new model is selected,
  // including from setModel() (source: "set"). It does NOT expose getCurrentModel.
  type ModelSelectHandler = (
    event: { type: "model_select"; model: { id: string } },
  ) => void | Promise<void>;
  const modelSelectHandlers: ModelSelectHandler[] = [];

  const api = {
    commands,
    messages,
    on: vi.fn((event: string, handler: ModelSelectHandler) => {
      if (event === "model_select") modelSelectHandlers.push(handler);
    }),
    sendMessage: vi.fn(
      (msg: { customType: string; content: unknown; details?: unknown }) => {
        messages.push(msg);
      },
    ),
    registerCommand: vi.fn(
      (
        name: string,
        opts2: { description: string; handler: CommandHandler },
      ) => {
        commands.set(name, { handler: opts2.handler, description: opts2.description });
      },
    ),
    getCommands: vi.fn().mockReturnValue([
      { name: "model", description: "Switch or list available models" },
      { name: "memory", description: "Show agent MEMORY.md contents" },
      { name: "status", description: "Show agent status" },
      { name: "help", description: "List available slash commands" },
    ]),
    // setModel is async per pi.dev SDK contract (returns Promise<boolean>).
    // On success it fires the model_select event (source: "set"), mirroring the
    // real SDK, so the extension can track the active model id.
    setModel: vi.fn(async (model: { id: string }) => {
      if (setModelSuccess) {
        for (const h of modelSelectHandlers) {
          await h({ type: "model_select", model: { id: model.id } });
        }
      }
      return setModelSuccess;
    }),
    getThinkingLevel: vi.fn().mockReturnValue(currentThinkingLevel),
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
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  };

  return { api };
}

// Helper: invoke a registered command by name, return the first sendMessage content
async function invokeCommand(
  api: ReturnType<typeof makeFakeApi>["api"],
  name: string,
  args = "",
  ctx: unknown = {},
): Promise<string> {
  const cmd = api.commands.get(name);
  if (!cmd) throw new Error(`Command "${name}" not registered`);
  const beforeCount = api.messages.length;
  await cmd.handler(args, ctx);
  // Return concatenation of all newly-sent message contents
  const newMessages = api.messages.slice(beforeCount);
  return newMessages.map((m) => String(m.content)).join("\n");
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

async function makeFicha(
  memoryContent?: string | null,
  profileYaml?: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-cmd-ext-"));
  const profile = profileYaml ?? `
agent:
  id: test-001
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim();
  await writeFile(join(dir, "profile.yaml"), profile, "utf8");
  await writeFile(join(dir, "SOUL.md"), "# Agent\nTest soul.", "utf8");
  await writeFile(
    join(dir, "POLICIES.md"),
    "# Policies\n## Trivial\nTools: test_read\n",
    "utf8",
  );

  if (memoryContent === null) {
    // Do not create the file at all
  } else if (memoryContent === "") {
    await writeFile(join(dir, "MEMORY.md"), "", "utf8");
  } else {
    await writeFile(
      join(dir, "MEMORY.md"),
      memoryContent ?? "# Memory\nSome context",
      "utf8",
    );
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Tests: /model command (SPEC-CMD-1)
// ---------------------------------------------------------------------------

describe("createControlCommandsExtension — /model command (SPEC-CMD-1)", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  it("SPEC-CMD-1-A: /model no-args lists all 3 models and marks first as active", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi();
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "model", "");

    // All 3 model labels should appear
    expect(output).toContain("Haiku");
    expect(output).toContain("Sonnet");
    expect(output).toContain("Opus");
    // Active marker should mark the haiku entry
    expect(output.toLowerCase()).toContain("[active]");
    // The active model id should appear
    expect(output).toContain("claude-haiku-4-5-20251001");
  });

  it("SPEC-CMD-1-B: /model <arg> fuzzy-matches by label and calls pi.setModel", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi({ setModelSuccess: true });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "model", "opus");

    // setModel must be called with the Opus model object
    expect(api.setModel).toHaveBeenCalledTimes(1);
    expect(api.setModel).toHaveBeenCalledWith(fakeAvailableModels[2]!.model);
    // Output confirms the switch
    expect(output).toContain("claude-opus-4-7");
  });

  it("SPEC-CMD-1-B: /model <arg> fuzzy-matches by modelId", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi({ setModelSuccess: true });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "model", "sonnet-4-6");

    expect(api.setModel).toHaveBeenCalledTimes(1);
    expect(api.setModel).toHaveBeenCalledWith(fakeAvailableModels[1]!.model);
    expect(output).toContain("claude-sonnet-4-6");
  });

  it("SPEC-CMD-1-C: /model <no-match> does NOT call setModel and lists available models", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi();
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "model", "gpt-99-turbo");

    expect(api.setModel).not.toHaveBeenCalled();
    expect(output.toLowerCase()).toContain("no match");
    expect(output).toContain("Haiku");
    expect(output).toContain("Sonnet");
  });

  it("SPEC-CMD-1-D: /model valid match but setModel returns false → error reported, no crash", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi({ setModelSuccess: false });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "model", "opus");

    // setModel was called
    expect(api.setModel).toHaveBeenCalledTimes(1);
    // Output should describe the error — no exception thrown
    expect(output.toLowerCase()).toMatch(/error|missing|api key|credential|fail/);
  });

  it("SPEC-CMD-1-A (verify WARNING-1): active model tracks model_select after a switch", async () => {
    // Regression for the stale-active-model bug: the extension must track the
    // active model via the real ExtensionAPI `model_select` event, NOT a
    // non-existent getCurrentModel(). The fake api here deliberately exposes NO
    // getCurrentModel — setModel fires model_select (source "set") like the SDK.
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi({ setModelSuccess: true });
    // Sanity: the real ExtensionAPI has no getCurrentModel — neither must our fake.
    expect(api["getCurrentModel"]).toBeUndefined();

    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    // Before any switch, /model marks entry[0] (haiku) as active.
    const before = await invokeCommand(api, "model", "");
    const haikuLine = before
      .split("\n")
      .find((l) => l.includes("claude-haiku-4-5-20251001"));
    expect(haikuLine).toContain("[active]");

    // Switch to opus — this fires model_select on the real SDK.
    await invokeCommand(api, "model", "opus");

    // A subsequent /model (no-args) must mark OPUS active, not entry[0].
    const after = await invokeCommand(api, "model", "");
    const opusLine = after
      .split("\n")
      .find((l) => l.includes("claude-opus-4-7"));
    const haikuLineAfter = after
      .split("\n")
      .find((l) => l.includes("claude-haiku-4-5-20251001"));
    expect(opusLine).toContain("[active]");
    expect(haikuLineAfter).not.toContain("[active]");
  });

  it("SPEC-CMD-3 (verify WARNING-1): /status reports the switched model as active", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi({ setModelSuccess: true });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    await invokeCommand(api, "model", "opus");

    const status = await invokeCommand(api, "status", "");
    // Active model line must show opus, not the entry[0] default (haiku).
    expect(status).toContain("claude-opus-4-7");
    expect(status).not.toContain("claude-haiku-4-5-20251001");
  });
});

// ---------------------------------------------------------------------------
// Tests: /memory command (SPEC-CMD-2)
// ---------------------------------------------------------------------------

describe("createControlCommandsExtension — /memory command (SPEC-CMD-2)", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  it("SPEC-CMD-2-A: /memory when MEMORY.md exists with content returns content", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi();
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "memory", "");

    expect(output).toContain("# Memory");
    expect(output).toContain("Some context");
  });

  it("SPEC-CMD-2-B: /memory when MEMORY.md is empty returns (MEMORY.md is empty)", async () => {
    const fichaDir = await makeFicha("");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi();
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "memory", "");

    expect(output).toBe("(MEMORY.md is empty)");
  });

  it("SPEC-CMD-2-C: /memory when MEMORY.md does not exist returns (MEMORY.md not found)", async () => {
    const fichaDir = await makeFicha(null);
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi();
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "memory", "");

    expect(output).toBe("(MEMORY.md not found)");
  });
});

// ---------------------------------------------------------------------------
// Tests: /status command (SPEC-CMD-3)
// ---------------------------------------------------------------------------

describe("createControlCommandsExtension — /status command (SPEC-CMD-3)", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  it("SPEC-CMD-3-A: /status full output with budget declared", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const store = makeFakeStore(8.0); // 8.00 of 10.00 = 80%
    const { api } = makeFakeApi({ currentThinkingLevel: "medium" });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "fin-001",
      budgetUsd: 10,
      store,
    });
    factory(api as never);

    // Switch to sonnet so /status reports the active (switched) model, not entry[0].
    await invokeCommand(api, "model", "sonnet");

    const output = await invokeCommand(api, "status", "");

    expect(output).toContain("fin-001");
    expect(output).toContain("claude-sonnet-4-6");
    expect(output).toContain("medium");
    expect(output).toContain("$8.00");
    expect(output).toContain("$10.00");
    expect(output).toContain("80.0%");
  });

  it("SPEC-CMD-3-B: /status free model shows (free model and (not set) for budget", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const store = makeFakeStore(0);
    const { api } = makeFakeApi({ currentThinkingLevel: "off" });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: [
        {
          model: fakeModel("llama3.1:70b", "ollama"),
          thinkingLevel: "off",
          modelId: "llama3.1:70b",
          label: "Llama local (no cost)",
        },
      ],
      agentId: "local-agent",
      // No budgetUsd → budget absent
      store,
    });
    factory(api as never);

    const output = await invokeCommand(api, "status", "");

    expect(output).toContain("$0.00");
    expect(output).toContain("(not set)");
    expect(output.toLowerCase()).toContain("(free model");
  });

  it("SPEC-CMD-3-C: /status no budget declared shows (not set) for budget", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const store = makeFakeStore(0);
    const { api } = makeFakeApi({ currentThinkingLevel: "medium" });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "fin-001",
      // No budgetUsd
      store,
    });
    factory(api as never);

    const output = await invokeCommand(api, "status", "");

    expect(output).toContain("fin-001");
    expect(output).toContain("(not set)");
  });

  it("SPEC-CMD-3 (degraded): /status gracefully degrades when store is absent", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi({ currentThinkingLevel: "medium" });
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "fin-001",
      budgetUsd: 10,
      // No store
    });
    factory(api as never);

    // Must not throw
    const output = await invokeCommand(api, "status", "");

    expect(output).toContain("fin-001");
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: /help command (SPEC-CMD-4)
// ---------------------------------------------------------------------------

describe("createControlCommandsExtension — /help command (SPEC-CMD-4)", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  it("SPEC-CMD-4-A: /help lists all commands returned by pi.getCommands()", async () => {
    const fichaDir = await makeFicha("# Memory\nSome context");
    createdDirs.push(fichaDir);

    const { api } = makeFakeApi();
    const factory = createControlCommandsExtension({
      fichaDir,
      availableModels: fakeAvailableModels,
      agentId: "test-001",
    });
    factory(api as never);

    const output = await invokeCommand(api, "help", "");

    expect(api.getCommands).toHaveBeenCalled();
    expect(output).toContain("/model");
    expect(output).toContain("/memory");
    expect(output).toContain("/status");
    expect(output).toContain("/help");
  });
});

// ---------------------------------------------------------------------------
// Tests: createZiaAgent — control commands extension wiring (SPEC-EXT-1-A/B)
// ---------------------------------------------------------------------------

describe("createZiaAgent — control commands extension wiring (SPEC-EXT-1)", () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    capturedExtensionFactories.length = 0;
    vi.clearAllMocks();
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
    const dir = await mkdtemp(join(tmpdir(), "zia-cmd-ext-wiring-"));
    await writeFile(join(dir, "profile.yaml"), profileYaml, "utf8");
    await writeFile(join(dir, "SOUL.md"), "# Agent\nTest soul.", "utf8");
    await writeFile(
      join(dir, "POLICIES.md"),
      "# Policies\n## Trivial\nTools: test_read\n",
      "utf8",
    );
    createdDirs.push(dir);
    return dir;
  }

  // Invoke the createRuntime factory so extensionFactories get captured
  async function invokeFactoryAndCreate(
    fichaDir: string,
    agentOpts: Parameters<typeof createZiaAgent>[0],
  ): Promise<void> {
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
    await createZiaAgent(agentOpts);
  }

  it("SPEC-EXT-1-A: both budget and control-commands extensions injected when budget declared", async () => {
    const fichaDir = await fixture(`
agent:
  id: test-001
llm:
  monthly_budget_usd: 10
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim());

    const store = makeFakeStore(0);
    await invokeFactoryAndCreate(fichaDir, {
      fichaDir,
      rawTools: [],
      monthlySpendStore: store,
    });

    const allFactories = capturedExtensionFactories.flat();
    // Must have at least 2: budget extension + control-commands extension
    expect(allFactories.length).toBeGreaterThanOrEqual(2);
  });

  it("SPEC-EXT-1-B: control-commands extension injected even without budget/store", async () => {
    const fichaDir = await fixture(`
agent:
  id: test-001
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim());

    await invokeFactoryAndCreate(fichaDir, {
      fichaDir,
      rawTools: [],
      // No monthlySpendStore → budget extension absent
    });

    const allFactories = capturedExtensionFactories.flat();
    // Must have at least 1: control-commands extension
    expect(allFactories.length).toBeGreaterThanOrEqual(1);
  });
});
