import { describe, it, expect } from "vitest";
import { mapResult } from "../result-mapper.js";
import type { McpCallResult } from "../result-mapper.js";

describe("mapResult", () => {
  it("maps isError:true result to ToolResult error shape (SC-06)", () => {
    const mcpResult: McpCallResult = {
      isError: true,
      content: [{ type: "text", text: "API error" }],
    };
    const result = mapResult(mcpResult);
    expect(result.details["isError"]).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MCP tool error:/);
    expect(() => mapResult(mcpResult)).not.toThrow();
  });

  it("includes rawContent in details for isError:true", () => {
    const mcpResult: McpCallResult = {
      isError: true,
      content: [{ type: "text", text: "some error" }],
    };
    const result = mapResult(mcpResult);
    expect(result.details["rawContent"]).toEqual(mcpResult.content);
  });

  it("maps successful result with text content to ToolResult", () => {
    const mcpResult: McpCallResult = {
      isError: false,
      content: [{ type: "text", text: "success output" }],
    };
    const result = mapResult(mcpResult);
    expect(result.details["isError"]).toBeFalsy();
    expect(result.content[0]?.text).toBe("success output");
  });

  it("handles empty content array without throwing", () => {
    const mcpResult: McpCallResult = {
      content: [],
    };
    expect(() => mapResult(mcpResult)).not.toThrow();
    const result = mapResult(mcpResult);
    expect(result.content).toHaveLength(0);
  });

  it("stringifies non-text content items into text content", () => {
    const mcpResult: McpCallResult = {
      content: [{ type: "image", data: "base64stuff", mimeType: "image/png" }],
    };
    const result = mapResult(mcpResult);
    expect(result.content[0]?.type).toBe("text");
    expect(typeof result.content[0]?.text).toBe("string");
  });

  it("handles undefined isError (treated as success)", () => {
    const mcpResult: McpCallResult = {
      content: [{ type: "text", text: "ok" }],
    };
    const result = mapResult(mcpResult);
    expect(result.details["isError"]).toBeFalsy();
    expect(result.content[0]?.text).toBe("ok");
  });

  it("never throws for any input shape", () => {
    const badInput = { isError: true, content: null } as unknown as McpCallResult;
    expect(() => mapResult(badInput)).not.toThrow();
  });
});
