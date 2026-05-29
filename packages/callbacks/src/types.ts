/**
 * types.ts — Shared structural types for the zia approval gate.
 *
 * These interfaces mirror the shape of pi.dev's ToolResult and defineTool
 * return values WITHOUT importing the SDK, so the gate core is independently
 * testable. Any value returned by `defineTool.execute` is assignable to
 * ToolResult.
 */

// ---------------------------------------------------------------------------
// Tool result shape (mirrors @earendil-works/pi-coding-agent ToolResult)
// ---------------------------------------------------------------------------

export interface ToolResultContent {
  readonly type: "text";
  readonly text: string;
}

export interface ToolResult {
  readonly content: readonly ToolResultContent[];
  /**
   * Structured details required by AgentToolResult<T> in pi-agent-core.
   * Must always be present. Use {} for results that carry no extra detail.
   *
   * SDK reference: @earendil-works/pi-agent-core/dist/types.d.ts
   *   AgentToolResult<T> { details: T; }  — required, not optional.
   */
  readonly details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Minimal structural shape of a pi.dev tool (avoids importing the SDK into
// the gate core). `defineTool`'s return value is assignable to this.
// The `parameters` field holds a typebox schema — passed through untouched.
// The `...rest` in execute captures any additional positional args pi.dev
// may pass so the wrapper can forward them without knowing the arity.
// ---------------------------------------------------------------------------

export interface WrappableTool {
  readonly name: string;
  /**
   * Required to match ToolDefinition.label (string, not optional) in the SDK.
   * SDK reference: @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
   *   ToolDefinition { label: string; }  — required field.
   */
  readonly label: string;
  readonly description?: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<ToolResult>;
}
