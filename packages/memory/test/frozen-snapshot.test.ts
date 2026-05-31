/**
 * frozen-snapshot.test.ts — SPEC-FROZEN-2.
 *
 * Verifies that after FileBasedMemoryProvider.write() persists an entry to
 * MEMORY.md, a subsequent prompt-assembly read (simulating the next session's
 * buildPromptFromFicha call) picks up the written content.
 *
 * Rather than importing @zia/core (which would violate the spirit of GOV-1 and
 * add a real cross-package dependency for a test), we replicate the minimal
 * readFichaFile logic from prompt-builder.ts inline — the spec explicitly
 * permits this ("import from @zia/core OR replicate readFichaFile logic").
 *
 * This keeps @zia/memory free of any @zia/core dependency at all levels.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBasedMemoryProvider } from "../src/file-based.ts";

// ---------------------------------------------------------------------------
// Minimal "next-session read" — mirrors prompt-builder.ts readFichaFile logic
// ---------------------------------------------------------------------------

/**
 * Read a ficha file, return its trimmed content or undefined if absent.
 * Replicates the relevant subset of packages/core/src/prompt-builder.ts.
 */
async function readFichaFile(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim().length === 0 ? undefined : raw;
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Simulate buildPromptFromFicha: reads MEMORY.md from fichaDir and returns
 * a string that would appear in the assembled system prompt.
 */
async function simulateNextSessionRead(fichaDir: string): Promise<string> {
  const memoryContent = await readFichaFile(join(fichaDir, "MEMORY.md"));
  if (!memoryContent) return "";
  return `# MEMORY (snapshot)\n\n${memoryContent}`;
}

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zia-frozen-snapshot-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SPEC-FROZEN-2 — next-session read picks up the appended entry
// ---------------------------------------------------------------------------

describe("frozen-snapshot: next session reads updated MEMORY.md (SPEC-FROZEN-2)", () => {
  it("simulated next-session read contains the appended entry text", async () => {
    const provider = new FileBasedMemoryProvider(join(tempDir, "MEMORY.md"));
    const uniqueMarker = "UniqueLesson_2026_FrozenSnapshot";
    await provider.write(uniqueMarker, new Date("2026-05-30T10:00:00.000Z"));

    const prompt = await simulateNextSessionRead(tempDir);

    expect(prompt).toContain(uniqueMarker);
  });

  it("MEMORY.md content appears under the MEMORY snapshot section", async () => {
    const provider = new FileBasedMemoryProvider(join(tempDir, "MEMORY.md"));
    await provider.write("Lesson about invoices.", new Date("2026-05-30T10:00:00.000Z"));

    const prompt = await simulateNextSessionRead(tempDir);

    expect(prompt).toContain("MEMORY (snapshot)");
    expect(prompt).toContain("Lesson about invoices.");
  });

  it("multiple writes are all present in the next-session read", async () => {
    const provider = new FileBasedMemoryProvider(join(tempDir, "MEMORY.md"));
    await provider.write("First lesson.", new Date("2026-05-01T00:00:00.000Z"));
    await provider.write("Second lesson.", new Date("2026-05-02T00:00:00.000Z"));

    const prompt = await simulateNextSessionRead(tempDir);

    expect(prompt).toContain("First lesson.");
    expect(prompt).toContain("Second lesson.");
  });

  it("returns empty string when MEMORY.md does not exist", async () => {
    // No writes — MEMORY.md absent
    const prompt = await simulateNextSessionRead(tempDir);
    expect(prompt).toBe("");
  });

  it("date header from write() appears in the next-session read", async () => {
    const provider = new FileBasedMemoryProvider(join(tempDir, "MEMORY.md"));
    await provider.write("Dated lesson.", new Date("2026-05-30T10:00:00.000Z"));

    const prompt = await simulateNextSessionRead(tempDir);

    expect(prompt).toContain("# 2026-05-30");
  });
});
