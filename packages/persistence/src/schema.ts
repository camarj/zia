/**
 * schema.ts — DDL constants and SCHEMA_VERSION (ADR-5, SPEC-DDL-1..5).
 *
 * All DDL lives here so db.ts stays focused on lifecycle, and so schema
 * changes are easy to diff in git. No logic — constants only.
 */

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// SPEC-DDL-1 — _meta table
// Must be created BEFORE all other tables (schema version gate reads it).
// ---------------------------------------------------------------------------
export const DDL_META = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');
`.trim();

// ---------------------------------------------------------------------------
// SPEC-DDL-2 — sessions table
// ---------------------------------------------------------------------------
export const DDL_SESSIONS = `
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

CREATE INDEX IF NOT EXISTS idx_sessions_source_platform
  ON sessions (source_platform);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at
  ON sessions (started_at);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-DDL-3 — audit_entries table
// ---------------------------------------------------------------------------
export const DDL_AUDIT_ENTRIES = `
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

CREATE INDEX IF NOT EXISTS idx_audit_entries_timestamp
  ON audit_entries (timestamp);

CREATE INDEX IF NOT EXISTS idx_audit_entries_tool_name
  ON audit_entries (tool_name);

CREATE INDEX IF NOT EXISTS idx_audit_entries_tool_call_id
  ON audit_entries (tool_call_id);

CREATE INDEX IF NOT EXISTS idx_audit_entries_decision
  ON audit_entries (decision);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-DDL-4 — FTS5 virtual table (external content, linked to audit_entries)
// ---------------------------------------------------------------------------
export const DDL_AUDIT_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS audit_entries_fts
USING fts5(
  tool_name,
  input,
  content='audit_entries',
  content_rowid='id'
);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-DDL-5 — FTS5 sync triggers
// Maintain audit_entries_fts in lockstep with the base table.
// SqliteAuditLog.record() MUST NOT manually insert into audit_entries_fts.
// ---------------------------------------------------------------------------
export const DDL_AUDIT_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS audit_entries_fts_insert
AFTER INSERT ON audit_entries BEGIN
  INSERT INTO audit_entries_fts (rowid, tool_name, input)
  VALUES (new.id, new.tool_name, new.input);
END;

CREATE TRIGGER IF NOT EXISTS audit_entries_fts_update
AFTER UPDATE ON audit_entries BEGIN
  UPDATE audit_entries_fts
    SET tool_name = new.tool_name, input = new.input
  WHERE rowid = new.id;
END;

CREATE TRIGGER IF NOT EXISTS audit_entries_fts_delete
AFTER DELETE ON audit_entries BEGIN
  DELETE FROM audit_entries_fts WHERE rowid = old.id;
END;
`.trim();
