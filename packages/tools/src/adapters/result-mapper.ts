/**
 * result-mapper.ts — Map MCP callTool results to the zia gate's ToolResult shape.
 *
 * SPEC-ERR-2: isError:true → ToolResult error shape with details.isError = true.
 * SPEC-ERR-5: mapResult NEVER throws. All paths return a ToolResult.
 */

import type { ToolResult, ToolResultContent } from "@zia/callbacks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a content item returned by an MCP server's callTool response. */
export interface McpContentItem {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/**
 * Minimal shape of the result returned by `client.callTool()`.
 * Mirrors the MCP SDK's CallToolResult without importing the SDK into this module.
 */
export interface McpCallResult {
  readonly isError?: boolean;
  readonly content: readonly McpContentItem[] | null | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map an MCP `callTool` result to a `ToolResult` compatible with the zia gate.
 *
 * - `isError: true` → error shape (SPEC-ERR-2, SC-06).
 * - Non-text content items → stringified into text content.
 * - Empty / null content → returns ToolResult with empty content array.
 * - Never throws (SPEC-ERR-5).
 */
export function mapResult(r: McpCallResult): ToolResult {
  try {
    const contentItems = r.content ?? [];

    // isError:true branch must come BEFORE mapping content items — W-2.
    // `mapped` is only needed on the success path; computing it unconditionally
    // in the error branch is dead work and makes control flow harder to read.
    if (r.isError === true) {
      return {
        content: [
          {
            type: "text",
            text: `MCP tool error: ${JSON.stringify(contentItems)}`,
          },
        ],
        details: {
          isError: true,
          rawContent: contentItems,
        },
      };
    }

    // Success path — map content items to ToolResultContent (SPEC-ERR-2).
    const mapped = Array.from(contentItems).map(toTextContent);
    return {
      content: mapped,
      details: { isError: false },
    };
  } catch {
    // Last-resort guard — mapResult must never throw (SPEC-ERR-5)
    return {
      content: [{ type: "text", text: "MCP result mapping error" }],
      details: { isError: true, mappingError: true },
    };
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function toTextContent(item: McpContentItem): ToolResultContent {
  if (item.type === "text" && typeof item.text === "string") {
    return { type: "text", text: item.text };
  }
  // Non-text content (image, resource, etc.) → stringify for the LLM
  return { type: "text", text: JSON.stringify(item) };
}
