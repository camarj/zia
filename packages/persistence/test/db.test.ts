/**
 * db.test.ts — RED tests for openDatabase, schema, version gate.
 *
 * Covers:
 *   SC-01  WAL mode on file DB
 *   SC-02  All tables + triggers created on first open
 *   SC-03  schema_version = '1' recorded
 *   SC-04  version gate throws when schema_version > SCHEMA_VERSION
 *   SC-16  better-sqlite3 shim loads under ESM without errors
 *   SPEC-R1, R2, R6, R13
 *
 * Note: :memory: DBs cannot test WAL (WAL requires a real file).
 * All WAL-sensitive tests use a temp-dir file DB.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// --- SC-16 (task 1.4) — shim loads under ESM --------------------------------
describe("sqlite-shim ESM import (SC-16, SPEC-R13)", () => {
  it("constructs a Database on :memory: without ESM errors", async () => {
    const { default: Database } = await import("../src/sqlite-shim.ts");
    const db = new Database(":memory:");
    expect(db).toBeDefined();
    expect(typeof db.prepare).toBe("function");
    db.close();
  });
});

// --- DB file helpers ---------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zia-persistence-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function tempDbPath(): string {
  return join(tempDir, "test.db");
}

// --- SC-01 (task 1.1) — WAL mode --------------------------------------------
describe("openDatabase WAL (SC-01, SPEC-R1)", () => {
  it("opens a file DB in WAL mode", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(row.journal_mode).toBe("wal");
    db.close();
  });

  it("sets busy_timeout = 1000 ms (SPEC-R2)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());
    const row = db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(row.timeout).toBe(1000);
    db.close();
  });

  it("throws when opening :memory: (WAL requires a file, SC-01)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    expect(() => openDatabase(":memory:")).toThrow();
  });
});

// --- SC-02 + SC-03 (tasks 1.2) — Schema tables and version -----------------
describe("openDatabase schema (SC-02, SC-03, SPEC-R11)", () => {
  it("creates _meta, sessions, audit_entries tables", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain("_meta");
    expect(tables).toContain("sessions");
    expect(tables).toContain("audit_entries");
    // No messages table (SPEC-R11)
    expect(tables).not.toContain("messages");

    db.close();
  });

  it("creates the audit_entries_fts virtual table", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const vtables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(vtables).toContain("audit_entries_fts");
    db.close();
  });

  it("creates the three FTS sync triggers", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const triggers = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(triggers).toContain("audit_entries_fts_insert");
    expect(triggers).toContain("audit_entries_fts_update");
    expect(triggers).toContain("audit_entries_fts_delete");
    db.close();
  });

  it("records schema_version = '1' in _meta (SC-03)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const row = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("1");
    db.close();
  });
});

// --- SC-04 (task 1.3) — Schema version gate ---------------------------------
describe("openDatabase version gate (SC-04, SPEC-R6)", () => {
  it("throws when schema_version > SCHEMA_VERSION", async () => {
    const { default: Database } = await import("../src/sqlite-shim.ts");
    const path = tempDbPath();

    // Seed a DB with schema_version = '99' by hand (no openDatabase yet)
    const seedDb = new Database(path);
    seedDb.exec(`
      CREATE TABLE _meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '99');
    `);
    seedDb.close();

    // Now openDatabase should throw the version gate error
    const { openDatabase } = await import("../src/db.ts");
    expect(() => openDatabase(path)).toThrow(/schema version 99 > expected 1/);
  });
});
