/**
 * schema-v5.test.ts — Schema migration v4→v5 (SPEC-SPEND-DDL-1-A/B)
 *
 * Covers:
 *   SPEC-SPEND-DDL-1-A  Migration from v4: monthly_spend table + index created,
 *                        all prior tables and data intact, SCHEMA_VERSION bumped to 5
 *   SPEC-SPEND-DDL-1-B  Idempotent re-open at v5: no error, no duplicate table,
 *                        SCHEMA_VERSION still 5
 *   SPEC-V5-CONST       SCHEMA_VERSION === 5 and DDL_MONTHLY_SPEND is exported
 *
 * TDD: these tests MUST fail before schema.ts / db.ts changes are applied.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-schema-v5-"));
}

/**
 * Seed a v4-equivalent SQLite DB:
 * - _meta schema_version='4'
 * - sessions table (with parent_session_id column)
 * - audit_entries table
 * - messages table
 * - memory_entries table
 * - idx_sessions_parent_session_id index
 * - One row in sessions + one in audit_entries to verify data survival
 */
function seedV4Db(dbPath: string): void {
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode=WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '4');

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

    CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id
      ON sessions (parent_session_id);

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
      ('sess-v4-001', 'tui:dm:root-v4', 'tui', '{}', '2026-01-01T00:00:00Z')
  `).run();

  db.prepare(`
    INSERT INTO audit_entries
      (timestamp, tool_call_id, tool_name, risk_level, decision, approver, input, output, error)
    VALUES
      ('2026-01-01T00:00:00Z', 'tc-v4', 'read_file', 'trivial', 'auto', NULL, '{}', NULL, NULL)
  `).run();

  db.close();
}

// ---------------------------------------------------------------------------

describe("SCHEMA_VERSION constant (SPEC-V5-CONST)", () => {
  it("SCHEMA_VERSION === 5", async () => {
    const { SCHEMA_VERSION } = await import("../src/schema.ts");
    expect(SCHEMA_VERSION).toBe(5);
  });

  it("DDL_MONTHLY_SPEND is exported from schema.ts", async () => {
    const schema = await import("../src/schema.ts");
    expect(typeof (schema as Record<string, unknown>)["DDL_MONTHLY_SPEND"]).toBe("string");
  });

  it("DDL_MONTHLY_SPEND_INDEX is exported from schema.ts", async () => {
    const schema = await import("../src/schema.ts");
    expect(typeof (schema as Record<string, unknown>)["DDL_MONTHLY_SPEND_INDEX"]).toBe("string");
  });

  it("DDL_MONTHLY_SPEND is exported from the package barrel", async () => {
    const barrel = await import("../src/index.ts");
    expect(typeof (barrel as Record<string, unknown>)["DDL_MONTHLY_SPEND"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------

describe("v5 fresh open (SPEC-SPEND-DDL-1-B)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("records schema_version='5' on a fresh database open", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh-v5.db"));

    const row = db
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("5");
    db.close();
  });

  it("monthly_spend table exists on fresh v5 open", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh-v5-table.db"));

    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monthly_spend'")
      .get() as { name: string } | undefined;

    expect(row?.name).toBe("monthly_spend");
    db.close();
  });

  it("idx_monthly_spend_agent index exists on fresh v5 open", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh-v5-index.db"));

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_monthly_spend_agent'",
      )
      .get() as { name: string } | undefined;

    expect(row?.name).toBe("idx_monthly_spend_agent");
    db.close();
  });

  it("monthly_spend table has correct schema (agent_id, year_month, cost_usd)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh-v5-schema.db"));

    // Insert and retrieve to confirm column shapes
    db.prepare(`
      INSERT INTO monthly_spend (agent_id, year_month, cost_usd)
      VALUES ('agent-test', '2026-01', 3.14)
    `).run();

    const row = db
      .prepare("SELECT agent_id, year_month, cost_usd FROM monthly_spend WHERE agent_id='agent-test'")
      .get() as { agent_id: string; year_month: string; cost_usd: number } | undefined;

    expect(row?.agent_id).toBe("agent-test");
    expect(row?.year_month).toBe("2026-01");
    expect(row?.cost_usd).toBeCloseTo(3.14, 9);
    db.close();
  });

  it("monthly_spend PRIMARY KEY (agent_id, year_month) enforces uniqueness", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(join(tempDir, "fresh-v5-pk.db"));

    db.prepare(`
      INSERT INTO monthly_spend (agent_id, year_month, cost_usd) VALUES ('a1', '2026-01', 1.0)
    `).run();

    // Second insert with same PK should fail
    expect(() => {
      db.prepare(`
        INSERT INTO monthly_spend (agent_id, year_month, cost_usd) VALUES ('a1', '2026-01', 2.0)
      `).run();
    }).toThrow();

    db.close();
  });

  it("re-open at v5 is idempotent — no duplicate table (SPEC-SPEND-DDL-1-B)", async () => {
    const dbPath = join(tempDir, "idempotent-v5.db");
    const { openDatabase } = await import("../src/db.ts");

    // First open
    const db1 = openDatabase(dbPath);
    db1.close();

    // Second open — must not throw
    expect(() => {
      const db2 = openDatabase(dbPath);
      db2.close();
    }).not.toThrow();
  });

  it("re-open at v5 keeps schema_version='5' (SPEC-SPEND-DDL-1-B)", async () => {
    const dbPath = join(tempDir, "idempotent-v5-ver.db");
    const { openDatabase } = await import("../src/db.ts");

    const db1 = openDatabase(dbPath);
    db1.close();

    const db2 = openDatabase(dbPath);
    const row = db2
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe("5");
    db2.close();
  });
});

// ---------------------------------------------------------------------------

describe("v4→v5 migration (SPEC-SPEND-DDL-1-A)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("opens a v4 DB without error (SPEC-SPEND-DDL-1-A)", async () => {
    const dbPath = join(tempDir, "v4.db");
    seedV4Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    expect(() => openDatabase(dbPath)).not.toThrow();
    openDatabase(dbPath).close();
  });

  it("bumps schema_version to '5' after v4→v5 migration (SPEC-SPEND-DDL-1-A)", async () => {
    const dbPath = join(tempDir, "v4-meta.db");
    seedV4Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const row = db
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;

    expect(row?.value).toBe("5");
    db.close();
  });

  it("creates monthly_spend table after v4→v5 migration (SPEC-SPEND-DDL-1-A)", async () => {
    const dbPath = join(tempDir, "v4-table.db");
    seedV4Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monthly_spend'")
      .get() as { name: string } | undefined;

    expect(row?.name).toBe("monthly_spend");
    db.close();
  });

  it("creates idx_monthly_spend_agent after v4→v5 migration (SPEC-SPEND-DDL-1-A)", async () => {
    const dbPath = join(tempDir, "v4-index.db");
    seedV4Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_monthly_spend_agent'",
      )
      .get() as { name: string } | undefined;

    expect(row?.name).toBe("idx_monthly_spend_agent");
    db.close();
  });

  it("preserves existing sessions rows after v4→v5 migration (SPEC-SPEND-DDL-1-A)", async () => {
    const dbPath = join(tempDir, "v4-rows.db");
    seedV4Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const session = db
      .prepare("SELECT id FROM sessions WHERE id = 'sess-v4-001'")
      .get() as { id: string } | undefined;

    expect(session?.id).toBe("sess-v4-001");
    db.close();
  });

  it("preserves existing audit_entries rows after v4→v5 migration (SPEC-SPEND-DDL-1-A)", async () => {
    const dbPath = join(tempDir, "v4-audit.db");
    seedV4Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const entry = db
      .prepare("SELECT tool_call_id FROM audit_entries WHERE tool_call_id='tc-v4'")
      .get() as { tool_call_id: string } | undefined;

    expect(entry?.tool_call_id).toBe("tc-v4");
    db.close();
  });

  it("prior tables (sessions, audit_entries, messages, memory_entries) still exist after migration", async () => {
    const dbPath = join(tempDir, "v4-all-tables.db");
    seedV4Db(dbPath);

    const { openDatabase } = await import("../src/db.ts");
    const db = openDatabase(dbPath);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain("sessions");
    expect(tables).toContain("audit_entries");
    expect(tables).toContain("messages");
    expect(tables).toContain("memory_entries");
    expect(tables).toContain("monthly_spend");
    db.close();
  });
});
