/**
 * migration.test.ts — Schema v1→v2 migration tests (A.3, SPEC-F4-1, SPEC-F4-2).
 *
 * (a) Fresh open → schema_version='2', messages + messages_fts exist.
 * (b) Hand-seeded v1 DB (only audit tables) → open succeeds → schema_version='2'
 *     → messages + messages_fts created → pre-existing audit rows intact.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-migration-"));
}

// Minimal v1 schema — what existed before SCHEMA_VERSION=2.
// Includes _meta with version='1', sessions, audit_entries, audit_entries_fts,
// and the three audit FTS triggers. No messages tables.
function seedV1Db(dbPath: string): void {
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode=WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT NOT NULL PRIMARY KEY,
      session_key       TEXT NOT NULL UNIQUE,
      source_platform   TEXT NOT NULL,
      model_config      TEXT NOT NULL,
      pi_session_path   TEXT,
      started_at        TEXT NOT NULL,
      ended_at          TEXT,
      end_reason        TEXT,
      parent_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_entries (
      id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      timestamp    TEXT    NOT NULL,
      tool_call_id TEXT    NOT NULL,
      tool_name    TEXT    NOT NULL,
      risk_level   TEXT    NOT NULL,
      decision     TEXT    NOT NULL,
      approver     TEXT,
      input        TEXT    NOT NULL,
      output       TEXT,
      error        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_entries_timestamp ON audit_entries (timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_entries_tool_name ON audit_entries (tool_name);
    CREATE INDEX IF NOT EXISTS idx_audit_entries_tool_call_id ON audit_entries (tool_call_id);
    CREATE INDEX IF NOT EXISTS idx_audit_entries_decision ON audit_entries (decision);

    CREATE VIRTUAL TABLE IF NOT EXISTS audit_entries_fts
    USING fts5(
      tool_name,
      input,
      content='audit_entries',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS audit_entries_fts_insert
    AFTER INSERT ON audit_entries BEGIN
      INSERT INTO audit_entries_fts (rowid, tool_name, input)
      VALUES (new.id, new.tool_name, new.input);
    END;

    CREATE TRIGGER IF NOT EXISTS audit_entries_fts_update
    AFTER UPDATE ON audit_entries BEGIN
      INSERT INTO audit_entries_fts (audit_entries_fts, rowid, tool_name, input)
      VALUES ('delete', old.id, old.tool_name, old.input);
      INSERT INTO audit_entries_fts (rowid, tool_name, input)
      VALUES (new.id, new.tool_name, new.input);
    END;

    CREATE TRIGGER IF NOT EXISTS audit_entries_fts_delete
    AFTER DELETE ON audit_entries BEGIN
      INSERT INTO audit_entries_fts (audit_entries_fts, rowid, tool_name, input)
      VALUES ('delete', old.id, old.tool_name, old.input);
    END;
  `);

  // Seed a pre-existing audit entry to verify it survives the migration.
  db.prepare(`
    INSERT INTO audit_entries
      (timestamp, tool_call_id, tool_name, risk_level, decision, approver, input, output, error)
    VALUES
      ('2026-01-01T00:00:00Z', 'tc-pre-migration', 'read_file', 'trivial', 'auto', NULL, '{}', NULL, NULL)
  `).run();

  db.close();
}

// ---------------------------------------------------------------------------

describe("Schema migration — fresh open (SPEC-F4-1)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates schema_version='2' on a fresh database", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh.db"));

    const row = db
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.value).toBe("2");

    db.close();
  });

  it("creates messages table on a fresh database", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh2.db"));

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .get() as { name: string } | undefined;

    expect(tableRow).toBeDefined();
    expect(tableRow!.name).toBe("messages");

    db.close();
  });

  it("creates messages_fts virtual table on a fresh database", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh3.db"));

    const ftsRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
      .get() as { name: string } | undefined;

    expect(ftsRow).toBeDefined();
    expect(ftsRow!.name).toBe("messages_fts");

    db.close();
  });
});

// ---------------------------------------------------------------------------

describe("Schema migration — v1→v2 upgrade (SPEC-F4-1, SPEC-F4-2)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("opens a v1 DB without error and upgrades schema_version to '2'", async () => {
    const dbPath = join(tempDir, "v1.db");
    seedV1Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    // Should not throw
    const db = openDatabase(dbPath);

    const row = db
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;

    expect(row!.value).toBe("2");

    db.close();
  });

  it("creates messages and messages_fts tables on a migrated v1 DB", async () => {
    const dbPath = join(tempDir, "v1b.db");
    seedV1Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const messagesRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .get() as { name: string } | undefined;
    const ftsRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
      .get() as { name: string } | undefined;

    expect(messagesRow?.name).toBe("messages");
    expect(ftsRow?.name).toBe("messages_fts");

    db.close();
  });

  it("preserves pre-existing audit_entries rows after migration (SPEC-F4-2)", async () => {
    const dbPath = join(tempDir, "v1c.db");
    seedV1Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM audit_entries").get() as {
        cnt: number;
      }
    ).cnt;

    expect(count).toBe(1);

    const row = db
      .prepare("SELECT tool_call_id FROM audit_entries WHERE tool_call_id='tc-pre-migration'")
      .get() as { tool_call_id: string } | undefined;

    expect(row?.tool_call_id).toBe("tc-pre-migration");

    db.close();
  });
});
