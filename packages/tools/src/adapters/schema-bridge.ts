/**
 * schema-bridge.ts — Translate MCP inputSchema (raw JSON Schema) to a TypeBox TSchema.
 *
 * THE Type.Unsafe spike point (design §5):
 *   `Type.Unsafe<Record<string,unknown>>(inputSchema)` is the primary path.
 *   If pi.dev calls TypeBox.Value.Check() on the Unsafe schema and rejects it,
 *   the execute function's try/catch (SPEC-ERR-3) surfaces the failure as a
 *   ToolResult error — the adapter never crashes the agent loop.
 *
 * SPEC-SCHEMA-2: Do NOT convert MCP JSON Schema to TypeBox-native types
 *   (Type.Object, Type.String, etc.). Type.Unsafe passthrough is the required approach.
 *
 * SPEC-SCHEMA-3: If inputSchema is absent/null/non-object, fall back to
 *   Type.Object({}, { additionalProperties: true }) — permissive, accepts any object.
 */

import { type TSchema, type TObject, Unsafe, Object as TBoxObject } from "typebox";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool's `inputSchema` (plain JSON Schema object) into a TypeBox
 * `TSchema` suitable for use as the `parameters` field of a `WrappableTool`.
 *
 * @param inputSchema - The raw `inputSchema` from an MCP `tools/list` response.
 *   May be undefined/null for tools that accept no parameters.
 * @returns A `TUnsafe` wrapping the schema (primary path), or a permissive
 *   `TObject` fallback when the input is absent or not a plain object (SC-12).
 */
export function toSchema(inputSchema: unknown): TSchema {
  if (inputSchema !== null && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    // Primary path: wrap the raw JSON Schema in Type.Unsafe.
    // TSchema is an empty interface in typebox v1 — any plain object satisfies it.
    return Unsafe<Record<string, unknown>>(inputSchema as TSchema);
  }

  // Fallback: permissive object schema (SPEC-SCHEMA-3, SC-12)
  return permissiveFallback();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function permissiveFallback(): TObject {
  return TBoxObject({}, { additionalProperties: true });
}
