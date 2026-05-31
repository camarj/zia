/**
 * schema-v4.test.ts — Schema migration v3→v4 (SPEC-LINEAGE-1, SPEC-LINEAGE-2, SPEC-LINEAGE-3)
 *
 * Covers:
 *   SPEC-LINEAGE-1  parent_session_id column exists and is queryable in v4 DB
 *   SPEC-LINEAGE-2  idx_sessions_parent_session_id index exists in v4 DB
 *   SPEC-LINEAGE-3  openDatabase on a v3 DB silently migrates to v4 — meta bumped,
 *                   index created, all existing rows intact
 *   SPEC-V4-CONST   SCHEMA_VERSION === 4 and DDL_SESSIONS_LINEAGE_INDEX is exported
 *
 * TDD: these tests MUST fail before schema.ts / db.ts changes are applied.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-schema-v4-"));
}

/**
 * Seed a v3-equivalent SQLite DB:
 * - _meta schema_version='3'
 * - sessions table (with parent_session_id column — it already existed in v3)
 * - One session row so we can confirm data survives migration
 */
function seedV3Db(dbPath: string): void {
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode=WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '3');

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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key
      ON sessions (session_key);

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

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      session_key TEXT    NOT NULL,
      role        TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      tool_name   TEXT,
      timestamp   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      date       TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      char_count INTEGER NOT NULL,
      created_at TEXT    NOT NULL
    );
  `);

  // Seed data rows to verify survival after migration
  db.prepare(`
    INSERT INTO sessions
      (id, session_key, source_platform, model_config, started_at)
    VALUES
      ('sess-v3-001', 'tui:dm:root', 'tui', '{}', '2026-01-01T00:00:00Z')
  `).run();

  db.prepare(`
    INSERT INTO audit_entries
      (timestamp, tool_call_id, tool_name, risk_level, decision, approver, input, output, error)
    VALUES
      ('2026-01-01T00:00:00Z', 'tc-v3', 'read_file', 'trivial', 'auto', NULL, '{}', NULL, NULL)
  `).run();

  db.close();
}

// ---------------------------------------------------------------------------

describe("SCHEMA_VERSION constant (SPEC-V4-CONST)", () => {
  it("SCHEMA_VERSION === 4", async () => {
    const { SCHEMA_VERSION } = await import("../src/schema.ts");
    expect(SCHEMA_VERSION).toBe(4);
  });

  it("DDL_SESSIONS_LINEAGE_INDEX is exported from schema.ts", async () => {
    const schema = await import("../src/schema.ts");
    expect(typeof (schema as Record<string, unknown>)["DDL_SESSIONS_LINEAGE_INDEX"]).toBe("string");
  });

  it("DDL_SESSIONS_LINEAGE_INDEX is exported from the package barrel", async () => {
    const barrel = await import("../src/index.ts");
    expect(typeof (barrel as Record<string, unknown>)["DDL_SESSIONS_LINEAGE_INDEX"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------

describe("v4 fresh open (SPEC-LINEAGE-1, SPEC-LINEAGE-2)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("records schema_version='4' on a fresh database open (SPEC-V4-CONST)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh-v4.db"));

    const row = db
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("4");
    db.close();
  });

  it("parent_session_id column is queryable on fresh v4 DB (SPEC-LINEAGE-1)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "lineage1.db"));

    // Insert a root session and verify the column round-trips
    db.prepare(`
      INSERT INTO sessions
        (id, session_key, source_platform, model_config, started_at, parent_session_id)
      VALUES
        ('root-1', 'tui:dm:root', 'tui', '{}', '2026-01-01T00:00:00Z', NULL)
    `).run();

    const row = db
      .prepare("SELECT parent_session_id FROM sessions WHERE id = 'root-1'")
      .get() as { parent_session_id: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.parent_session_id).toBeNull();
    db.close();
  });

  it("idx_sessions_parent_session_id index exists on fresh v4 DB (SPEC-LINEAGE-2)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "lineage2.db"));

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_parent_session_id'",
      )
      .get() as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe("idx_sessions_parent_session_id");
    db.close();
  });
});

// ---------------------------------------------------------------------------

describe("v3→v4 migration (SPEC-LINEAGE-3)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("opens a v3 DB without error", async () => {
    const dbPath = join(tempDir, "v3.db");
    seedV3Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    expect(() => openDatabase(dbPath)).not.toThrow();
    openDatabase(dbPath).close();
  });

  it("bumps schema_version to '4' after v3→v4 migration", async () => {
    const dbPath = join(tempDir, "v3-meta.db");
    seedV3Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const row = db
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;

    expect(row!.value).toBe("4");
    db.close();
  });

  it("creates idx_sessions_parent_session_id after v3→v4 migration", async () => {
    const dbPath = join(tempDir, "v3-index.db");
    seedV3Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_parent_session_id'",
      )
      .get() as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe("idx_sessions_parent_session_id");
    db.close();
  });

  it("preserves existing sessions rows after v3→v4 migration", async () => {
    const dbPath = join(tempDir, "v3-rows.db");
    seedV3Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const session = db
      .prepare("SELECT id FROM sessions WHERE id = 'sess-v3-001'")
      .get() as { id: string } | undefined;

    expect(session?.id).toBe("sess-v3-001");
    db.close();
  });

  it("preserves existing audit_entries rows after v3→v4 migration", async () => {
    const dbPath = join(tempDir, "v3-audit.db");
    seedV3Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const entry = db
      .prepare("SELECT tool_call_id FROM audit_entries WHERE tool_call_id='tc-v3'")
      .get() as { tool_call_id: string } | undefined;

    expect(entry?.tool_call_id).toBe("tc-v3");
    db.close();
  });
});
