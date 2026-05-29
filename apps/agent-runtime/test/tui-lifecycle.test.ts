/**
 * tui-lifecycle.test.ts — T-17 lifecycle wiring for MCP adapter in the TUI entry point.
 *
 * Verifies:
 * - createMcpAdapter is called with the resolved fichaDir before runZiaAgentTui.
 * - handle.tools is passed as rawTools to runZiaAgentTui.
 * - handle.dispose() is called in the finally block (normal exit).
 * - handle.dispose() is called in the finally block (error exit).
 * - SIGTERM handler calls handle.dispose() and exits 0.
 * - SIGINT handler calls handle.dispose() and exits 0.
 *
 * The test imports the wired tui.ts via a dynamic import AFTER mocks are set up,
 * so the module-level `await main()` runs under our mocks.
 * We reset module registries between tests to avoid state bleed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @zia/tools
// ---------------------------------------------------------------------------

const mockDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockTools: unknown[] = [];

const mockHandle = {
  tools: mockTools,
  servers: [],
  dispose: mockDispose,
};

const mockCreateMcpAdapter = vi.fn<(fichaDir: string) => Promise<typeof mockHandle>>()
  .mockResolvedValue(mockHandle);

vi.mock("@zia/tools", () => ({
  createMcpAdapter: mockCreateMcpAdapter,
}));

// ---------------------------------------------------------------------------
// Mock @zia/core
// ---------------------------------------------------------------------------

const mockRunZiaAgentTui = vi.fn<(opts: Record<string, unknown>) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock("@zia/core", () => ({
  runZiaAgentTui: mockRunZiaAgentTui,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tui.ts MCP adapter lifecycle wiring (T-17)", () => {
  let originalArgv: string[];
  let originalExit: typeof process.exit;
  let originalStderr: typeof process.stderr.write;
  const exitMock = vi.fn<(code?: number) => never>();

  beforeEach(() => {
    originalArgv = process.argv;
    originalExit = process.exit;
    originalStderr = process.stderr.write.bind(process.stderr);

    // Stub stderr to suppress output noise in test runner
    process.stderr.write = vi.fn() as typeof process.stderr.write;

    // Stub process.exit so tests don't abort the runner
    process.exit = exitMock as unknown as typeof process.exit;

    exitMock.mockClear();
    mockDispose.mockClear();
    mockCreateMcpAdapter.mockClear();
    mockRunZiaAgentTui.mockClear();

    // Remove SIGTERM/SIGINT listeners added by previous test runs
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.stderr.write = originalStderr;
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.resetModules();
  });

  it("calls createMcpAdapter with fichaDir and passes tools as rawTools", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    // Dynamically import so module-level `await main()` runs now
    await import("../src/tui.ts");

    expect(mockCreateMcpAdapter).toHaveBeenCalledOnce();
    const fichaArg = mockCreateMcpAdapter.mock.calls[0]?.[0];
    expect(fichaArg).toContain("agents/_template");

    expect(mockRunZiaAgentTui).toHaveBeenCalledOnce();
    const runOpts = mockRunZiaAgentTui.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(runOpts["rawTools"]).toBe(mockTools);
    expect(runOpts["fichaDir"]).toContain("agents/_template");
  });

  it("calls handle.dispose() in the finally block after runZiaAgentTui resolves", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    expect(mockDispose).toHaveBeenCalledOnce();
  });

  it("calls handle.dispose() in the finally block even when runZiaAgentTui rejects", async () => {
    mockRunZiaAgentTui.mockRejectedValueOnce(new Error("agent crash"));
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    // dispose must be called despite the error
    expect(mockDispose).toHaveBeenCalledOnce();
    // process.exit(1) should have been called for the error path
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("missing fichaDir arg prints usage and exits 1 without calling createMcpAdapter", async () => {
    process.argv = ["node", "tui.ts"]; // no ficha arg

    await import("../src/tui.ts");

    expect(mockCreateMcpAdapter).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("SIGTERM handler calls dispose() and exits 0", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    // Clear counts from the normal run
    mockDispose.mockClear();
    exitMock.mockClear();

    // Trigger SIGTERM
    process.emit("SIGTERM");
    // Dispose is async; wait for the microtask queue
    await Promise.resolve();
    await Promise.resolve();

    expect(mockDispose).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("SIGINT handler calls dispose() and exits 0", async () => {
    process.argv = ["node", "tui.ts", "agents/_template"];

    await import("../src/tui.ts");

    mockDispose.mockClear();
    exitMock.mockClear();

    process.emit("SIGINT");
    await Promise.resolve();
    await Promise.resolve();

    expect(mockDispose).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);
  });
});
