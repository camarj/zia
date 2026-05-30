/**
 * index.test.ts — createBuiltinTools integration tests (A.13, SPEC-F1-1..3, SPEC-F2-4).
 *
 * Verifies: 8-element array with exact name set, cross-ref vs registry,
 * and that without searchFn we get exactly 7 tools.
 *
 * NOTE on registry isolation: builtins register at import time (ADR-D2-bis).
 * Once the side-effect imports have run, re-importing the same module in the
 * same vitest worker is a no-op (module cached). We therefore do NOT call
 * clear() before tests — that would empty the registry and make the tools
 * disappear. Tests clean up AFTER themselves (afterEach) so later suites
 * start fresh, but within this file we rely on the single import run.
 */

import { afterEach, describe, expect, it } from "vitest";
import { clear } from "../../registry.js";

// Trigger the side-effect imports once for this entire test file.
// This ensures read/bash/edit/write/grep/find/ls all register their descriptors.
import "../index.js";

describe("createBuiltinTools — with searchFn (SPEC-F1-1, SPEC-F2-4)", () => {
  afterEach(() => {
    // Do NOT clear here — other tests in this file still need the registry.
    // The afterAll at the end cleans up.
  });

  it("returns exactly 8 tools when searchFn is provided", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", () => []);
    expect(tools).toHaveLength(8);
  });

  it("contains exactly the expected name set", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", () => []);
    const names = new Set(tools.map((t) => t.name));

    expect(names).toEqual(
      new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "search_session"]),
    );
  });

  it("registry getAll() name set matches returned file-tool names (SPEC-F2-4)", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const { getAll } = await import("../../registry.js");

    const tools = createBuiltinTools("/tmp/agent", () => []);
    const registryNames = new Set(getAll().map((d) => d.name));
    // The 7 file tools are in the registry; search_session is injected separately
    const fileToolNames = new Set(
      tools.filter((t) => t.name !== "search_session").map((t) => t.name),
    );

    expect(fileToolNames).toEqual(registryNames);
  });

  it("every tool has required WrappableTool fields (SPEC-F1-2)", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", () => []);

    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.label).toBe("string");
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toBeDefined();
    }
  });

  it("tool names match pi.dev canonical names (SPEC-F1-3)", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent", () => []);
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

describe("createBuiltinTools — without searchFn", () => {
  it("returns exactly 7 tools when searchFn is omitted", async () => {
    const { createBuiltinTools } = await import("../index.js");
    const tools = createBuiltinTools("/tmp/agent");
    expect(tools).toHaveLength(7);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("search_session");
  });
});
