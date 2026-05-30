/**
 * bash.test.ts — Bash builtin: rest-forwarding (A.13, SPEC-F1-4).
 *
 * bash is alto risk — critical that signal/ctx flow through to the SDK body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkToolDefinition } from "../wrap-definition.js";
import { clear } from "../../registry.js";

describe("bash builtin — rest argument forwarding (SPEC-F1-4)", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("forwards signal, onUpdate, ctx positionally to SDK def.execute", async () => {
    const { wrapDefinition } = await import("../wrap-definition.js");

    const spy = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: {},
    });

    const def: SdkToolDefinition = {
      name: "bash",
      label: "Bash",
      description: "Run shell commands",
      parameters: {},
      execute: spy,
    };

    const wrapped = wrapDefinition(def);

    const id = "tc-bash-001";
    const params = { command: "echo hello" };
    const signalMock = { aborted: false };
    const onUpdateMock = vi.fn();
    const ctxMock = { cwd: "/tmp" };

    await wrapped.execute(id, params, signalMock, onUpdateMock, ctxMock);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(id, params, signalMock, onUpdateMock, ctxMock);
  });

  it("buildBashTool creates a tool with name 'bash'", async () => {
    const { buildBashTool } = await import("../bash.js");
    const tool = buildBashTool("/tmp/agent");
    expect(tool.name).toBe("bash");
    expect(tool.label).toBeTruthy();
  });
});
