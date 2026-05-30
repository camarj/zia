/**
 * char-limit.test.ts — Tests for the deterministic eviction algorithm (SPEC-MEM-4, SPEC-MEM-5).
 *
 * Pure functions, zero deps.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_CHAR_LIMIT, applyCharLimit } from "../src/char-limit.ts";
import { formatEntry } from "../src/entry-format.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(date: string, body: string): string {
  return formatEntry(date, body);
}

/** Build a string of exactly `n` chars. */
function padToLength(n: number, filler = "x"): string {
  return filler.repeat(n);
}

// ---------------------------------------------------------------------------
// DEFAULT_MEMORY_CHAR_LIMIT
// ---------------------------------------------------------------------------

describe("DEFAULT_MEMORY_CHAR_LIMIT", () => {
  it("is 50_000", () => {
    expect(DEFAULT_MEMORY_CHAR_LIMIT).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// applyCharLimit — under-cap passthrough
// ---------------------------------------------------------------------------

describe("applyCharLimit — under-cap passthrough", () => {
  it("returns combined content unchanged when under limit", () => {
    const existing = makeEntry("2026-05-01", "First lesson.");
    const newEntry = makeEntry("2026-05-02", "Second lesson.");
    const result = applyCharLimit(existing, newEntry, 50_000);
    expect(result).toContain("First lesson.");
    expect(result).toContain("Second lesson.");
  });

  it("returns newEntry alone when existing is empty string", () => {
    const newEntry = makeEntry("2026-05-30", "First ever.");
    const result = applyCharLimit("", newEntry, 50_000);
    expect(result).toBe(newEntry);
  });

  it("returns newEntry alone when existing is whitespace-only", () => {
    const newEntry = makeEntry("2026-05-30", "Fresh start.");
    const result = applyCharLimit("   \n   ", newEntry, 50_000);
    expect(result).toBe(newEntry);
  });
});

// ---------------------------------------------------------------------------
// applyCharLimit — eviction
// ---------------------------------------------------------------------------

describe("applyCharLimit — eviction drops oldest whole entry only", () => {
  it("evicts E1 when E1+E2+E3+new > limit", () => {
    // Each entry is ~50 chars. Limit = 150 forces eviction of oldest when 4 entries added.
    const e1 = makeEntry("2026-05-01", padToLength(30, "a"));
    const e2 = makeEntry("2026-05-02", padToLength(30, "b"));
    const e3 = makeEntry("2026-05-03", padToLength(30, "c"));
    const existing = `${e1}\n\n${e2}\n\n${e3}`.trimEnd() + "\n";
    const newEntry = makeEntry("2026-05-04", padToLength(30, "d"));

    const result = applyCharLimit(existing, newEntry, 150);

    expect(result).not.toContain("2026-05-01");
    expect(result).toContain("2026-05-02");
    expect(result).toContain("2026-05-03");
    expect(result).toContain("2026-05-04");
  });

  it("evicts multiple old entries until under limit", () => {
    // Three large entries that together exceed a small limit
    const e1 = makeEntry("2026-05-01", padToLength(100, "a"));
    const e2 = makeEntry("2026-05-02", padToLength(100, "b"));
    const e3 = makeEntry("2026-05-03", padToLength(100, "c"));
    const existing = `${e1}\n\n${e2}\n\n${e3}`.trimEnd() + "\n";
    const newEntry = makeEntry("2026-05-04", padToLength(100, "d"));

    // Limit = 250 — only newest two entries + new should fit
    const result = applyCharLimit(existing, newEntry, 250);

    expect(result).not.toContain("2026-05-01");
    expect(result).not.toContain("2026-05-02");
    expect(result).toContain("2026-05-03");
    expect(result).toContain("2026-05-04");
  });
});

// ---------------------------------------------------------------------------
// applyCharLimit — preamble never evicted
// ---------------------------------------------------------------------------

describe("applyCharLimit — preamble never evicted", () => {
  it("keeps preamble even after evicting all dated entries", () => {
    const preamble = "# Memoria del agente\n<!-- agent memory -->\n";
    const e1 = makeEntry("2026-05-01", padToLength(50, "a"));
    const existing = `${preamble}\n${e1}`;
    const newEntry = makeEntry("2026-05-02", padToLength(50, "b"));

    // Limit = 80 — dated entries exceed it, but preamble is sticky
    const result = applyCharLimit(existing, newEntry, 80);

    expect(result).toContain("Memoria del agente");
    // Latest entry should be kept (newest-write-wins)
    expect(result).toContain("2026-05-02");
  });
});

// ---------------------------------------------------------------------------
// applyCharLimit — single oversized entry kept (newest-write-wins edge case)
// ---------------------------------------------------------------------------

describe("applyCharLimit — single oversized entry edge case", () => {
  it("keeps a single new entry even if it alone exceeds the limit", () => {
    const existing = makeEntry("2026-05-01", padToLength(10, "a"));
    const newEntry = makeEntry("2026-05-02", padToLength(200, "b"));

    // Limit = 50 — new entry alone exceeds it, but it must still be kept
    const result = applyCharLimit(existing, newEntry, 50);

    expect(result).toContain("2026-05-02");
    // Old entry is evicted
    expect(result).not.toContain("2026-05-01");
  });
});

// ---------------------------------------------------------------------------
// applyCharLimit — ordering preserved after eviction
// ---------------------------------------------------------------------------

describe("applyCharLimit — ordering preserved after eviction", () => {
  it("entries remain in chronological order after eviction", () => {
    const e1 = makeEntry("2026-05-01", padToLength(40, "a"));
    const e2 = makeEntry("2026-05-02", padToLength(40, "b"));
    const e3 = makeEntry("2026-05-03", padToLength(40, "c"));
    const existing = `${e1}\n\n${e2}\n\n${e3}`.trimEnd() + "\n";
    const newEntry = makeEntry("2026-05-04", padToLength(40, "d"));

    const result = applyCharLimit(existing, newEntry, 200);

    const idx2 = result.indexOf("2026-05-02");
    const idx3 = result.indexOf("2026-05-03");
    const idx4 = result.indexOf("2026-05-04");

    // If e1 is present (result may or may not have evicted it), the ones that
    // survive must be in order
    if (idx2 !== -1) {
      expect(idx2).toBeLessThan(idx3);
    }
    expect(idx3).toBeLessThan(idx4);
  });
});
