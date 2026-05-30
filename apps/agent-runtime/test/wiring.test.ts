/**
 * wiring.test.ts — B.5, SPEC-F4-8
 *
 * Integration-level wiring assertions for tui.ts:
 *  - Module-graph: @zia/core imports messagePersistExtension (via mock inspection).
 *  - Behavioral: tui.ts composition root calls createBuiltinTools + passes
 *    extensionFactories containing the messagePersistExtension factory.
 *  - Behavioral: rawTools contains MCP tools spread with builtinTools.
 *  - Behavioral: messagePersistExtension is called with the SqliteMessageStore instance
 *    and a sessionKey derived from the fichaDir basename.
 *
 * Strategy: mock all workspace packages (same pattern as tui-lifecycle.test.ts),
 * dynamically import tui.ts under the mocks, then assert on call arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @zia/tools — expose createMcpAdapter + createBuiltinTools
// ---------------------------------------------------------------------------

const mockDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockMcpTools = [{ name: "mcp_tool_1" }];
const mockBuiltinTools = [{ name: "read" }, { name: "bash" }];

const mockHandle = {
  tools: mockMcpTools,
  servers: [],
  dispose: mockDispose,
};

const mockCreateMcpAdapter = vi.fn<(fichaDir: string) => Promise<typeof mockHandle>>()
  .mockResolvedValue(mockHandle);

const mockCreateBuiltinTools = vi.fn<(cwd: string, searchFn?: unknown) => typeof mockBuiltinTools>()
  .mockReturnValue(mockBuiltinTools);

vi.mock("@zia/tools", () => ({
  createMcpAdapter: mockCreateMcpAdapter,
  createBuiltinTools: mockCreateBuiltinTools,
}));

// ---------------------------------------------------------------------------
// Mock @zia/core — expose runZiaAgentTui + messagePersistExtension
// ---------------------------------------------------------------------------

const mockRunZiaAgentTui = vi.fn<(opts: Record<string, unknown>) => Promise<void>>()
  .mockResolvedValue(undefined);

/** Capture the factory returned by messagePersistExtension for inspection */
const mockExtensionFactory = vi.fn().mockReturnValue(undefined);
const mockMessagePersistExtension = vi.fn<
  (sink: unknown, sessionKey: string) => typeof mockExtensionFactory
>().mockReturnValue(mockExtensionFactory);

vi.mock("@zia/core", () => ({
  runZiaAgentTui: mockRunZiaAgentTui,
  messagePersistExtension: mockMessagePersistExtension,
}));

// ---------------------------------------------------------------------------
// Mock @zia/persistence — expose openDatabase + SqliteAuditLog + SqliteMessageStore
// ---------------------------------------------------------------------------

const mockDbClose = vi.fn();
const mockMessageStore = { search: vi.fn().mockReturnValue([]), record: vi.fn() };
const mockAuditLog = {};

const mockOpenDatabase = vi.fn().mockReturnValue({ close: mockDbClose });

vi.mock("@zia/persistence", () => ({
  openDatabase: mockOpenDatabase,
  SqliteAuditLog: vi.fn().mockImplementation(() => mockAuditLog),
  SqliteMessageStore: vi.fn().mockImplementation(() => mockMessageStore),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tui.ts composition root wiring (B.5, SPEC-F4-8)", () => {
  let originalArgv: string[];
  let originalExit: typeof process.exit;
  const exitMock = vi.fn<(code?: number) => never>();

  beforeEach(() => {
    originalArgv = process.argv;
    originalExit = process.exit;
    process.exit = exitMock as unknown as typeof process.exit;
    process.stderr.write = vi.fn() as typeof process.stderr.write;

    exitMock.mockClear();
    mockDispose.mockClear();
    mockCreateMcpAdapter.mockClear();
    mockCreateBuiltinTools.mockClear();
    mockRunZiaAgentTui.mockClear();
    mockMessagePersistExtension.mockClear();
    mockExtensionFactory.mockClear();
    mockDbClose.mockClear();
    mockOpenDatabase.mockClear();
    mockMessageStore.search.mockClear();
    mockMessageStore.record.mockClear();

    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.resetModules();
  });

  it("calls createBuiltinTools with fichaDir and a searchFn closure", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    expect(mockCreateBuiltinTools).toHaveBeenCalledOnce();
    const [cwd, opts] = mockCreateBuiltinTools.mock.calls[0]! as [
      string,
      { searchFn?: unknown },
    ];
    expect(typeof cwd).toBe("string");
    expect(cwd).toContain("agents/_template");
    // searchFn (in the options object) must be a function (closure over messageStore.search)
    expect(typeof opts.searchFn).toBe("function");
  });

  it("calls messagePersistExtension with the SqliteMessageStore and a sessionKey", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    expect(mockMessagePersistExtension).toHaveBeenCalledOnce();
    const [sink, sessionKey] = mockMessagePersistExtension.mock.calls[0]!;
    // sink must be the SqliteMessageStore instance
    expect(sink).toBe(mockMessageStore);
    // sessionKey is derived from the fichaDir basename
    expect(typeof sessionKey).toBe("string");
    expect(sessionKey).toMatch(/tui:/);
    expect(sessionKey).toContain("_template");
  });

  it("passes extensionFactories array containing the messagePersistExtension factory to runZiaAgentTui", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    expect(mockRunZiaAgentTui).toHaveBeenCalledOnce();
    const opts = mockRunZiaAgentTui.mock.calls[0]![0] as Record<string, unknown>;
    const factories = opts["extensionFactories"] as unknown[];
    expect(Array.isArray(factories)).toBe(true);
    // The returned factory from messagePersistExtension must be present
    expect(factories).toContain(mockExtensionFactory);
  });

  it("spreads both MCP tools and builtin tools into rawTools", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    const opts = mockRunZiaAgentTui.mock.calls[0]![0] as Record<string, unknown>;
    const rawTools = opts["rawTools"] as unknown[];
    expect(Array.isArray(rawTools)).toBe(true);
    // rawTools must contain all mockMcpTools entries AND all mockBuiltinTools entries
    for (const t of mockMcpTools) {
      expect(rawTools).toContain(t);
    }
    for (const t of mockBuiltinTools) {
      expect(rawTools).toContain(t);
    }
  });

  it("searchFn closure delegates to messageStore.search", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];
    mockMessageStore.search.mockReturnValueOnce([{ role: "user", content: "hit", timestamp: "t", toolName: null }]);

    await import("../src/tui.ts");

    const [, opts] = mockCreateBuiltinTools.mock.calls[0]! as [
      string,
      { searchFn: (q: string, lim?: number) => unknown[] },
    ];
    const results = opts.searchFn("invoice", 5);
    expect(mockMessageStore.search).toHaveBeenCalledWith("invoice", 5);
    expect(results).toHaveLength(1);
  });
});
