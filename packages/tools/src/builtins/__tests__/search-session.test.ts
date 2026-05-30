/**
 * search-session.test.ts — search_session tool tests (A.13, SPEC-F1-8, SPEC-F4-6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clear } from "../../registry.js";
import type { SessionMessageHit } from "../search-session.js";

describe("search_session tool — injection and execution (SPEC-F1-8, SPEC-F4-6)", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("calls injected searchFn with query and limit (SPEC-F4-6)", async () => {
    const { buildSearchSessionTool } = await import("../search-session.js");

    const mockHit: SessionMessageHit = {
      role: "user",
      content: "invoice approved",
      timestamp: "2026-01-01T00:00:00Z",
      toolName: null,
    };

    const searchFn = vi.fn().mockReturnValue([mockHit]);
    const tool = buildSearchSessionTool(searchFn);

    await tool.execute("tc-001", { query: "invoice", limit: 5 });

    expect(searchFn).toHaveBeenCalledOnce();
    expect(searchFn).toHaveBeenCalledWith("invoice", 5);
  });

  it("includes hit data in ToolResult text (SPEC-F4-6)", async () => {
    const { buildSearchSessionTool } = await import("../search-session.js");

    const mockHit: SessionMessageHit = {
      role: "assistant",
      content: "I approved the invoice",
      timestamp: "2026-02-01T12:00:00Z",
      toolName: null,
    };

    const searchFn = vi.fn().mockReturnValue([mockHit]);
    const tool = buildSearchSessionTool(searchFn);

    const result = await tool.execute("tc-002", { query: "invoice", limit: 10 });

    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("invoice");
    expect(result.content[0]!.text).toContain("assistant");
  });

  it("returns 'No matching messages.' when searchFn returns empty array", async () => {
    const { buildSearchSessionTool } = await import("../search-session.js");

    const searchFn = vi.fn().mockReturnValue([]);
    const tool = buildSearchSessionTool(searchFn);

    const result = await tool.execute("tc-003", { query: "nothing" });

    expect(result.content[0]!.text).toBe("No matching messages.");
    expect(result.details["count"]).toBe(0);
  });

  it("uses default limit of 20 when limit is not provided", async () => {
    const { buildSearchSessionTool } = await import("../search-session.js");

    const searchFn = vi.fn().mockReturnValue([]);
    const tool = buildSearchSessionTool(searchFn);

    await tool.execute("tc-004", { query: "test" });

    expect(searchFn).toHaveBeenCalledWith("test", 20);
  });

  it("has tool name 'search_session'", async () => {
    const { buildSearchSessionTool } = await import("../search-session.js");
    const tool = buildSearchSessionTool(() => []);
    expect(tool.name).toBe("search_session");
  });

  // SPEC-F1-8: verify no @zia/persistence import statement in the module source
  it("search-session.ts has no import statement for @zia/persistence (SPEC-F1-8)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");

    const moduleUrl = new URL("../search-session.ts", import.meta.url);
    const filePath = fileURLToPath(moduleUrl);
    const source = readFileSync(filePath, "utf8");

    // Check for actual import statements (not comments), e.g.
    // `import ... from "@zia/persistence"` or `import "@zia/persistence"`
    const importRegex = /^\s*import\s+.*["']@zia\/persistence["']/m;
    const importRegex2 = /^\s*import\s+.*["']better-sqlite3["']/m;

    expect(importRegex.test(source)).toBe(false);
    expect(importRegex2.test(source)).toBe(false);
  });
});
