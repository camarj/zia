/**
 * frozen-snapshot-guard.test.ts — SPEC-FROZEN-1 guard.
 *
 * Frozen-snapshot invariant (Hermes golden rule, ADR-M7): MEMORY.md is read ONCE
 * at session boot by the prompt builder and frozen into the cached system prompt.
 * The agent core must NOT re-read MEMORY.md mid-session (that would break prompt
 * caching and the snapshot semantics). Reading MEMORY.md is the prompt builder's
 * sole responsibility.
 *
 * This static guard fails if agent.ts ever starts referencing MEMORY.md directly,
 * and confirms prompt-builder.ts remains the single reader.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// file → __tests__ → src → tools → packages → repo root (5 levels up)
const monorepoRoot = join(new URL(import.meta.url).pathname, "../../../../..");
const AGENT_TS = join(monorepoRoot, "packages/core/src/agent.ts");
const PROMPT_BUILDER_TS = join(monorepoRoot, "packages/core/src/prompt-builder.ts");

describe("frozen-snapshot invariant (SPEC-FROZEN-1)", () => {
  it("packages/core/src/agent.ts does NOT reference MEMORY.md (no mid-session re-read)", async () => {
    const content = await readFile(AGENT_TS, "utf8");
    expect(
      content.includes("MEMORY.md"),
      "agent.ts must not read MEMORY.md — that is prompt-builder.ts's responsibility, and re-reading would break the frozen snapshot",
    ).toBe(false);
  });

  it("prompt-builder.ts is the sole reader of MEMORY.md (read once at boot)", async () => {
    const content = await readFile(PROMPT_BUILDER_TS, "utf8");
    expect(
      content.includes("MEMORY.md"),
      "prompt-builder.ts must read MEMORY.md (the boot-time snapshot)",
    ).toBe(true);
  });
});
