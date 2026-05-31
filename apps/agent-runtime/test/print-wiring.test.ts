/**
 * print-wiring.test.ts — SPEC-EXT-2 (print.ts composition root)
 *
 * Parity with wiring.test.ts (tui.ts) for the non-interactive print entry point,
 * which is the cron/webhook path. Asserts the F-CORE-8 budget wiring:
 *  - print.ts calls createMonthlySpendStore(db) from the same db as the audit log.
 *  - the resulting store is forwarded into runZiaAgentPrint (SPEC-EXT-2).
 *
 * Strategy: mock workspace packages, dynamically import print.ts under the mocks
 * with argv = [node, print.ts, <fichaDir>, <prompt>], then assert on call args.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @zia/tools
// ---------------------------------------------------------------------------

const mockDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockMcpTools = [{ name: "mcp_tool_1" }];
const mockBuiltinTools = [{ name: "read" }];

const mockHandle = { tools: mockMcpTools, servers: [], dispose: mockDispose };

const mockCreateMcpAdapter = vi.fn<(fichaDir: string) => Promise<typeof mockHandle>>()
  .mockResolvedValue(mockHandle);
const mockCreateBuiltinTools = vi.fn<(cwd: string, opts?: unknown) => typeof mockBuiltinTools>()
  .mockReturnValue(mockBuiltinTools);

vi.mock("@zia/tools", () => ({
  createMcpAdapter: mockCreateMcpAdapter,
  createBuiltinTools: mockCreateBuiltinTools,
}));

// ---------------------------------------------------------------------------
// Mock @zia/core — runZiaAgentPrint + messagePersistExtension
// ---------------------------------------------------------------------------

const mockRunZiaAgentPrint = vi.fn<(opts: Record<string, unknown>) => Promise<number>>()
  .mockResolvedValue(0);
const mockExtensionFactory = vi.fn().mockReturnValue(undefined);
const mockMessagePersistExtension = vi.fn<
  (sink: unknown, sessionKey: string) => typeof mockExtensionFactory
>().mockReturnValue(mockExtensionFactory);

vi.mock("@zia/core", () => ({
  runZiaAgentPrint: mockRunZiaAgentPrint,
  messagePersistExtension: mockMessagePersistExtension,
}));

// ---------------------------------------------------------------------------
// Mock @zia/persistence — including the F-CORE-8 budget store
// ---------------------------------------------------------------------------

const mockDbClose = vi.fn();
const mockMessageStore = { search: vi.fn().mockReturnValue([]), record: vi.fn() };
const mockOpenDatabase = vi.fn().mockReturnValue({ close: mockDbClose });

const mockMonthlySpendStore = {
  accumulate: vi.fn(),
  getSpend: vi.fn().mockReturnValue(0),
  getSpendOrThrow: vi.fn().mockReturnValue(0),
};
const mockCreateMonthlySpendStore = vi.fn().mockReturnValue(mockMonthlySpendStore);

vi.mock("@zia/persistence", () => ({
  openDatabase: mockOpenDatabase,
  SqliteAuditLog: vi.fn().mockImplementation(() => ({})),
  SqliteMessageStore: vi.fn().mockImplementation(() => mockMessageStore),
  createMonthlySpendStore: mockCreateMonthlySpendStore,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("print.ts composition root wiring (SPEC-EXT-2)", () => {
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
    mockRunZiaAgentPrint.mockClear();
    mockMessagePersistExtension.mockClear();
    mockExtensionFactory.mockClear();
    mockDbClose.mockClear();
    mockOpenDatabase.mockClear();
    mockCreateMonthlySpendStore.mockClear();

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

  it("creates the monthly spend store and forwards it to runZiaAgentPrint (SPEC-EXT-2)", async () => {
    process.argv = ["node", "print.ts", "agents/_template", "do a thing"];

    await import("../src/print.ts");

    expect(mockCreateMonthlySpendStore).toHaveBeenCalledOnce();
    expect(mockRunZiaAgentPrint).toHaveBeenCalledOnce();
    const opts = mockRunZiaAgentPrint.mock.calls[0]![0] as Record<string, unknown>;
    // The exact store instance must reach the print runner.
    expect(opts["monthlySpendStore"]).toBe(mockMonthlySpendStore);
    // And the prompt + fichaDir are forwarded.
    expect(opts["prompt"]).toBe("do a thing");
    expect(typeof opts["fichaDir"]).toBe("string");
  });
});
