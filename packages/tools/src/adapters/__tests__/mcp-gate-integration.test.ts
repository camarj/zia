/**
 * mcp-gate-integration.test.ts — SC-13: Approval gate integration for MCP tools.
 *
 * Verifies the composition pipeline:
 *   buildWrappableTool (tool-factory) → wrapToolsWithApproval (@zia/callbacks)
 *
 * SC-13 per spec:
 *   Given an adapter returning one tool (mcp_linear_create_issue) where POLICIES.md
 *   classifies it as `alto` and the approval queue has a rejecting resolver:
 *     (a) With a REJECTING resolver: underlying callTool is NEVER invoked; result is
 *         the approval rejection ToolResult, not an MCP error.
 *     (b) With an APPROVING resolver: callTool IS invoked; the mapped MCP result returns.
 *
 * SPEC-GATE-1: WrappableTool is passed unmodified into createZiaAgent rawTools.
 * SPEC-GATE-2: The adapter does NOT call wrapToolsWithApproval itself (it is called here,
 *              representing the createZiaAgent composition layer).
 * SPEC-GATE-3: PolicyClassifier classifies mcp_linear_create_issue as alto (fail-safe default
 *              since no explicit POLICIES.md entry exists for it in the trivial classifier used here).
 */

import { describe, expect, it, vi } from "vitest";

import {
  PolicyClassifier,
  ApprovalQueue,
  ApprovalSerializer,
  wrapToolsWithApproval,
  type AuditLog,
  type AuditEntry,
  type WrappableTool,
  type ApprovalResolver,
  type Decision,
  type ApprovalRequest,
} from "@zia/callbacks";

import { buildWrappableTool } from "../tool-factory.ts";
import type { McpServerClient, McpToolDescriptor } from "../mcp-server.ts";
import type { McpCallResult } from "../result-mapper.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A no-op AuditLog — we don't need file I/O in these tests. */
const noopAuditLog: AuditLog = {
  record(_entry: AuditEntry): Promise<void> {
    return Promise.resolve();
  },
};

/** Build a fake McpServerClient with a controllable callTool mock. */
function makeFakeServerClient(callToolResult: McpCallResult): {
  client: McpServerClient;
  callToolMock: ReturnType<typeof vi.fn>;
} {
  const callToolMock = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpCallResult>>()
    .mockResolvedValue(callToolResult);

  const client: McpServerClient = {
    name: "linear",
    listTools: vi.fn<() => Promise<McpToolDescriptor[]>>().mockResolvedValue([]),
    callTool: callToolMock,
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  return { client, callToolMock };
}

/** Build the gate pipeline around a single MCP WrappableTool. */
function buildGate(
  rawTool: WrappableTool,
  resolver: ApprovalResolver,
): WrappableTool {
  // PolicyClassifier with no POLICIES.md text → every tool falls back to "alto" (SPEC-GATE-3).
  const classifier = PolicyClassifier.fromPolicies("");
  const serializer = new ApprovalSerializer();
  const queue = new ApprovalQueue(resolver, serializer);

  const [wrapped] = wrapToolsWithApproval([rawTool], {
    classifier,
    queue,
    auditLog: noopAuditLog,
  });

  if (!wrapped) throw new Error("wrapToolsWithApproval returned an empty array");
  return wrapped;
}

// ---------------------------------------------------------------------------
// SC-13 tests
// ---------------------------------------------------------------------------

describe("SC-13 — approval gate integration for MCP tools", () => {
  const descriptor: McpToolDescriptor = {
    name: "create_issue",
    description: "Create a Linear issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  };

  describe("(a) REJECTING resolver — callTool must never be invoked", () => {
    it("returns the gate rejection ToolResult and does not call the MCP client", async () => {
      const { client, callToolMock } = makeFakeServerClient({
        isError: false,
        content: [{ type: "text", text: "issue created" }],
      });

      const rawTool = buildWrappableTool("linear", descriptor, client);
      expect(rawTool.name).toBe("mcp_linear_create_issue");

      const rejectingResolver: ApprovalResolver = {
        resolve(_req: ApprovalRequest): Promise<Decision> {
          return Promise.resolve({ approved: false, approver: "test-admin" });
        },
      };

      const wrappedTool = buildGate(rawTool, rejectingResolver);

      const result = await wrappedTool.execute("call-reject-1", { title: "My Issue" });

      // Gate must have intercepted — MCP client is NEVER called.
      expect(callToolMock).not.toHaveBeenCalled();

      // Result must reflect the gate rejection, not an MCP error.
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.text).toContain("rejected");
      expect((result.details as Record<string, unknown>)["rejected"]).toBe(true);
      // Ensure it is NOT an MCP transport/tool error shape.
      expect(result.content[0]?.text).not.toContain("MCP tool error");
      expect(result.content[0]?.text).not.toContain("MCP transport error");
    });
  });

  describe("(b) APPROVING resolver — callTool IS invoked and mapped result returns", () => {
    it("calls the MCP client and returns the mapped ToolResult on approval", async () => {
      const { client, callToolMock } = makeFakeServerClient({
        isError: false,
        content: [{ type: "text", text: "issue created" }],
      });

      const rawTool = buildWrappableTool("linear", descriptor, client);

      const approvingResolver: ApprovalResolver = {
        resolve(_req: ApprovalRequest): Promise<Decision> {
          return Promise.resolve({ approved: true, approver: "test-admin" });
        },
      };

      const wrappedTool = buildGate(rawTool, approvingResolver);

      const result = await wrappedTool.execute("call-approve-1", { title: "My Issue" });

      // Gate approved — MCP client must have been called.
      expect(callToolMock).toHaveBeenCalledOnce();
      expect(callToolMock).toHaveBeenCalledWith("create_issue", { title: "My Issue" });

      // Result must be the mapped MCP response, not a rejection.
      expect(result.content[0]?.text).toBe("issue created");
      expect((result.details as Record<string, unknown>)["isError"]).toBe(false);
    });
  });

  describe("edge: trivial tool bypasses the queue entirely", () => {
    it("a tool explicitly classified trivial calls the MCP client without resolver involvement", async () => {
      const { client, callToolMock } = makeFakeServerClient({
        isError: false,
        content: [{ type: "text", text: "ok" }],
      });

      const rawTool = buildWrappableTool("linear", descriptor, client);

      // Classifier that marks mcp_linear_create_issue as trivial.
      const trivialClassifier = PolicyClassifier.fromPolicies(
        "## Trivial\nTools: mcp_linear_create_issue",
      );
      const serializer = new ApprovalSerializer();
      // Null resolver — fail-closed if queue is ever called (it must NOT be).
      const queue = new ApprovalQueue(null, serializer);

      const [wrapped] = wrapToolsWithApproval([rawTool], {
        classifier: trivialClassifier,
        queue,
        auditLog: noopAuditLog,
      });
      if (!wrapped) throw new Error("empty wrap");

      // Trivial path must never touch the queue — no resolver needed.
      const result = await wrapped.execute("call-trivial-1", { title: "Trivial Task" });

      expect(callToolMock).toHaveBeenCalledOnce();
      expect(result.content[0]?.text).toBe("ok");
    });
  });
});
