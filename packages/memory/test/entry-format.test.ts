/**
 * entry-format.test.ts — Tests for entry serialization and parsing (SPEC-MEM-5).
 *
 * Pure functions, zero deps — fastest possible tests.
 */

import { describe, expect, it } from "vitest";
import { formatEntry, isoDate, parseEntries } from "../src/entry-format.ts";

// ---------------------------------------------------------------------------
// isoDate
// ---------------------------------------------------------------------------

describe("isoDate", () => {
  it("returns YYYY-MM-DD format for UTC date", () => {
    // Fix to a known UTC instant: 2026-05-30 10:00:00 UTC
    const date = new Date("2026-05-30T10:00:00.000Z");
    expect(isoDate(date)).toBe("2026-05-30");
  });

  it("uses UTC not local time", () => {
    // 2026-01-01T00:30:00Z is still 2026-01-01 in UTC
    const date = new Date("2026-01-01T00:30:00.000Z");
    expect(isoDate(date)).toBe("2026-01-01");
  });

  it("pads month and day to two digits", () => {
    const date = new Date("2026-03-05T12:00:00.000Z");
    expect(isoDate(date)).toBe("2026-03-05");
  });

  it("default argument uses current time without throwing", () => {
    const result = isoDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// formatEntry
// ---------------------------------------------------------------------------

describe("formatEntry", () => {
  it("produces # date header line + trimmed body + trailing newline", () => {
    const result = formatEntry("2026-05-30", "Learned: foo bar");
    expect(result).toBe("# 2026-05-30\nLearned: foo bar\n");
  });

  it("trims leading/trailing whitespace from body", () => {
    const result = formatEntry("2026-05-30", "  hello  ");
    expect(result).toBe("# 2026-05-30\nhello\n");
  });

  it("header line matches # YYYY-MM-DD pattern", () => {
    const result = formatEntry("2026-01-15", "content");
    const firstLine = result.split("\n")[0];
    expect(firstLine).toMatch(/^# \d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// parseEntries
// ---------------------------------------------------------------------------

describe("parseEntries", () => {
  it("returns [] for empty or whitespace-only string", () => {
    expect(parseEntries("")).toHaveLength(0);
    expect(parseEntries("   \n  ")).toHaveLength(0);
  });

  it("returns one entry for a single dated block", () => {
    const raw = "# 2026-05-30\nSome lesson here.\n";
    const entries = parseEntries(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.header).toBe("# 2026-05-30");
    expect(entries[0]!.raw).toContain("Some lesson here.");
  });

  it("returns three entries for three dated blocks", () => {
    const raw =
      "# 2026-05-01\nEntry 1.\n\n# 2026-05-02\nEntry 2.\n\n# 2026-05-03\nEntry 3.\n";
    const entries = parseEntries(raw);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.header).toBe("# 2026-05-01");
    expect(entries[1]!.header).toBe("# 2026-05-02");
    expect(entries[2]!.header).toBe("# 2026-05-03");
  });

  it("captures non-dated leading text as preamble with empty header", () => {
    const raw =
      "# Memoria del agente\n<!-- template -->\n\n# 2026-05-30\nEntry body.\n";
    const entries = parseEntries(raw);
    // First entry = preamble (header === "")
    expect(entries[0]!.header).toBe("");
    expect(entries[0]!.raw).toContain("Memoria del agente");
    // Second entry = dated entry
    expect(entries[1]!.header).toBe("# 2026-05-30");
    expect(entries[1]!.raw).toContain("Entry body.");
  });

  it("round-trips through formatEntry", () => {
    const entry = formatEntry("2026-05-30", "Customer pays net-30.");
    const entries = parseEntries(entry);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.header).toBe("# 2026-05-30");
    expect(entries[0]!.raw).toContain("Customer pays net-30.");
  });

  it("preserves document order (oldest first)", () => {
    const raw =
      "# 2026-04-01\nOld.\n\n# 2026-05-01\nMiddle.\n\n# 2026-06-01\nNew.\n";
    const entries = parseEntries(raw);
    expect(entries[0]!.header).toBe("# 2026-04-01");
    expect(entries[2]!.header).toBe("# 2026-06-01");
  });
});
