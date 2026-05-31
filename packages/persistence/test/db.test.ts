/**
 * db.test.ts — RED tests for openDatabase, schema, version gate.
 *
 * Covers:
 *   SC-01  WAL mode on file DB
 *   SC-02  All tables + triggers created on first open
 *   SC-03  schema_version = '3' recorded
 *   SC-04  version gate throws when schema_version > SCHEMA_VERSION
 *   SC-16  better-sqlite3 shim loads under ESM without errors
 *   SPEC-R1, R2, R6, R13
 *   SPEC-SCHEMA-1..5  Schema v3: memory_entries + FTS + triggers + migration
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
    // v2: messages table is now created on open (ADR-D6 additive migration)
    expect(tables).toContain("messages");

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

  it("records schema_version = '4' in _meta (SC-03, updated for v4)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const row = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("4");
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
    expect(() => openDatabase(path)).toThrow(/schema version 99 > expected 4/);
  });
});

// --- SPEC-SCHEMA-1 — SCHEMA_VERSION constant is 4 ---------------------------
describe("SCHEMA_VERSION constant (SPEC-SCHEMA-1)", () => {
  it("SCHEMA_VERSION === 4", async () => {
    const { SCHEMA_VERSION } = await import("../src/schema.ts");
    expect(SCHEMA_VERSION).toBe(4);
  });
});

// --- SPEC-SCHEMA-2 — memory_entries + FTS table created by openDatabase ------
describe("memory_entries tables (SPEC-SCHEMA-2)", () => {
  it("creates memory_entries table", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'",
      )
      .get() as { name: string } | undefined;

    expect(row?.name).toBe("memory_entries");
    db.close();
  });

  it("creates memory_entries_fts virtual table", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries_fts'",
      )
      .get() as { name: string } | undefined;

    expect(row?.name).toBe("memory_entries_fts");
    db.close();
  });

  it("records _meta.schema_version = '4' on fresh open", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const row = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("4");
    db.close();
  });
});

// --- SPEC-SCHEMA-3 — FTS triggers fire on INSERT and DELETE ------------------
describe("memory_entries FTS triggers (SPEC-SCHEMA-3)", () => {
  it("creates three FTS sync triggers for memory_entries", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const triggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_entries_fts%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(triggers).toContain("memory_entries_fts_insert");
    expect(triggers).toContain("memory_entries_fts_update");
    expect(triggers).toContain("memory_entries_fts_delete");
    db.close();
  });

  it("INSERT trigger: inserted row is searchable via FTS MATCH", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    db.prepare(
      "INSERT INTO memory_entries (date, body, char_count, created_at) VALUES (?, ?, ?, ?)",
    ).run("2026-05-30", "customer Acme pays net30 invoices", 37, "2026-05-30T10:00:00Z");

    const hit = db
      .prepare(
        "SELECT rowid FROM memory_entries_fts WHERE memory_entries_fts MATCH '\"Acme\"'",
      )
      .get() as { rowid: number } | undefined;

    expect(hit).toBeDefined();
    db.close();
  });

  it("DELETE trigger: deleted row is no longer found via FTS MATCH", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    db.prepare(
      "INSERT INTO memory_entries (date, body, char_count, created_at) VALUES (?, ?, ?, ?)",
    ).run("2026-05-30", "deletable entry content", 23, "2026-05-30T10:00:00Z");

    const rowId = (
      db
        .prepare("SELECT id FROM memory_entries WHERE body = 'deletable entry content'")
        .get() as { id: number }
    ).id;

    db.prepare("DELETE FROM memory_entries WHERE id = ?").run(rowId);

    const hit = db
      .prepare(
        "SELECT rowid FROM memory_entries_fts WHERE memory_entries_fts MATCH '\"deletable\"'",
      )
      .get() as { rowid: number } | undefined;

    expect(hit).toBeUndefined();
    db.close();
  });
});

// --- SPEC-SCHEMA-4 — v2→v3 additive migration --------------------------------
describe("v2→v3 migration (SPEC-SCHEMA-4)", () => {
  it("migrates a v2 DB to current schema transparently: meta bumped + memory_entries added", async () => {
    const { default: Database } = await import("../src/sqlite-shim.ts");
    const path = tempDbPath();

    // Seed a v2-equivalent DB by hand (with v2 tables but schema_version='2')
    const seedDb = new Database(path);
    seedDb.pragma("journal_mode=WAL");
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '2');

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL UNIQUE,
        source_platform TEXT NOT NULL,
        model_config TEXT NOT NULL,
        pi_session_path TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        parent_session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        timestamp TEXT NOT NULL
      );
    `);
    seedDb.close();

    // Open with current code — should migrate silently to the latest version
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(path);

    const metaRow = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(metaRow?.value).toBe("4");

    const memTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'",
      )
      .get() as { name: string } | undefined;
    expect(memTable?.name).toBe("memory_entries");

    db.close();
  });
});

// --- SPEC-LINEAGE-1 — parent_session_id column is queryable --------------------
describe("Schema v4 — parent_session_id column (SPEC-LINEAGE-1)", () => {
  it("parent_session_id column exists and is queryable on a fresh v4 DB", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    // Should not throw — column exists
    expect(() => {
      db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get("nonexistent");
    }).not.toThrow();

    db.close();
  });
});

// --- SPEC-LINEAGE-2 — idx_sessions_parent_session_id index exists in v4 ------
describe("Schema v4 — lineage index (SPEC-LINEAGE-2)", () => {
  it("creates idx_sessions_parent_session_id index on fresh open", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_parent_session_id'",
      )
      .get() as { name: string } | undefined;

    expect(row?.name).toBe("idx_sessions_parent_session_id");
    db.close();
  });

  it("records schema_version = '4' on a fresh v4 open", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(tempDbPath());

    const row = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("4");
    db.close();
  });
});

// --- SPEC-LINEAGE-3 — v3→v4 silent migration ---------------------------------
describe("v3→v4 migration (SPEC-LINEAGE-3)", () => {
  it("opens a v3 DB, bumps schema_version to '4', and adds lineage index", async () => {
    const { default: Database } = await import("../src/sqlite-shim.ts");
    const path = tempDbPath();

    // Seed a v3-equivalent DB by hand (no idx_sessions_parent_session_id)
    const seedDb = new Database(path);
    seedDb.pragma("journal_mode=WAL");
    seedDb.exec(`
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
    `);

    // Seed a session row to verify data survival
    seedDb.prepare(`
      INSERT INTO sessions (id, session_key, source_platform, model_config, started_at)
      VALUES ('v3-sess-1', 'agent:main:tui:dm:v3test', 'tui', '{}', '2026-01-01T00:00:00Z')
    `).run();
    seedDb.close();

    // Open with v4 code — should migrate silently
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(path);

    // schema_version must be '4'
    const metaRow = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(metaRow?.value).toBe("4");

    // idx_sessions_parent_session_id must exist
    const indexRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_parent_session_id'",
      )
      .get() as { name: string } | undefined;
    expect(indexRow?.name).toBe("idx_sessions_parent_session_id");

    // Pre-existing session row must survive
    const sessionRow = db
      .prepare("SELECT id FROM sessions WHERE id = 'v3-sess-1'")
      .get() as { id: string } | undefined;
    expect(sessionRow?.id).toBe("v3-sess-1");

    db.close();
  });
});

// --- SPEC-SCHEMA-5 — existing v2 rows survive migration ----------------------
describe("v2 data survival (SPEC-SCHEMA-5)", () => {
  it("existing sessions and messages rows survive v2→v3 migration", async () => {
    const { default: Database } = await import("../src/sqlite-shim.ts");
    const path = tempDbPath();

    // Seed a v2-equivalent DB with some rows
    const seedDb = new Database(path);
    seedDb.pragma("journal_mode=WAL");
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '2');

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL UNIQUE,
        source_platform TEXT NOT NULL,
        model_config TEXT NOT NULL,
        pi_session_path TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        parent_session_id TEXT
      );
      INSERT INTO sessions (id, session_key, source_platform, model_config, started_at)
        VALUES ('sess-1', 'key-1', 'test', '{}', '2026-05-30T00:00:00Z');

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        timestamp TEXT NOT NULL
      );
      INSERT INTO messages (session_key, role, content, timestamp)
        VALUES ('key-1', 'user', 'hello from v2', '2026-05-30T00:01:00Z');

      CREATE TABLE IF NOT EXISTS audit_entries (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        decision TEXT NOT NULL,
        approver TEXT,
        input TEXT NOT NULL,
        output TEXT,
        error TEXT
      );
      INSERT INTO audit_entries (timestamp, tool_call_id, tool_name, risk_level, decision, input)
        VALUES ('2026-05-30T00:02:00Z', 'tc-1', 'read_file', 'trivial', 'approved', '{}');
    `);
    seedDb.close();

    // Open with v3 code — existing rows must survive
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(path);

    const session = db
      .prepare("SELECT id FROM sessions WHERE id = 'sess-1'")
      .get() as { id: string } | undefined;
    expect(session?.id).toBe("sess-1");

    const msg = db
      .prepare("SELECT content FROM messages WHERE session_key = 'key-1'")
      .get() as { content: string } | undefined;
    expect(msg?.content).toBe("hello from v2");

    const audit = db
      .prepare("SELECT tool_call_id FROM audit_entries WHERE tool_call_id = 'tc-1'")
      .get() as { tool_call_id: string } | undefined;
    expect(audit?.tool_call_id).toBe("tc-1");

    db.close();
  });
});
