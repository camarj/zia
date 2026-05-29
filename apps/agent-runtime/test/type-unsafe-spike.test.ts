/**
 * T-18 — Type.Unsafe pi.dev acceptance spike (apps/agent-runtime layer)
 *
 * QUESTION: does pi.dev accept a `Type.Unsafe`-boxed raw JSON Schema as a tool's
 * `parameters` field at registration time (defineTool construction)?
 *
 * APPROACH (no-network, no LLM call):
 *   Construct `defineTool` objects with `Type.Unsafe`-wrapped parameters and assert
 *   construction does NOT throw and the tool descriptor has the expected shape.
 *   This proves pi.dev's registration layer accepts the schema.
 *
 *   For validation-dispatch acceptance (does pi-ai's arg-validation path work with
 *   Type.Unsafe schemas?), see the companion test in
 *   `packages/tools/src/adapters/__tests__/type-unsafe-validation-spike.test.ts`
 *   which exercises the TypeBox Compile+Check pipeline directly with the schemas
 *   produced by toSchema() — no credentials or network required.
 *
 * RESULT (recorded after first green run):
 *   ACCEPTED — defineTool construction succeeds and produces a correctly-shaped
 *   tool descriptor. The companion test proves the full validation round-trip works.
 *   No fallback to a JSON-Schema→TypeBox converter is needed.
 *   SPEC-SCHEMA-2 (Type.Unsafe passthrough) is confirmed correct for this SDK version.
 */

import { describe, it, expect } from "vitest";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { toSchema } from "@zia/tools";

// Representative MCP inputSchemas captured from real MCP servers (Linear/Notion).
// These are the exact schema shapes the adapter will feed to defineTool at runtime.

const simpleSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    teamId: { type: "string" },
  },
  required: ["title", "teamId"],
};

const linearComplexSchema = {
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
          properties: {
            property: { type: "string" },
            text: { type: "object" },
          },
        },
        {
          type: "object",
          properties: {
            and: { type: "array", items: { type: "object" } },
          },
        },
      ],
    },
  },
  required: ["database_id"],
};

describe("T-18 — Type.Unsafe pi.dev acceptance spike (defineTool registration)", () => {
  it("SC-T18-01: defineTool does NOT throw for parameters = toSchema(simpleSchema)", () => {
    let tool: ReturnType<typeof defineTool> | undefined;
    expect(() => {
      tool = defineTool({
        name: "mcp_linear_create_issue",
        label: "MCP: linear/create_issue",
        description: "Create a Linear issue",
        parameters: toSchema(simpleSchema),
        execute: async (_id, _params) => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: {},
        }),
      });
    }).not.toThrow();

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("mcp_linear_create_issue");
    expect(tool!.label).toBe("MCP: linear/create_issue");
    // parameters is the Type.Unsafe-wrapped schema (has the original JSON Schema keys)
    expect(tool!.parameters).toBeDefined();
  });

  it("SC-T18-02: defineTool does NOT throw for complex nested schema (Linear-style with enum+array+object)", () => {
    let tool: ReturnType<typeof defineTool> | undefined;
    expect(() => {
      tool = defineTool({
        name: "mcp_linear_create_issue_complex",
        label: "MCP: linear/create_issue_complex",
        description: "Create a Linear issue with full options",
        parameters: toSchema(linearComplexSchema),
        execute: async (_id, _params) => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: {},
        }),
      });
    }).not.toThrow();

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("mcp_linear_create_issue_complex");
  });

  it("SC-T18-03: defineTool does NOT throw for Notion-style schema with anyOf", () => {
    let tool: ReturnType<typeof defineTool> | undefined;
    expect(() => {
      tool = defineTool({
        name: "mcp_notion_query_database",
        label: "MCP: notion/query_database",
        description: "Query a Notion database",
        parameters: toSchema(notionAnyOfSchema),
        execute: async (_id, _params) => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: {},
        }),
      });
    }).not.toThrow();

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("mcp_notion_query_database");
  });

  it("SC-T18-04: defineTool parameters field preserves the original JSON Schema structure", () => {
    const tool = defineTool({
      name: "mcp_spike_inspect",
      label: "MCP: spike/inspect",
      description: "Spike inspection tool",
      parameters: toSchema(simpleSchema),
      execute: async (_id, _params) => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
    });

    // The underlying JSON Schema is still accessible through the Type.Unsafe wrapper:
    // Type.Unsafe clones the input and adds ~unsafe as a non-enumerable property,
    // preserving the original schema fields as enumerable keys.
    const params = tool.parameters as Record<string, unknown>;
    expect(params["type"]).toBe("object");
    expect(params["required"]).toEqual(["title", "teamId"]);
  });
});
