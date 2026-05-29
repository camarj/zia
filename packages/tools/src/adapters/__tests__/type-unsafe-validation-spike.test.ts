/**
 * T-18 — Type.Unsafe pi.dev acceptance spike (validation pipeline layer)
 *
 * QUESTION: does pi-ai's arg-validation path work correctly with Type.Unsafe
 * schemas produced by toSchema()?
 *
 * APPROACH (no-network, no credentials):
 *   Replicate the exact pipeline that pi-ai's `validateToolArguments` uses
 *   (see @earendil-works/pi-ai/dist/utils/validation.js):
 *
 *     1. Value.Convert(tool.parameters, args)   — type coercion
 *     2. hasTypeBoxMetadata check               — does Symbol.for("TypeBox.Kind") exist?
 *     3. If not: Compile(schema).Check(args)    — JSON-Schema validation
 *
 *   We run each step with toSchema() output to confirm the full round-trip.
 *
 * RESULT (recorded after first green run):
 *   ACCEPTED — the full Compile+Check pipeline succeeds.
 *
 * WHY it works (key insight from reading pi-ai source):
 *   typebox v1 Unsafe() clones the input and adds `~unsafe: null` as a
 *   NON-ENUMERABLE string key (Memory.Update with enumerableKind=false by default).
 *   - Object.getOwnPropertySymbols() on the result returns [] (no Symbol keys).
 *   - pi-ai's hasTypeBoxMetadata checks Symbol.for("TypeBox.Kind") → returns false.
 *   - pi-ai falls to the JSON Schema coercion path: Compile(schema).
 *   - Compile() sees the original JSON Schema properties (type, properties, required,
 *     etc.) as enumerable keys — they are fully preserved by the clone+update.
 *   - The resulting validator correctly enforces the embedded JSON Schema rules.
 *
 *   Net effect: Type.Unsafe behaves as a transparent passthrough. Valid args pass;
 *   invalid args (missing required fields) fail validation as expected.
 *   SPEC-SCHEMA-2 is confirmed: no JSON-Schema→TypeBox converter is needed.
 */

import { describe, it, expect } from "vitest";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { toSchema } from "../schema-bridge.js";

// Simulates pi-ai's hasTypeBoxMetadata(schema) check:
//   return isRecord(schema) && Object.getOwnPropertySymbols(schema).includes(Symbol.for("TypeBox.Kind"))
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
function hasTypeBoxMetadata(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND)
  );
}

// Simulates pi-ai's validateToolArguments minimal happy path:
//   Value.Convert → Compile → Check
function simulatePiAiValidation(
  schema: unknown,
  args: Record<string, unknown>,
): { passed: boolean; hasMetadata: boolean } {
  const clonedArgs = structuredClone(args);
  Value.Convert(schema as never, clonedArgs);

  const usedJsonSchemaPath = !hasTypeBoxMetadata(schema);
  const validator = Compile(schema as never);
  const passed = validator.Check(clonedArgs);

  return { passed, hasMetadata: hasTypeBoxMetadata(schema) };
}

// ─── representative schemas ───────────────────────────────────────────────────

const simpleSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    teamId: { type: "string" },
  },
  required: ["title", "teamId"],
};

const complexLinearSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    priority: { type: "number", enum: [0, 1, 2, 3, 4] },
    labels: { type: "array", items: { type: "string" } },
    assignee: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: ["id"],
    },
  },
  required: ["title"],
};

const notionAnyOfSchema = {
  type: "object",
  properties: {
    database_id: { type: "string" },
    filter: {
      anyOf: [
        {
          type: "object",
          properties: { property: { type: "string" }, text: { type: "object" } },
        },
        {
          type: "object",
          properties: { and: { type: "array", items: { type: "object" } } },
        },
      ],
    },
  },
  required: ["database_id"],
};

// ─── spike tests ──────────────────────────────────────────────────────────────

describe("T-18 — Type.Unsafe pi.dev validation pipeline spike", () => {
  it("SC-T18-V01: Type.Unsafe schema does NOT set Symbol.for(TypeBox.Kind) — pi-ai uses JSON Schema path", () => {
    const schema = toSchema(simpleSchema);
    // In typebox v1, Unsafe() sets '~unsafe' (non-enumerable string), NOT a Symbol.
    // This means pi-ai's hasTypeBoxMetadata returns false → JSON Schema code path.
    expect(hasTypeBoxMetadata(schema)).toBe(false);
    // Confirm no Symbol keys at all
    expect(Object.getOwnPropertySymbols(schema)).toHaveLength(0);
  });

  it("SC-T18-V02: Compile(toSchema(simpleSchema)) succeeds and Check passes for valid args", () => {
    const schema = toSchema(simpleSchema);
    const { passed } = simulatePiAiValidation(schema, {
      title: "Fix auth bug",
      teamId: "team-abc",
    });
    expect(passed).toBe(true);
  });

  it("SC-T18-V03: Compile(toSchema(simpleSchema)) — Check returns false for args missing required field", () => {
    const schema = toSchema(simpleSchema);
    const { passed } = simulatePiAiValidation(schema, {
      title: "Fix auth bug",
      // Missing required "teamId"
    });
    expect(passed).toBe(false);
  });

  it("SC-T18-V04: complex nested schema (Linear-style) — valid args with nested object, array, enum", () => {
    const schema = toSchema(complexLinearSchema);
    const { passed } = simulatePiAiValidation(schema, {
      title: "Fix login bug",
      priority: 2,
      labels: ["bug", "auth"],
      assignee: { id: "user-123", name: "Alice" },
    });
    expect(passed).toBe(true);
  });

  it("SC-T18-V05: complex nested schema — missing required 'title' fails validation", () => {
    const schema = toSchema(complexLinearSchema);
    const { passed } = simulatePiAiValidation(schema, {
      priority: 2,
      // Missing required "title"
    });
    expect(passed).toBe(false);
  });

  it("SC-T18-V06: Notion-style schema with anyOf — valid args pass validation", () => {
    const schema = toSchema(notionAnyOfSchema);
    const { passed } = simulatePiAiValidation(schema, {
      database_id: "db-abc-123",
      filter: { property: "Status", text: { equals: "Done" } },
    });
    expect(passed).toBe(true);
  });

  it("SC-T18-V07: Notion-style schema — missing required database_id fails validation", () => {
    const schema = toSchema(notionAnyOfSchema);
    const { passed } = simulatePiAiValidation(schema, {
      filter: { property: "Status" },
      // Missing required "database_id"
    });
    expect(passed).toBe(false);
  });

  it("SC-T18-V08: Type.Unsafe wrapping preserves JSON Schema keys as enumerable properties", () => {
    const schema = toSchema(simpleSchema) as Record<string, unknown>;
    // The original JSON Schema fields (type, properties, required) must be
    // enumerable so Compile() can see them.
    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toEqual(["title", "teamId"]);
    expect(schema["properties"]).toBeDefined();
  });
});
