/**
 * tool-factory.ts — Build a WrappableTool from one MCP tool descriptor.
 *
 * Converts a single MCP tool descriptor + McpServerClient into a WrappableTool
 * that the zia gate (wrapToolsWithApproval) can consume.
 *
 * SPEC-NAME-1: name = `mcp_<server>_<toolName>` — verbatim, no slug conversion.
 * SPEC-NAME-2: label = `"MCP: <server>/<toolName>"`.
 * SPEC-NAME-3: description from MCP server or non-empty fallback.
 * SPEC-SCHEMA-1: parameters via toSchema(inputSchema).
 * SPEC-ERR-3: execute wraps callTool rejection → ToolResult transport error shape.
 * SPEC-ERR-5: execute NEVER throws.
 *
 * Note: we do NOT call defineTool() from @earendil-works/pi-coding-agent because
 * WrappableTool (from @zia/callbacks) is a structural duck type — any plain object
 * satisfying the interface is accepted. defineTool() is a no-op type helper and
 * would introduce an unnecessary runtime dep (SPEC-PKG-3).
 *
 * Layer 2 (dynamic toolset routing via setActiveTools) is not implemented here.
 * setActiveTools is only available on ExtensionAPI, not on AgentSession/AgentSessionRuntime
 * or any surface reachable from createZiaAgent. Deferred to a future phase that either
 * (a) registers tools as a pi.dev extension, or (b) re-creates the session with a filtered
 * tool set. See sdd/mcp-adapter proposal for full rationale.
 */

import type { WrappableTool, ToolResult } from "@zia/callbacks";
import type { McpServerClient, McpToolDescriptor } from "./mcp-server.ts";
import { toSchema } from "./schema-bridge.ts";
import { mapResult } from "./result-mapper.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `WrappableTool` from a single MCP tool descriptor and a connected server client.
 *
 * @param serverName - The `name` field from mcp.yaml (used verbatim in the tool name).
 * @param desc - Tool descriptor returned by `McpServerClient.listTools()`.
 * @param client - The connected server client; `execute` closes over this.
 * @returns A `WrappableTool` ready to pass to `createZiaAgent` as `rawTools`.
 */
export function buildWrappableTool(
  serverName: string,
  desc: McpToolDescriptor,
  client: McpServerClient,
): WrappableTool {
  const name = `mcp_${serverName}_${desc.name}`;
  const label = `MCP: ${serverName}/${desc.name}`;
  const description =
    desc.description && desc.description.length > 0
      ? desc.description
      : `MCP tool ${serverName}/${desc.name}`; // SPEC-NAME-3: non-empty fallback

  const parameters = toSchema(desc.inputSchema); // SPEC-SCHEMA-1

  return {
    name,
    label,
    description,
    parameters,

    /**
     * Invoke the MCP tool. Maps the MCP result to a ToolResult.
     *
     * - Success → mapResult(result).
     * - isError:true in result → mapResult surfaces it as ToolResult error (SC-06).
     * - callTool rejects → transport error ToolResult (SC-07, SPEC-ERR-3).
     * - NEVER throws (SPEC-ERR-5).
     */
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult> {
      try {
        const mcpResult = await client.callTool(desc.name, params);
        return mapResult(mcpResult);
      } catch (err) {
        // Transport-level failure (server crash, JSON-RPC error, etc.) — SPEC-ERR-3.
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `MCP transport error: ${message}` }],
          details: { isError: true, transportError: true, errorMessage: message },
        };
      }
    },
  };
}
