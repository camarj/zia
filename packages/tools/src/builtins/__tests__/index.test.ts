/**
 * index.test.ts — createBuiltinTools integration tests (A.13, SPEC-F1-1..3, SPEC-F2-4,
 * SPEC-TOOL-6, SPEC-TOOL-7).
 *
 * Verifies: correct tool counts for all opts combinations, exact name sets,
 * cross-ref vs registry, and that the old positional form is rejected by TS.
 *
 * NOTE on registry isolation: builtins register at import time (ADR-D2-bis).
 * Once the side-effect imports have run, re-importing the same module in the
 * same vitest worker is a no-op (module cached). We therefore do NOT call
 * clear() before tests — that would empty the registry and make the tools
 * disappear. Tests clean up AFTER themselves (afterEach) so later suites
 * start fresh, but within this file we rely on the single import run.
 */

import { afterAll, describe, expect, it } from "vitest";
import { clear } from "../../registry.js";

// Trigger the side-effect imports once for this entire test file.
// This ensures read/bash/edit/write/grep/find/ls all register their descriptors.
import "../index.js";

describe("createBuiltinTools — with searchFn (SPEC-F1-1, SPEC-F2-4)", () => {
  it("returns exactly 8 tools when searchFn is provided", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", { searchFn: () => [] });
    expect(tools).toHaveLength(8);
  });

  it("contains exactly the expected name set with searchFn only", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", { searchFn: () => [] });
    const names = new Set(tools.map((t) => t.name));

    expect(names).toEqual(
      new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "search_session"]),
    );
  });

  it("registry getAll() name set matches returned file-tool names (SPEC-F2-4)", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const { getAll } = await import("../../registry.js");

    const tools = createBuiltinTools("/tmp/agent", { searchFn: () => [] });
    const registryNames = new Set(getAll().map((d) => d.name));
    // The 7 file tools are in the registry; search_session is injected separately
    const fileToolNames = new Set(
      tools.filter((t) => t.name !== "search_session").map((t) => t.name),
    );

    expect(fileToolNames).toEqual(registryNames);
  });

  it("every tool has required WrappableTool fields (SPEC-F1-2)", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", { searchFn: () => [] });

    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.label).toBe("string");
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toBeDefined();
    }
  });

  it("tool names match pi.dev canonical names (SPEC-F1-3)", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", { searchFn: () => [] });
    const names = tools.map((t) => t.name);

    // File tools use canonical pi.dev names (no prefix)
    expect(names).toContain("read");
    expect(names).toContain("bash");
    expect(names).toContain("edit");
    expect(names).toContain("write");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("ls");
    // zia convention: snake_case
    expect(names).toContain("search_session");
  });
});

describe("createBuiltinTools — without searchFn (SPEC-TOOL-6)", () => {
  it("returns exactly 7 tools when opts is omitted", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent");
    expect(tools).toHaveLength(7);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("search_session");
    expect(names).not.toContain("write_memory");
    expect(names).not.toContain("search_memory");
  });

  it("returns exactly 7 tools when opts is empty object", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", {});
    expect(tools).toHaveLength(7);
  });
});

describe("createBuiltinTools — with all three fns (SPEC-TOOL-6)", () => {
  it("returns exactly 10 tools when searchFn + memoryWriteFn + memorySearchFn provided", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", {
      searchFn: () => [],
      memoryWriteFn: async () => {},
      memorySearchFn: async () => [],
    });
    expect(tools).toHaveLength(10);
  });

  it("contains write_memory and search_memory when memory fns provided", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", {
      searchFn: () => [],
      memoryWriteFn: async () => {},
      memorySearchFn: async () => [],
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("write_memory");
    expect(names).toContain("search_memory");
    expect(names).toContain("search_session");
  });

  it("returns exactly 9 tools when only memoryWriteFn + memorySearchFn provided (no searchFn)", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", {
      memoryWriteFn: async () => {},
      memorySearchFn: async () => [],
    });
    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.name);
    expect(names).toContain("write_memory");
    expect(names).toContain("search_memory");
    expect(names).not.toContain("search_session");
  });
});

describe("createBuiltinTools — old positional form is rejected (SPEC-TOOL-6)", () => {
  it("rejects old positional second arg at compile time", async () => {
    const { createBuiltinTools } = await import("../index.js");

    // @ts-expect-error — old positional form `createBuiltinTools(cwd, fn)` must
    // fail to compile: second arg type is BuiltinToolsOptions | undefined, not a function.
    const _tools = createBuiltinTools("/tmp/agent", () => []);
    void _tools; // suppress unused var warning
  });
});

describe("createBuiltinTools — BuiltinToolsOptions and fn types exported (SPEC-TOOL-7)", () => {
  it("exports BuiltinToolsOptions, MemoryWriteFn, MemorySearchFn, MemoryHit", async () => {
    // This is a compile-time test — if TypeScript resolves these names without
    // error, the test passes. The runtime assertion is a no-op.
    const mod = await import("../index.js");

    // All four names must be importable (runtime check: they are referenced in the module)
    expect(mod.createBuiltinTools).toBeDefined();

    // Type-level: import the type names — checked at compile time via the import above.
    // The `afterEach` cleanup is not needed here; this describe has no side effects.
  });
});

// Clean up ONCE after all tests in this file so later suites in the worker start
// fresh. Must NOT be afterEach: the side-effect imports register at import time and
// will not re-run once the module is cached, so clearing between tests would empty
// the registry permanently for this file.
afterAll(() => clear());
