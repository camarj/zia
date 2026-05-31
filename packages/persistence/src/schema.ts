/**
 * schema.ts — DDL constants and SCHEMA_VERSION (ADR-5, SPEC-DDL-1..5, ADR-D6).
 *
 * All DDL lives here so db.ts stays focused on lifecycle, and so schema
 * changes are easy to diff in git. No logic — constants only.
 *
 * SCHEMA_VERSION 2 (additive): adds messages table + messages_fts virtual
 * table + three sync triggers. No existing tables modified.
 *
 * SCHEMA_VERSION 3 (additive): adds memory_entries table + memory_entries_fts
 * virtual table + three sync triggers. No existing tables modified.
 *
 * SCHEMA_VERSION 4 (additive): adds idx_sessions_parent_session_id index on
 * sessions.parent_session_id — activates the lineage column for compaction
 * tracking (F-CORE-6, SPEC-LINEAGE-2). No existing tables or data modified.
 *
 * SCHEMA_VERSION 5 (additive): adds monthly_spend table + idx_monthly_spend_agent
 * index — stores per-agent monthly LLM cost for budget enforcement (F-CORE-8,
 * SPEC-SPEND-DDL-1). No existing tables or data modified.
 */

export const SCHEMA_VERSION = 5;

// ---------------------------------------------------------------------------
// SPEC-DDL-1 — _meta table
// Must be created BEFORE all other tables (schema version gate reads it).
// v2: seeds '2' on fresh open; upgrades v1 rows to '2' idempotently.
// v4: seeds '4' on fresh open; upgrades v1/v2/v3 rows to '4' idempotently.
// v5: seeds '5' on fresh open; upgrades v1/v2/v3/v4 rows to '5' idempotently.
// ---------------------------------------------------------------------------
export const DDL_META = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '5');
UPDATE _meta SET value='5' WHERE key='schema_version' AND CAST(value AS INTEGER) < 5;
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
`.trim();

// ---------------------------------------------------------------------------
// SPEC-F4-1 / ADR-D6 — messages table (v2 additive)
// ---------------------------------------------------------------------------
export const DDL_MESSAGES = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  session_key TEXT    NOT NULL,
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  tool_name   TEXT,
  timestamp   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_key
  ON messages (session_key);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp
  ON messages (timestamp);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-F4-1 / ADR-D6 — messages_fts virtual table (external-content, v2)
// FTS columns: content + role. tool_name/timestamp/session_key fetched via
// rowid join on the base table (mirrors audit_entries_fts pattern).
// ---------------------------------------------------------------------------
export const DDL_MESSAGES_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
USING fts5(
  content,
  role,
  content='messages',
  content_rowid='id'
);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-F4-1 / ADR-D6 — FTS5 sync triggers for messages_fts (v2)
// ---------------------------------------------------------------------------
export const DDL_MESSAGES_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS messages_fts_insert
AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, content, role)
  VALUES (new.id, new.content, new.role);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update
AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, role)
  VALUES ('delete', old.id, old.content, old.role);
  INSERT INTO messages_fts (rowid, content, role)
  VALUES (new.id, new.content, new.role);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete
AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, role)
  VALUES ('delete', old.id, old.content, old.role);
END;
`.trim();

// ---------------------------------------------------------------------------
// SPEC-SCHEMA-1 / ADR-M6 — memory_entries table (v3 additive)
// Stores per-entry rows for the SqliteFtsMemoryProvider.
// char_count is denormalized for O(1) cap enforcement without re-measuring.
// ---------------------------------------------------------------------------
export const DDL_MEMORY_ENTRIES = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  char_count INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at
  ON memory_entries (created_at);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-SCHEMA-2 — memory_entries_fts virtual table (external-content, v3)
// FTS column: body only. content_rowid='id' mirrors messages_fts pattern.
// ---------------------------------------------------------------------------
export const DDL_MEMORY_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts
USING fts5(
  body,
  content='memory_entries',
  content_rowid='id'
);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-SCHEMA-3 — FTS5 sync triggers for memory_entries_fts (v3)
// DELETE trigger is required: SqliteFtsMemoryProvider evicts rows via DELETE.
// Mirror the messages_fts trigger pattern exactly.
// ---------------------------------------------------------------------------
export const DDL_MEMORY_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS memory_entries_fts_insert
AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_entries_fts (rowid, body)
  VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_fts_update
AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_entries_fts (memory_entries_fts, rowid, body)
  VALUES ('delete', old.id, old.body);
  INSERT INTO memory_entries_fts (rowid, body)
  VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_fts_delete
AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_entries_fts (memory_entries_fts, rowid, body)
  VALUES ('delete', old.id, old.body);
END;
`.trim();

// ---------------------------------------------------------------------------
// SPEC-LINEAGE-2 — sessions lineage index (v4 additive)
// Enables efficient ancestry lookups on the parent_session_id FK.
// The column already existed in v3; this index activates it for query use.
// CREATE INDEX IF NOT EXISTS — safe to run on both fresh v4 DBs and v3→v4
// migrations without any ALTER TABLE.
// ---------------------------------------------------------------------------
export const DDL_SESSIONS_LINEAGE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id
  ON sessions (parent_session_id);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-SPEND-DDL-1 — monthly_spend table (v5 additive)
// Stores per-agent monthly LLM cost accumulation for budget enforcement
// (F-CORE-8). PRIMARY KEY (agent_id, year_month) enforces one row per
// agent per calendar month. year_month is always UTC 'YYYY-MM'.
// cost_usd uses REAL — sufficient for cent-level precision.
// CREATE TABLE IF NOT EXISTS — safe to run on both fresh v5 DBs and v4→v5
// migrations without dropping any existing data.
// ---------------------------------------------------------------------------
export const DDL_MONTHLY_SPEND = `
CREATE TABLE IF NOT EXISTS monthly_spend (
  agent_id   TEXT NOT NULL,
  year_month TEXT NOT NULL,
  cost_usd   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, year_month)
);
`.trim();

// ---------------------------------------------------------------------------
// SPEC-SPEND-DDL-1 — monthly_spend agent index (v5 additive)
// Enables efficient per-agent spend lookups without scanning the full table.
// CREATE INDEX IF NOT EXISTS — idempotent.
// ---------------------------------------------------------------------------
export const DDL_MONTHLY_SPEND_INDEX = `
CREATE INDEX IF NOT EXISTS idx_monthly_spend_agent
  ON monthly_spend (agent_id);
`.trim();
