import { describe, it, expect } from "vitest";
import { toSchema } from "../schema-bridge.js";
import { IsUnsafe, IsObject, IsSchema } from "typebox";

describe("toSchema", () => {
  it("wraps a valid JSON Schema object in Type.Unsafe — IsUnsafe returns true", () => {
    const inputSchema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const result = toSchema(inputSchema);
    expect(IsUnsafe(result)).toBe(true);
  });

  it("the wrapped schema is also a valid TSchema (IsSchema returns true)", () => {
    const inputSchema = { type: "object", properties: {} };
    const result = toSchema(inputSchema);
    expect(IsSchema(result)).toBe(true);
  });

  it("returns permissive fallback (Type.Object) for null inputSchema (SC-12)", () => {
    const result = toSchema(null);
    expect(IsObject(result)).toBe(true);
    const schema = result as Record<string, unknown>;
    expect(schema["additionalProperties"]).toBe(true);
  });

  it("returns permissive fallback (Type.Object) for undefined inputSchema (SC-12)", () => {
    const result = toSchema(undefined);
    expect(IsObject(result)).toBe(true);
    const schema = result as Record<string, unknown>;
    expect(schema["additionalProperties"]).toBe(true);
  });

  it("returns permissive fallback for non-object inputSchema (string) (SC-12)", () => {
    const result = toSchema("not-an-object");
    expect(IsObject(result)).toBe(true);
  });

  it("returns permissive fallback for non-object inputSchema (array) (SC-12)", () => {
    const result = toSchema([1, 2, 3]);
    expect(IsObject(result)).toBe(true);
  });

  it("handles representative Linear-style inputSchema (nested properties)", () => {
    const linearSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "number" },
        teamId: { type: "string" },
      },
      required: ["title", "teamId"],
    };
    const result = toSchema(linearSchema);
    expect(IsUnsafe(result)).toBe(true);
  });

  it("Type.Unsafe wraps preserve the original schema shape as properties", () => {
    const inputSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const result = toSchema(inputSchema) as Record<string, unknown>;
    // Type.Unsafe in typebox v1 merges schema props onto the TUnsafe object
    expect(result["type"]).toBe("object");
  });
});
