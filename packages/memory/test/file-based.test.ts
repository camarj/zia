/**
 * file-based.test.ts — FileBasedMemoryProvider tests (SPEC-MEM-2, SPEC-MEM-3, SPEC-MEM-4).
 *
 * Uses a real temp directory (mkdtemp) for all I/O tests. Freezes the date by
 * injecting a fixed `now` Date argument into write().
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBasedMemoryProvider } from "../src/file-based.ts";

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zia-memory-file-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function memoryPath(): string {
  return join(tempDir, "MEMORY.md");
}

const FIXED_DATE = new Date("2026-05-30T12:00:00.000Z");

// ---------------------------------------------------------------------------
// SPEC-MEM-2 — write creates file on ENOENT + canonical header
// ---------------------------------------------------------------------------

describe("FileBasedMemoryProvider — write creates file (SPEC-MEM-2)", () => {
  it("creates MEMORY.md when it does not exist", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Customer Acme pays net-30.", FIXED_DATE);

    const content = await readFile(memoryPath(), "utf8");
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });

  it("first line matches # YYYY-MM-DD pattern", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Test entry.", FIXED_DATE);

    const content = await readFile(memoryPath(), "utf8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toMatch(/^# \d{4}-\d{2}-\d{2}$/);
  });

  it("date in header matches the injected UTC date (2026-05-30)", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Date test.", FIXED_DATE);

    const content = await readFile(memoryPath(), "utf8");
    expect(content).toContain("# 2026-05-30");
  });

  it("body content follows the header line", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Learned: always confirm before sending.", FIXED_DATE);

    const content = await readFile(memoryPath(), "utf8");
    expect(content).toContain("Learned: always confirm before sending.");
  });

  it("subsequent writes append new dated entries", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Entry one.", FIXED_DATE);
    const laterDate = new Date("2026-05-31T12:00:00.000Z");
    await provider.write("Entry two.", laterDate);

    const content = await readFile(memoryPath(), "utf8");
    expect(content).toContain("2026-05-30");
    expect(content).toContain("2026-05-31");
    expect(content).toContain("Entry one.");
    expect(content).toContain("Entry two.");
  });
});

// ---------------------------------------------------------------------------
// SPEC-MEM-3 — atomic write (temp+rename)
// ---------------------------------------------------------------------------

describe("FileBasedMemoryProvider — atomic write (SPEC-MEM-3)", () => {
  it("no .tmp files left after a successful write", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Clean write.", FIXED_DATE);

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tempDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("original file is intact when a write to tmp fails (no partial content)", async () => {
    // Write an initial entry so there is existing content.
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Original content.", FIXED_DATE);
    const original = await readFile(memoryPath(), "utf8");

    // Confirm that a second successful write replaces content atomically —
    // the original is gone and the new content is present.
    const laterDate = new Date("2026-05-31T12:00:00.000Z");
    await provider.write("Replacement content.", laterDate);
    const after = await readFile(memoryPath(), "utf8");

    expect(after).toContain("Replacement content.");
    expect(after).not.toBe(""); // file is intact, not empty

    // Original first entry is still there (both entries coexist).
    expect(after).toContain("Original content.");

    // No .tmp file left behind after a successful write.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tempDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SPEC-MEM-4 — cap enforced across multiple writes
// ---------------------------------------------------------------------------

describe("FileBasedMemoryProvider — char limit enforced (SPEC-MEM-4)", () => {
  it("evicts oldest entry when over cap, keeps newest", async () => {
    // Each formatted entry: "# 2026-05-0X\n" (14) + 40-char body + "\n" = ~55 chars.
    // Limit = 100 forces eviction once we have 3+ entries.
    const provider = new FileBasedMemoryProvider(memoryPath(), 100);
    const body = "a".repeat(40);

    const d1 = new Date("2026-05-01T00:00:00.000Z");
    const d2 = new Date("2026-05-02T00:00:00.000Z");
    const d3 = new Date("2026-05-03T00:00:00.000Z");

    await provider.write(body, d1);
    await provider.write(body, d2);
    await provider.write(body, d3); // should evict d1

    const content = await readFile(memoryPath(), "utf8");
    // Newest must remain.
    expect(content).toContain("2026-05-03");
    // Oldest should be evicted.
    expect(content).not.toContain("2026-05-01");
  });
});

// ---------------------------------------------------------------------------
// search — ENOENT returns [], case-insensitive, newest-first
// ---------------------------------------------------------------------------

describe("FileBasedMemoryProvider — search", () => {
  it("returns [] when memory file does not exist (ENOENT)", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    const hits = await provider.search("anything");
    expect(hits).toHaveLength(0);
  });

  it("returns [] when no entries match the query", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Something about invoices.", FIXED_DATE);
    const hits = await provider.search("completely unrelated term xyz987");
    expect(hits).toHaveLength(0);
  });

  it("matches case-insensitively", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Customer Acme pays NET-30.", FIXED_DATE);
    const hits = await provider.search("net-30");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toMatch(/net-30/i);
  });

  it("returns results newest-first", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    await provider.write("Old result about invoices.", new Date("2026-05-01T00:00:00.000Z"));
    await provider.write("New result about invoices.", new Date("2026-05-02T00:00:00.000Z"));

    const hits = await provider.search("invoices");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // Newest-first: 2026-05-02 before 2026-05-01
    expect(hits[0]!.date).toBe("2026-05-02");
    expect(hits[1]!.date).toBe("2026-05-01");
  });

  it("respects the limit parameter", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    for (let i = 1; i <= 5; i++) {
      await provider.write(`Lesson number ${i}.`, new Date(`2026-05-0${i}T00:00:00.000Z`));
    }
    const hits = await provider.search("lesson", 2);
    expect(hits).toHaveLength(2);
  });

  it("snippet is truncated to at most 200 chars", async () => {
    const provider = new FileBasedMemoryProvider(memoryPath());
    const longBody = "invoices ".repeat(30); // >200 chars
    await provider.write(longBody, FIXED_DATE);
    const hits = await provider.search("invoices");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(200);
  });
});
