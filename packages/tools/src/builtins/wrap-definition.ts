/**
 * wrap-definition.ts — Shared helper that wraps a pi.dev ToolDefinition into
 * a zia WrappableTool (ADR-D1, SPEC-F1-2, SPEC-F1-4).
 *
 * The SDK's create*ToolDefinition factories return ToolDefinition<TParams, TDetails>
 * with a 5-arg execute: (id, params, signal, onUpdate, ctx). WrappableTool.execute
 * uses `...rest` to capture [signal, onUpdate, ctx] without importing the SDK's
 * generic types into the gate core. wrapDefinition bridges the two by:
 *
 *   1. Copying name/label/description/parameters verbatim.
 *   2. Re-spreading rest[0..2] into the SDK def's positional args.
 *   3. Normalizing AgentToolResult to zia ToolResult:
 *      - Keeps only text-typed content items (RR1 mitigation — images dropped).
 *      - Maps details to Record<string, unknown> (cast is safe; pi.dev details
 *        are always plain objects at runtime).
 *
 * The `as unknown as SdkToolDefinition` cast at each call site matches the
 * existing pattern in agent.ts:240 (customTools cast) — structural shape matches
 * at runtime; full generic assignability impossible without importing TSchema.
 */

import type { WrappableTool, ToolResult } from "@zia/callbacks";

// ---------------------------------------------------------------------------
// SdkToolDefinition — minimal structural interface (avoids importing TSchema
// generics into zia's types). The SDK's real ToolDefinition is a structural
// superset of this.
// ---------------------------------------------------------------------------

export interface SdkToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<{
    content: ReadonlyArray<
      | { readonly type: "text"; readonly text: string }
      | { readonly type: "image"; readonly data: string; readonly mimeType: string }
      | { readonly type: string; [key: string]: unknown }
    >;
    details: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// wrapDefinition
// ---------------------------------------------------------------------------

/**
 * Wrap a pi.dev ToolDefinition into a zia WrappableTool.
 *
 * The wrapper's execute(id, params, ...rest) forwards
 * rest[0]=signal, rest[1]=onUpdate, rest[2]=ctx to the SDK definition's
 * positional args, preserving full arity (R1 resolved — no capability loss).
 *
 * Non-text content (images) is mapped to a "[image omitted]" text placeholder
 * so ToolResult.content stays text-only (RR1 mitigation; file reads are text,
 * but this guard future-proofs the wrapper).
 */
export function wrapDefinition(def: SdkToolDefinition): WrappableTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,

    async execute(
      id: string,
      params: Record<string, unknown>,
      ...rest: unknown[]
    ): Promise<ToolResult> {
      const sdkResult = await def.execute(id, params, rest[0], rest[1], rest[2]);

      // Normalize content: keep text items; map everything else to a placeholder.
      const content = sdkResult.content.map((item) => {
        if (item.type === "text") {
          return { type: "text" as const, text: (item as { type: "text"; text: string }).text };
        }
        return { type: "text" as const, text: "[image omitted]" };
      });

      return {
        content,
        details: (sdkResult.details ?? {}) as Record<string, unknown>,
      };
    },
  };
}
