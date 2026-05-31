/**
 * search-memory.test.ts — buildSearchMemoryTool tests (SPEC-TOOL-3, SPEC-TOOL-4).
 *
 * Verifies the search_memory tool's identity (name/label/risk), parameter schema,
 * that it invokes the injected MemorySearchFn, formats hits as "[date] snippet",
 * reports the count in details, and short-circuits on an empty query.
 */

import { describe, expect, it, vi } from "vitest";
import { buildSearchMemoryTool, type MemoryHit } from "../search-memory.js";

describe("buildSearchMemoryTool — identity (SPEC-TOOL-3)", () => {
  it("has name 'search_memory', label, and riskLevel 'trivial'", () => {
    const tool = buildSearchMemoryTool(async () => []);
    expect(tool.name).toBe("search_memory");
    expect(tool.label).toBe("Search Memory");
    expect(tool.riskLevel).toBe("trivial");
  });

  it("exposes a required 'query' and an optional 'limit' parameter", () => {
    const tool = buildSearchMemoryTool(async () => []);
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("query");
    expect(schema.properties).toHaveProperty("limit");
  });
});

describe("buildSearchMemoryTool — execute (SPEC-TOOL-4)", () => {
  it("invokes searchFn and formats hits as '[date] snippet' with a count", async () => {
    const hits: MemoryHit[] = [
      { date: "2026-05-30", snippet: "boss prefers concise replies" },
      { date: "2026-05-28", snippet: "invoice cycle closes on the 25th" },
    ];
    const searchFn = vi.fn(async (_q: string, _limit?: number): Promise<MemoryHit[]> => hits);
    const tool = buildSearchMemoryTool(searchFn);

    const result = await tool.execute("call-1", { query: "boss" });

    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(searchFn).toHaveBeenCalledWith("boss", 20); // default limit
    const text = result.content[0];
    expect(text).toMatchObject({ type: "text" });
    expect((text as { text: string }).text).toContain("[2026-05-30] boss prefers concise replies");
    expect((text as { text: string }).text).toContain("[2026-05-28] invoice cycle closes on the 25th");
    expect(result.details).toMatchObject({ count: 2 });
  });

  it("passes through an explicit limit", async () => {
    const searchFn = vi.fn(async (_q: string, _limit?: number): Promise<MemoryHit[]> => []);
    const tool = buildSearchMemoryTool(searchFn);

    await tool.execute("call-2", { query: "deadline", limit: 5 });

    expect(searchFn).toHaveBeenCalledWith("deadline", 5);
  });

  it("returns 'No matching memory entries.' and count 0 when there are no hits", async () => {
    const searchFn = vi.fn(async (_q: string, _limit?: number): Promise<MemoryHit[]> => []);
    const tool = buildSearchMemoryTool(searchFn);

    const result = await tool.execute("call-3", { query: "nonexistent" });

    expect((result.content[0] as { text: string }).text).toBe("No matching memory entries.");
    expect(result.details).toMatchObject({ count: 0 });
  });

  it("does NOT call searchFn when the query is empty", async () => {
    const searchFn = vi.fn(async (_q: string, _limit?: number): Promise<MemoryHit[]> => []);
    const tool = buildSearchMemoryTool(searchFn);

    const result = await tool.execute("call-4", { query: "   " });

    expect(searchFn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ count: 0 });
  });
});
