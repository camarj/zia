/**
 * edit.test.ts — Edit builtin: rest-forwarding (A.13, SPEC-F1-4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkToolDefinition } from "../wrap-definition.js";
import { clear } from "../../registry.js";

describe("edit builtin — rest argument forwarding (SPEC-F1-4)", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("forwards signal, onUpdate, ctx positionally to SDK def.execute", async () => {
    const { wrapDefinition } = await import("../wrap-definition.js");

    const spy = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "edited" }],
      details: {},
    });

    const def: SdkToolDefinition = {
      name: "edit",
      label: "Edit",
      description: "Edit a file",
      parameters: {},
      execute: spy,
    };

    const wrapped = wrapDefinition(def);

    const id = "tc-edit-001";
    const params = { file_path: "README.md", old_string: "foo", new_string: "bar" };
    const signalMock = { aborted: false };
    const onUpdateMock = vi.fn();
    const ctxMock = { cwd: "/tmp" };

    await wrapped.execute(id, params, signalMock, onUpdateMock, ctxMock);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(id, params, signalMock, onUpdateMock, ctxMock);
  });

  it("buildEditTool creates a tool with name 'edit'", async () => {
    const { buildEditTool } = await import("../edit.js");
    const tool = buildEditTool("/tmp/agent");
    expect(tool.name).toBe("edit");
  });
});
