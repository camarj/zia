/**
 * read.test.ts — Read builtin: rest-forwarding + cwd resolution (A.13, SPEC-F1-4, SPEC-F1-5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkToolDefinition } from "../wrap-definition.js";
import { clear } from "../../registry.js";

// Helper: create a mock SdkToolDefinition whose execute is a spy
function makeMockDef(name = "read"): {
  def: SdkToolDefinition;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "file contents" }],
    details: {},
  });

  const def: SdkToolDefinition = {
    name,
    label: `Mock ${name}`,
    description: `Mock description for ${name}`,
    parameters: {},
    execute: spy,
  };

  return { def, spy };
}

describe("read builtin — rest argument forwarding (SPEC-F1-4)", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("forwards signal, onUpdate, ctx as positional args to the SDK def.execute", async () => {
    const { wrapDefinition } = await import("../wrap-definition.js");
    const { def, spy } = makeMockDef("read");

    const wrapped = wrapDefinition(def);

    const id = "tc-001";
    const params = { file_path: "README.md" };
    const signalMock = { aborted: false };
    const onUpdateMock = vi.fn();
    const ctxMock = { cwd: "/tmp/agent" };

    await wrapped.execute(id, params, signalMock, onUpdateMock, ctxMock);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(id, params, signalMock, onUpdateMock, ctxMock);
  });

  it("returns normalized ToolResult with text content", async () => {
    const { wrapDefinition } = await import("../wrap-definition.js");
    const { def } = makeMockDef("read");

    const wrapped = wrapDefinition(def);
    const result = await wrapped.execute("id", {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("file contents");
    expect(result.details).toEqual({});
  });

  it("maps image content items to text placeholder (RR1 mitigation)", async () => {
    const { wrapDefinition } = await import("../wrap-definition.js");
    const spy = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "before" },
        { type: "image", data: "base64...", mimeType: "image/png" },
        { type: "text", text: "after" },
      ],
      details: {},
    });
    const def: SdkToolDefinition = {
      name: "read",
      label: "Read",
      description: "",
      parameters: {},
      execute: spy,
    };

    const wrapped = wrapDefinition(def);
    const result = await wrapped.execute("id", {});

    expect(result.content).toHaveLength(3);
    expect(result.content[1]!.text).toBe("[image omitted]");
  });
});

describe("read builtin — cwd resolution (SPEC-F1-5)", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("buildReadTool creates a tool with name 'read'", async () => {
    const { buildReadTool } = await import("../read.js");
    const tool = buildReadTool("/tmp/test-agent");
    expect(tool.name).toBe("read");
    expect(tool.label).toBeTruthy();
    expect(typeof tool.execute).toBe("function");
  });
});
