/**
 * write-memory.test.ts — buildWriteMemoryTool tests (SPEC-TOOL-1, SPEC-TOOL-2).
 *
 * Verifies the write_memory tool's identity (name/label/risk), parameter schema,
 * that it invokes the injected MemoryWriteFn with the trimmed entry, and that an
 * empty/whitespace entry is a no-op that does not call the write function.
 */

import { describe, expect, it, vi } from "vitest";
import { buildWriteMemoryTool } from "../write-memory.js";

describe("buildWriteMemoryTool — identity (SPEC-TOOL-1)", () => {
  it("has name 'write_memory', label, and riskLevel 'medio'", () => {
    const tool = buildWriteMemoryTool(async () => {});
    expect(tool.name).toBe("write_memory");
    expect(tool.label).toBe("Write Memory");
    expect(tool.riskLevel).toBe("medio");
  });

  it("exposes an 'entry' string parameter", () => {
    const tool = buildWriteMemoryTool(async () => {});
    expect(tool.parameters).toBeDefined();
    // typebox object schema — entry is a required property
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("entry");
  });
});

describe("buildWriteMemoryTool — execute (SPEC-TOOL-2)", () => {
  it("invokes the injected writeFn with the trimmed entry and reports success", async () => {
    const writeFn = vi.fn(async (_body: string): Promise<void> => {});
    const tool = buildWriteMemoryTool(writeFn);

    const result = await tool.execute("call-1", { entry: "  remember the deadline  " });

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith("remember the deadline");
    expect(result.details).toMatchObject({ written: true });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("does NOT call writeFn when the entry is empty", async () => {
    const writeFn = vi.fn(async () => {});
    const tool = buildWriteMemoryTool(writeFn);

    const result = await tool.execute("call-2", { entry: "" });

    expect(writeFn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ written: false });
  });

  it("does NOT call writeFn when the entry is whitespace only", async () => {
    const writeFn = vi.fn(async () => {});
    const tool = buildWriteMemoryTool(writeFn);

    const result = await tool.execute("call-3", { entry: "   \n\t  " });

    expect(writeFn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ written: false });
  });

  it("treats a missing entry param as empty (no throw, no write)", async () => {
    const writeFn = vi.fn(async () => {});
    const tool = buildWriteMemoryTool(writeFn);

    const result = await tool.execute("call-4", {});

    expect(writeFn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ written: false });
  });
});
