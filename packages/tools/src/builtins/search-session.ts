/**
 * search-session.ts — Builtin search_session tool (SPEC-F1-8, SPEC-F4-6, ADR-D3).
 *
 * This module MUST NOT import @zia/persistence or better-sqlite3 (INV-2, SPEC-F1-8).
 * The search function is injected via buildSearchSessionTool(searchFn) to keep
 * @zia/tools free of persistence dependencies. The composition root (tui.ts) closes
 * the loop by passing messageStore.search as the searchFn.
 *
 * search_session does NOT self-register (unlike the 7 file tools) because it
 * requires searchFn at construction time, not a cwd. createBuiltinTools() in
 * index.ts appends it explicitly when searchFn is provided.
 */

import type { WrappableTool, ToolResult } from "@zia/callbacks";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Public types — consumed by builtins/index.ts and the composition root
// ---------------------------------------------------------------------------

export interface SessionMessageHit {
  readonly role: string;
  readonly content: string;
  readonly timestamp: string;
  readonly toolName: string | null;
}

/** Injected search function — keeps @zia/tools free of @zia/persistence (INV-2). */
export type SessionSearchFn = (
  query: string,
  limit?: number,
) => SessionMessageHit[];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the search_session WrappableTool with an injected search function.
 *
 * @param searchFn  Function that performs the actual FTS5 search. Injected by
 *                  the composition root so @zia/tools never imports @zia/persistence.
 */
export function buildSearchSessionTool(searchFn: SessionSearchFn): WrappableTool {
  return {
    name: "search_session",
    label: "Search Session History",
    description:
      "Full-text search over this agent's own past conversation messages. " +
      "Returns the most recent matching messages.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query — plain text, no FTS operators needed." }),
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
          content: [{ type: "text", text: "No matching messages." }],
          details: { count: 0 },
        };
      }

      const hits = searchFn(query, limit);

      const text =
        hits.length > 0
          ? hits
              .map(
                (h) =>
                  `[${h.timestamp}] ${h.role}${h.toolName ? `/${h.toolName}` : ""}: ${h.content}`,
              )
              .join("\n")
          : "No matching messages.";

      return {
        content: [{ type: "text", text }],
        details: { count: hits.length },
      };
    },
  };
}
