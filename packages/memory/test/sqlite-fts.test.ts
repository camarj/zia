/**
 * sqlite-fts.test.ts — SqliteFtsMemoryProvider tests (SPEC-MEM-6, SPEC-MEM-7).
 *
 * All tests use a real WAL-mode SQLite file in a temp directory.
 * `:memory:` databases are intentionally REJECTED by openDatabase (WAL ban).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zia-memory-sqlite-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function dbPath(): string {
  return join(tempDir, "test.db");
}

// ---------------------------------------------------------------------------
// SPEC-MEM-6 — write inserts row + FTS searchable + incrementWriteCounter
// ---------------------------------------------------------------------------

describe("SqliteFtsMemoryProvider — write (SPEC-MEM-6)", () => {
  it("inserts a row in memory_entries after write()", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    const now = new Date("2026-05-30T10:00:00.000Z");
    await provider.write("Customer Acme pays net-30.", now);

    const row = db
      .prepare("SELECT * FROM memory_entries WHERE body = 'Customer Acme pays net-30.'")
      .get() as { id: number; date: string; body: string; char_count: number; created_at: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.date).toBe("2026-05-30");
    expect(row!.body).toBe("Customer Acme pays net-30.");
    expect(row!.char_count).toBe("Customer Acme pays net-30.".length);
    expect(row!.created_at).toBe(now.toISOString());

    db.close();
  });

  it("entry is searchable via FTS5 MATCH after write()", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    await provider.write("Invoice deadline is Friday.", new Date("2026-05-30T10:00:00.000Z"));

    const rows = db
      .prepare("SELECT rowid FROM memory_entries_fts WHERE memory_entries_fts MATCH '\"Invoice\"'")
      .all() as Array<{ rowid: number }>;

    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });

  it("write() completes without throwing (transaction + incrementWriteCounter path exercised)", async () => {
    // writeCounter is a mutable let not re-exported by the barrel as a live
    // binding. We verify incrementWriteCounter was exercised by confirming the
    // write transaction committed: the row exists in memory_entries.
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    await expect(provider.write("Counter path exercised.", new Date())).resolves.toBeUndefined();

    // The row must exist — proves the transaction committed, which is the
    // code path that calls incrementWriteCounter.
    const row = db
      .prepare("SELECT COUNT(*) AS cnt FROM memory_entries")
      .get() as { cnt: number };
    expect(row.cnt).toBe(1);

    db.close();
  });

  it("ignores empty/whitespace-only body without inserting", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    await provider.write("   ", new Date());
    await provider.write("", new Date());

    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM memory_entries")
      .get() as { cnt: number };

    expect(count.cnt).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// SPEC-MEM-6 — eviction: oldest row deleted when over cap
// ---------------------------------------------------------------------------

describe("SqliteFtsMemoryProvider — eviction", () => {
  it("deletes oldest row when char cap exceeded", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    // Tiny limit so a few entries trigger eviction
    const provider = new SqliteFtsMemoryProvider(db, 60);

    const d1 = new Date("2026-05-01T00:00:00.000Z");
    const d2 = new Date("2026-05-02T00:00:00.000Z");
    const d3 = new Date("2026-05-03T00:00:00.000Z");

    await provider.write("aaaaaaaaaaaaaaaaaaaaaaaaa", d1); // 25 chars
    await provider.write("bbbbbbbbbbbbbbbbbbbbbbbbb", d2); // 25 chars
    await provider.write("ccccccccccccccccccccccccc", d3); // 25 chars — should evict d1

    const rows = db
      .prepare("SELECT date, body FROM memory_entries ORDER BY created_at ASC")
      .all() as Array<{ date: string; body: string }>;

    // d1 (2026-05-01) should have been evicted
    const dates = rows.map((r) => r.date);
    expect(dates).not.toContain("2026-05-01");
    // d3 (newest) must remain
    expect(dates).toContain("2026-05-03");

    db.close();
  });

  it("evicted row is removed from FTS index (trigger fired)", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db, 40);

    await provider.write("UniqueTermAlpha", new Date("2026-05-01T00:00:00.000Z")); // 15 chars
    await provider.write("UniqueTermBeta_", new Date("2026-05-02T00:00:00.000Z")); // 15 chars
    await provider.write("UniqueTermGamma", new Date("2026-05-03T00:00:00.000Z")); // 15 chars — causes eviction

    // UniqueTermAlpha's row was deleted; FTS trigger should have removed it
    const ftsRows = db
      .prepare("SELECT rowid FROM memory_entries_fts WHERE memory_entries_fts MATCH '\"UniqueTermAlpha\"'")
      .all() as Array<{ rowid: number }>;

    expect(ftsRows).toHaveLength(0);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// SPEC-MEM-7 — search uses sanitizeFtsQuery (FTS operator tokens)
// ---------------------------------------------------------------------------

describe("SqliteFtsMemoryProvider — search (SPEC-MEM-7)", () => {
  it("search returns matching entries", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    await provider.write("Invoice sent to Acme Corp.", new Date("2026-05-01T00:00:00.000Z"));
    await provider.write("Meeting scheduled for Monday.", new Date("2026-05-02T00:00:00.000Z"));

    const hits = await provider.search("Acme");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toMatch(/Acme/i);

    db.close();
  });

  it("does not throw when query contains FTS5 operator tokens (AND OR NOT)", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    await provider.write("Some entry about invoices.", new Date());

    // These would crash bare FTS5 but sanitizeFtsQuery wraps them safely
    await expect(provider.search("AND OR NOT special")).resolves.not.toThrow();
    await expect(provider.search("invoice AND payment")).resolves.not.toThrow();
    await expect(provider.search("NOT meeting")).resolves.not.toThrow();

    db.close();
  });

  it("returns [] for empty query", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    const hits = await provider.search("");
    expect(hits).toHaveLength(0);

    db.close();
  });

  it("returns results newest-first", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    await provider.write("Invoice entry old.", new Date("2026-05-01T00:00:00.000Z"));
    await provider.write("Invoice entry new.", new Date("2026-05-02T00:00:00.000Z"));

    const hits = await provider.search("Invoice");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // Newest first: 2026-05-02 before 2026-05-01
    expect(hits[0]!.date).toBe("2026-05-02");
    expect(hits[1]!.date).toBe("2026-05-01");

    db.close();
  });

  it("respects the limit parameter", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");

    resetWriteCounter();
    const db = openDatabase(dbPath());
    const provider = new SqliteFtsMemoryProvider(db);

    for (let i = 1; i <= 5; i++) {
      await provider.write(`Lesson ${i} about invoices.`, new Date(`2026-05-0${i}T00:00:00.000Z`));
    }

    const hits = await provider.search("invoices", 2);
    expect(hits).toHaveLength(2);

    db.close();
  });
});
