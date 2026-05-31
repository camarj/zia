/**
 * search-memory.ts — Builtin search_memory tool (SPEC-TOOL-3, SPEC-TOOL-4, SPEC-TOOL-5).
 *
 * Risk level: trivial — read-only, no external side-effect.
 * Listed in agents/_template/POLICIES.md under ## Trivial.
 *
 * The tool factory accepts a MemorySearchFn injected by the composition root
 * (tui.ts). This keeps @zia/tools free of @zia/memory and @zia/persistence
 * dependencies (GOV-2, SPEC-TOOL-5).
 *
 * Mirrors buildSearchSessionTool exactly in structure (ADR-M2).
 */

import type { ToolResult, WrappableTool } from "@zia/callbacks";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lightweight memory search result shape.
 * Duplicated from @zia/memory intentionally — keeps @zia/tools boundary clean
 * (same pattern as SessionMessageHit vs MessageSearchHit, ADR-M3).
 */
export interface MemoryHit {
  readonly date: string;
  readonly snippet: string;
}

/** Injected search function — keeps @zia/tools free of @zia/memory (GOV-2). */
export type MemorySearchFn = (query: string, limit?: number) => Promise<MemoryHit[]>;

// ---------------------------------------------------------------------------
// Tool type (extends WrappableTool with riskLevel for inspection / tests)
// ---------------------------------------------------------------------------

export interface SearchMemoryTool extends WrappableTool {
  readonly riskLevel: "trivial";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the search_memory WrappableTool with an injected search function.
 *
 * @param searchFn  Function that performs the actual memory search. Injected by
 *                  the composition root so @zia/tools never imports @zia/memory.
 */
export function buildSearchMemoryTool(searchFn: MemorySearchFn): SearchMemoryTool {
  return {
    name: "search_memory",
    label: "Search Memory",
    riskLevel: "trivial",
    description:
      "Search your long-term memory (MEMORY.md) for past lessons and notes. " +
      "Returns matching entries ordered newest-first. Use this to recall feedback, " +
      "decisions, or learned rules from previous sessions.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query — plain text. The file provider uses substring matching; " +
          "the SQLite provider uses FTS5.",
      }),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of results to return. Default: 20." }),
      ),
    }),

    async execute(
      _id: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult> {
      const query = String(params["query"] ?? "").trim();
      const limit = typeof params["limit"] === "number" ? params["limit"] : 20;

      if (!query) {
        return {
          content: [{ type: "text", text: "No matching memory entries." }],
          details: { count: 0 },
        };
      }

      const hits = await searchFn(query, limit);

      const text =
        hits.length > 0
          ? hits.map((h) => `[${h.date}] ${h.snippet}`).join("\n")
          : "No matching memory entries.";

      return {
        content: [{ type: "text", text }],
        details: { count: hits.length },
      };
    },
  };
}
