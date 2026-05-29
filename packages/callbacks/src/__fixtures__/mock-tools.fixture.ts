/**
 * mock-tools.fixture.ts — Test-only example tools for the approval gate.
 *
 * These tools exist ONLY to validate wrapToolsWithApproval in tests and
 * integration scenarios. They are NOT production tools.
 *
 * Two tools cover both gate paths:
 *   - mockTrivialReadTool: classified "trivial" — exercises the auto-execute path
 *   - mockExternalPostTool: classified "alto"  — exercises block/approve/reject
 *
 * POLICIES_FIXTURE: a POLICIES.md text string that maps both tools and is
 * understood by PolicyClassifier.fromPolicies().
 */

import type { ToolResult, WrappableTool } from "../types.js";

// ---------------------------------------------------------------------------
// POLICIES.md fixture text
// ---------------------------------------------------------------------------

export const POLICIES_FIXTURE = `# Agent Policies

## Trivial
Auto-execute without approval.

Tools: mock_trivial_read

## Alto
High-risk actions — require explicit approval.

Tools: mock_external_post
`;

// ---------------------------------------------------------------------------
// Mock trivial read tool
// ---------------------------------------------------------------------------

/**
 * A trivial read-only tool. Its execute writes to the provided store array
 * so tests can assert it ran (or did not run).
 */
export function makeMockTrivialReadTool(store: string[]): WrappableTool {
  return {
    name: "mock_trivial_read",
    label: "Mock Trivial Read",
    description: "Trivial read — classified trivial in POLICIES_FIXTURE.",
    parameters: {},
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      ...rest: unknown[]
    ): Promise<ToolResult> {
      void rest;
      store.push(`read:${toolCallId}`);
      return {
        content: [{ type: "text", text: `Read result for ${String(params.query ?? "?")}` }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock external post tool
// ---------------------------------------------------------------------------

/**
 * A high-risk external posting tool. Its execute writes to the provided store
 * so tests can assert whether it ran (approved) or was skipped (rejected).
 */
export function makeMockExternalPostTool(store: string[]): WrappableTool {
  return {
    name: "mock_external_post",
    label: "Mock External Post",
    description: "Alto external action — classified alto in POLICIES_FIXTURE.",
    parameters: {},
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      ...rest: unknown[]
    ): Promise<ToolResult> {
      void rest;
      store.push(`post:${toolCallId}`);
      return {
        content: [{ type: "text", text: `Posted: ${String(params.message ?? "?")}` }],
      };
    },
  };
}
