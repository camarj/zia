/**
 * types.test.ts — Structural type assertion tests (AQ-11, AQ-12)
 *
 * These tests verify that the shared structural types exported from types.ts
 * are correct shapes that can be satisfied by plain objects (no SDK import required).
 */
import { describe, expect, it } from "vitest";

import type {
  ToolResultContent,
  ToolResult,
  WrappableTool,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Group 1: ToolResultContent shape
// ---------------------------------------------------------------------------

describe("ToolResultContent", () => {
  it("TY-1: can be constructed as a plain object with type and text", () => {
    const content: ToolResultContent = { type: "text", text: "hello" };
    expect(content.type).toBe("text");
    expect(content.text).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Group 2: ToolResult shape
// ---------------------------------------------------------------------------

describe("ToolResult", () => {
  it("TY-2: minimal ToolResult has content array and details", () => {
    const result: ToolResult = {
      content: [{ type: "text", text: "ok" }],
      details: {},
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
  });

  it("TY-3: ToolResult details carries structured data", () => {
    const result: ToolResult = {
      content: [{ type: "text", text: "ok" }],
      details: { id: "abc" },
    };
    expect(result.details?.["id"]).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// Group 3: WrappableTool interface compliance
// ---------------------------------------------------------------------------

describe("WrappableTool", () => {
  it("TY-4: a plain object satisfies WrappableTool", () => {
    const tool: WrappableTool = {
      name: "my_tool",
      label: "My Tool",
      parameters: {},
      execute: async (_toolCallId, _params) => ({
        content: [{ type: "text", text: "done" }],
        details: {},
      }),
    };
    expect(tool.name).toBe("my_tool");
    expect(typeof tool.execute).toBe("function");
  });

  it("TY-5: WrappableTool execute returns a ToolResult-shaped promise", async () => {
    const tool: WrappableTool = {
      name: "echo_tool",
      label: "Echo Tool",
      parameters: {},
      execute: async (toolCallId, params) => ({
        content: [{ type: "text", text: `called with ${toolCallId}` }],
        details: { params },
      }),
    };
    const result = await tool.execute("call-1", { x: 1 });
    expect(result.content[0]?.text).toBe("called with call-1");
  });

  it("TY-6: WrappableTool carries label and description", () => {
    const tool: WrappableTool = {
      name: "labeled_tool",
      label: "Labeled Tool",
      description: "Does something",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
    };
    expect(tool.label).toBe("Labeled Tool");
    expect(tool.description).toBe("Does something");
  });
});
