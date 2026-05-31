/**
 * write-memory.ts — Builtin write_memory tool (SPEC-TOOL-1, SPEC-TOOL-2, SPEC-TOOL-5).
 *
 * Risk level: medio — internal mutation, no external side-effect.
 * Listed in agents/_template/POLICIES.md under ## Medio.
 *
 * The tool factory accepts a MemoryWriteFn injected by the composition root
 * (tui.ts). This keeps @zia/tools free of @zia/memory and @zia/persistence
 * dependencies (GOV-2, SPEC-TOOL-5).
 *
 * FROZEN-SNAPSHOT UX NOTE (ADR-M7): the agent CANNOT see its own write in the
 * current session. The system prompt is frozen at boot. The description wording
 * below communicates this invariant to the model so it sets correct expectations.
 */

import type { ToolResult, WrappableTool } from "@zia/callbacks";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injected write function — keeps @zia/tools free of @zia/memory (GOV-2). */
export type MemoryWriteFn = (body: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Tool type (extends WrappableTool with riskLevel for inspection / tests)
// ---------------------------------------------------------------------------

export interface WriteMemoryTool extends WrappableTool {
  readonly riskLevel: "medio";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the write_memory WrappableTool with an injected write function.
 *
 * @param writeFn  Function that performs the actual memory write. Injected by
 *                 the composition root so @zia/tools never imports @zia/memory.
 */
export function buildWriteMemoryTool(writeFn: MemoryWriteFn): WriteMemoryTool {
  return {
    name: "write_memory",
    label: "Write Memory",
    riskLevel: "medio",
    description:
      "Append a lesson to your own long-term memory (MEMORY.md). Use this when you learn " +
      "something durable from your boss's feedback or from a completed task. " +
      "NOTE: the entry is saved to disk immediately but does NOT appear in your current " +
      "context — you will only read it back at the START of a future session. " +
      "Do not expect search_memory to return what you just wrote in this same session.",
    parameters: Type.Object({
      entry: Type.String({
        description: "The lesson or information to store. Be concise and self-contained.",
      }),
    }),

    async execute(
      _id: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult> {
      const entry = String(params["entry"] ?? "").trim();

      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: "Nothing to write — entry was empty or whitespace only.",
            },
          ],
          details: { written: false },
        };
      }

      await writeFn(entry);

      return {
        content: [{ type: "text", text: "Memory updated." }],
        details: { written: true },
      };
    },
  };
}
