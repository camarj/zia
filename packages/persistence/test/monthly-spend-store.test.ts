/**
 * monthly-spend-store.test.ts — MonthlySpendStore unit tests (SPEC-SPEND-STORE-1)
 *
 * Covers:
 *   SPEC-SPEND-STORE-1-A  accumulate + getSpend basic (two accumulations sum correctly)
 *   SPEC-SPEND-STORE-1-B  monthly rollover (new month creates new row; old month untouched)
 *   SPEC-SPEND-STORE-1-C  getSpend returns 0 on missing row (no error, no throw)
 *   SPEC-SPEND-STORE-1-D  getSpend fail-open on DB error (returns 0, logs warning, no throw)
 *   SPEC-SPEND-STORE-1-E  year_month boundary — defaults to UTC 'YYYY-MM'
 *
 * All tests use real in-memory-backed SQLite via temp files (WAL required by openDatabase).
 * TDD: these tests MUST fail before monthly-spend-store.ts is implemented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonthlySpendStore } from "../src/monthly-spend-store.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-spend-store-"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(dbPath: string): Promise<MonthlySpendStore> {
  const { openDatabase } = await import("../src/db.ts");
  const { createMonthlySpendStore } = await import("../src/monthly-spend-store.ts");
  const db = openDatabase(dbPath);
  return createMonthlySpendStore(db);
}

// ---------------------------------------------------------------------------

describe("MonthlySpendStore — accumulate + getSpend (SPEC-SPEND-STORE-1-A)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("accumulating twice sums correctly", async () => {
    const store = await makeStore(join(tempDir, "sum.db"));

    store.accumulate("fin-001", 0.05);
    store.accumulate("fin-001", 0.03);

    expect(store.getSpend("fin-001")).toBeCloseTo(0.08, 9);
  });

  it("first accumulation creates a row", async () => {
    const store = await makeStore(join(tempDir, "first.db"));

    store.accumulate("agent-a", 1.23);

    expect(store.getSpend("agent-a")).toBeCloseTo(1.23, 9);
  });

  it("accumulate with explicit yearMonth", async () => {
    const store = await makeStore(join(tempDir, "explicit-ym.db"));

    store.accumulate("agent-b", 5.00, "2026-03");

    expect(store.getSpend("agent-b", "2026-03")).toBeCloseTo(5.00, 9);
  });

  it("multiple agents are isolated", async () => {
    const store = await makeStore(join(tempDir, "isolated.db"));

    store.accumulate("agent-x", 10.00);
    store.accumulate("agent-y", 20.00);

    expect(store.getSpend("agent-x")).toBeCloseTo(10.00, 9);
    expect(store.getSpend("agent-y")).toBeCloseTo(20.00, 9);
  });
});

// ---------------------------------------------------------------------------

describe("MonthlySpendStore — monthly rollover (SPEC-SPEND-STORE-1-B)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("accumulating in a different month creates a new row", async () => {
    const store = await makeStore(join(tempDir, "rollover.db"));

    // Seed January row
    store.accumulate("fin-001", 45.00, "2026-01");

    // Accumulate in February
    store.accumulate("fin-001", 5.00, "2026-02");

    expect(store.getSpend("fin-001", "2026-02")).toBeCloseTo(5.00, 9);
  });

  it("January row is untouched after February accumulation (SPEC-SPEND-STORE-1-B)", async () => {
    const store = await makeStore(join(tempDir, "jan-intact.db"));

    store.accumulate("fin-001", 45.00, "2026-01");
    store.accumulate("fin-001", 5.00, "2026-02");

    expect(store.getSpend("fin-001", "2026-01")).toBeCloseTo(45.00, 9);
  });
});

// ---------------------------------------------------------------------------

describe("MonthlySpendStore — getSpend missing row (SPEC-SPEND-STORE-1-C)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns 0 when no row exists for the agent", async () => {
    const store = await makeStore(join(tempDir, "missing.db"));

    expect(store.getSpend("no-such-agent")).toBe(0);
  });

  it("returns 0 when agent exists but not for the given month", async () => {
    const store = await makeStore(join(tempDir, "missing-month.db"));

    store.accumulate("agent-z", 1.00, "2026-01");

    expect(store.getSpend("agent-z", "2026-02")).toBe(0);
  });

  it("getSpend does not throw when row is missing", async () => {
    const store = await makeStore(join(tempDir, "no-throw.db"));

    expect(() => store.getSpend("ghost-agent")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("MonthlySpendStore — getSpend fail-open on DB error (SPEC-SPEND-STORE-1-D)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns 0 when the DB connection is closed", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { createMonthlySpendStore } = await import("../src/monthly-spend-store.ts");
    const dbPath = join(tempDir, "broken.db");
    const db = openDatabase(dbPath);
    const store = createMonthlySpendStore(db);

    // Close the DB to simulate a broken connection
    db.close();

    expect(store.getSpend("fin-001")).toBe(0);
  });

  it("logs a warning to stderr when DB is broken", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { createMonthlySpendStore } = await import("../src/monthly-spend-store.ts");
    const dbPath = join(tempDir, "broken-warn.db");
    const db = openDatabase(dbPath);
    const store = createMonthlySpendStore(db);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    db.close();

    store.getSpend("fin-001");

    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("does NOT throw when DB is broken", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { createMonthlySpendStore } = await import("../src/monthly-spend-store.ts");
    const dbPath = join(tempDir, "broken-nothrow.db");
    const db = openDatabase(dbPath);
    const store = createMonthlySpendStore(db);

    db.close();

    expect(() => store.getSpend("fin-001")).not.toThrow();
  });

  it("getSpendOrThrow throws on DB error (for test detection)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { createMonthlySpendStore } = await import("../src/monthly-spend-store.ts");
    const dbPath = join(tempDir, "throw.db");
    const db = openDatabase(dbPath);
    const store = createMonthlySpendStore(db);

    db.close();

    expect(() => store.getSpendOrThrow("fin-001")).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("MonthlySpendStore — year_month boundary UTC (SPEC-SPEND-STORE-1-E)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("default yearMonth is UTC YYYY-MM from new Date()", async () => {
    const store = await makeStore(join(tempDir, "utc-ym.db"));

    const expectedYearMonth = new Date().toISOString().slice(0, 7);

    store.accumulate("fin-001", 1.00);

    expect(store.getSpend("fin-001", expectedYearMonth)).toBeCloseTo(1.00, 9);
  });

  it("accumulate at UTC 2026-01-31 23:59:59 writes row keyed '2026-01' (default yearMonth path)", async () => {
    // Freeze the system clock at the UTC month boundary and exercise the DEFAULT
    // yearMonth path — accumulate() with no yearMonth arg must derive '2026-01'
    // from the frozen clock, NOT roll into '2026-02'.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T23:59:59Z"));
    try {
      const store = await makeStore(join(tempDir, "boundary.db"));

      store.accumulate("fin-001", 1.0); // no yearMonth → derived from frozen clock

      // The row must be keyed '2026-01', not '2026-02'.
      expect(store.getSpend("fin-001", "2026-01")).toBeCloseTo(1.0, 9);
      expect(store.getSpend("fin-001", "2026-02")).toBe(0);
      // And the default-arg read at the same frozen instant resolves to the same row.
      expect(store.getSpend("fin-001")).toBeCloseTo(1.0, 9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("year_month from getSpend default also uses UTC", async () => {
    const store = await makeStore(join(tempDir, "utc-get.db"));

    const expectedYearMonth = new Date().toISOString().slice(0, 7);

    store.accumulate("fin-001", 2.50, expectedYearMonth);

    // getSpend with no args should resolve the same default month
    expect(store.getSpend("fin-001")).toBeCloseTo(2.50, 9);
  });
});

// ---------------------------------------------------------------------------

describe("MonthlySpendStore — delta validation", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("accumulate with delta=0 is a no-op (does not insert a row)", async () => {
    const store = await makeStore(join(tempDir, "delta-zero.db"));

    store.accumulate("agent-a", 0);

    // Row should not be written (getSpend returns 0 for missing row)
    expect(store.getSpend("agent-a")).toBe(0);
  });

  it("accumulate with negative delta throws", async () => {
    const store = await makeStore(join(tempDir, "delta-neg.db"));

    expect(() => store.accumulate("agent-a", -0.01)).toThrow();
  });
});
