/**
 * write.test.ts — Write builtin: rest-forwarding (A.13, SPEC-F1-4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkToolDefinition } from "../wrap-definition.js";
import { clear } from "../../registry.js";

describe("write builtin — rest argument forwarding (SPEC-F1-4)", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("forwards signal, onUpdate, ctx positionally to SDK def.execute", async () => {
    const { wrapDefinition } = await import("../wrap-definition.js");

    const spy = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "written" }],
      details: {},
    });

    const def: SdkToolDefinition = {
      name: "write",
      label: "Write",
      description: "Write a file",
      parameters: {},
      execute: spy,
    };

    const wrapped = wrapDefinition(def);

    const id = "tc-write-001";
    const params = { file_path: "out.txt", content: "hello" };
    const signalMock = { aborted: false };
    const onUpdateMock = vi.fn();
    const ctxMock = { cwd: "/tmp" };

    await wrapped.execute(id, params, signalMock, onUpdateMock, ctxMock);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(id, params, signalMock, onUpdateMock, ctxMock);
  });

  it("buildWriteTool creates a tool with name 'write'", async () => {
    const { buildWriteTool } = await import("../write.js");
    const tool = buildWriteTool("/tmp/agent");
    expect(tool.name).toBe("write");
  });
});
