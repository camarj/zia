/**
 * tool-factory.test.ts — Unit tests for buildWrappableTool.
 *
 * Uses an in-memory fake McpServerClient. No real subprocess.
 *
 * Covers: SC-01, SC-06, SC-07, SC-12, SC-14, SPEC-NAME-1..3, SPEC-ERR-3, SPEC-ERR-5.
 */

import { describe, expect, it, vi } from "vitest";
import type { McpServerClient, McpToolDescriptor } from "../mcp-server.ts";
import type { McpCallResult } from "../result-mapper.ts";
import { buildWrappableTool } from "../tool-factory.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeClient(overrides: Partial<McpServerClient> = {}): McpServerClient {
  return {
    name: "linear",
    listTools: vi.fn<() => Promise<McpToolDescriptor[]>>().mockResolvedValue([]),
    callTool: vi.fn<(n: string, a: Record<string, unknown>) => Promise<McpCallResult>>().mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    }),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDescriptor(overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    name: "create_issue",
    description: "Create a Linear issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildWrappableTool", () => {
  describe("tool naming (SPEC-NAME-1, SC-01, SC-14)", () => {
    it("name is mcp_<server>_<toolName> verbatim (SC-01)", () => {
      const tool = buildWrappableTool("linear", makeDescriptor({ name: "create_issue" }), makeFakeClient());
      expect(tool.name).toBe("mcp_linear_create_issue");
    });

    it("uses verbatim server name and tool name — no slug conversion (SC-14)", () => {
      const tool = buildWrappableTool(
        "my-linear",
        makeDescriptor({ name: "createIssue" }),
        makeFakeClient(),
      );
      expect(tool.name).toBe("mcp_my-linear_createIssue");
    });
  });

  describe("label (SPEC-NAME-2)", () => {
    it("label is 'MCP: <server>/<toolName>'", () => {
      const tool = buildWrappableTool("linear", makeDescriptor({ name: "create_issue" }), makeFakeClient());
      expect(tool.label).toBe("MCP: linear/create_issue");
    });
  });

  describe("description (SPEC-NAME-3)", () => {
    it("uses the MCP tool description when present", () => {
      const tool = buildWrappableTool(
        "linear",
        makeDescriptor({ description: "Create a Linear issue" }),
        makeFakeClient(),
      );
      expect(tool.description).toBe("Create a Linear issue");
    });

    it("falls back to non-empty description when description is absent (SPEC-NAME-3)", () => {
      const tool = buildWrappableTool(
        "linear",
        makeDescriptor({ name: "create_issue", description: undefined }),
        makeFakeClient(),
      );
      expect(typeof tool.description).toBe("string");
      expect(tool.description!.length).toBeGreaterThan(0);
    });

    it("falls back to non-empty description when description is empty string", () => {
      const tool = buildWrappableTool(
        "linear",
        makeDescriptor({ name: "create_issue", description: "" }),
        makeFakeClient(),
      );
      expect(tool.description!.length).toBeGreaterThan(0);
    });
  });

  describe("parameters (SPEC-SCHEMA-1, SC-12)", () => {
    it("wraps a valid inputSchema via toSchema", () => {
      const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
      const tool = buildWrappableTool("linear", makeDescriptor({ inputSchema: schema }), makeFakeClient());
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.parameters).toBe("object");
    });

    it("uses permissive fallback when inputSchema is absent / empty (SC-12)", () => {
      const tool = buildWrappableTool(
        "linear",
        makeDescriptor({ inputSchema: {} }),
        makeFakeClient(),
      );
      // Should still produce a valid (non-null, non-undefined) parameters object
      expect(tool.parameters).toBeTruthy();
    });
  });

  describe("execute — success path (SC-06)", () => {
    it("calls client.callTool with the tool name and params", async () => {
      const fakeCallTool = vi.fn<(n: string, a: Record<string, unknown>) => Promise<McpCallResult>>().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "Issue created" }],
      });
      const client = makeFakeClient({ callTool: fakeCallTool });
      const tool = buildWrappableTool("linear", makeDescriptor({ name: "create_issue" }), client);

      const result = await tool.execute("call-1", { title: "My Issue" });

      expect(fakeCallTool).toHaveBeenCalledOnce();
      expect(fakeCallTool).toHaveBeenCalledWith("create_issue", { title: "My Issue" });
      expect(result.content[0]?.text).toBe("Issue created");
      expect(result.details["isError"]).toBe(false);
    });

    it("maps isError:true MCP result to ToolResult error shape (SC-06)", async () => {
      const client = makeFakeClient({
        callTool: vi.fn<(n: string, a: Record<string, unknown>) => Promise<McpCallResult>>().mockResolvedValue({
          isError: true,
          content: [{ type: "text", text: "API error" }],
        }),
      });
      const tool = buildWrappableTool("linear", makeDescriptor({ name: "fail_tool" }), client);

      const result = await tool.execute("call-2", {});

      expect(result.details["isError"]).toBe(true);
      expect(result.content[0]?.text).toMatch(/^MCP tool error:/);
      // Must not throw
    });
  });

  describe("execute — transport error path (SC-07, SPEC-ERR-3, SPEC-ERR-5)", () => {
    it("catches callTool rejections and returns ToolResult with transportError:true", async () => {
      const client = makeFakeClient({
        callTool: vi.fn<(n: string, a: Record<string, unknown>) => Promise<McpCallResult>>().mockRejectedValue(
          new Error("Connection reset by peer"),
        ),
      });
      const tool = buildWrappableTool("linear", makeDescriptor(), client);

      const result = await tool.execute("call-3", {});

      expect(result.details["isError"]).toBe(true);
      expect(result.details["transportError"]).toBe(true);
      expect(result.content[0]?.text).toMatch(/^MCP transport error:/);
    });

    it("never throws from execute (SPEC-ERR-5)", async () => {
      const client = makeFakeClient({
        callTool: vi.fn<(n: string, a: Record<string, unknown>) => Promise<McpCallResult>>().mockRejectedValue(
          new Error("Catastrophic failure"),
        ),
      });
      const tool = buildWrappableTool("linear", makeDescriptor(), client);

      // Must resolve, not reject
      await expect(tool.execute("call-4", {})).resolves.toBeDefined();
    });
  });
});
