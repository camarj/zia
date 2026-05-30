/**
 * message-store.ts — SqliteMessageStore (SPEC-F4-3, SPEC-F4-4, ADR-D6).
 *
 * Mirrors the audit-store.ts pattern:
 *  - record() wraps write in BEGIN IMMEDIATE via retryWithJitter (SPEC-R3/R4).
 *  - record() increments the shared write counter (SPEC-R5).
 *  - record() NEVER throws — swallows all errors to stderr (AQ-10 parity).
 *  - FTS5 is maintained exclusively via triggers — record() does NOT insert
 *    into messages_fts manually.
 *  - search() sanitizes tokens using the shared sanitizeFtsQuery from fts.ts.
 *  - Default search limit: 20 results.
 */

import type { Database } from "./sqlite-shim.ts";
import { incrementWriteCounter } from "./db.ts";
import { sanitizeFtsQuery } from "./fts.ts";
import { retryWithJitter } from "./retry.ts";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SessionMessageRecord {
  sessionKey: string;
  role: string;
  content: string;
  toolName: string | null;
  timestamp: string;
}

export interface MessageSearchHit {
  role: string;
  content: string;
  timestamp: string;
  toolName: string | null;
}

export interface MessageStore {
  record(m: SessionMessageRecord): void;
  search(query: string, limit?: number): MessageSearchHit[];
}

// ---------------------------------------------------------------------------
// Row shape returned by SQLite for messages
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number;
  session_key: string;
  role: string;
  content: string;
  tool_name: string | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Row → MessageSearchHit — snippet truncated to ≤200 chars (SPEC-F4-4)
// ---------------------------------------------------------------------------

function rowToHit(row: MessageRow): MessageSearchHit {
  return {
    role: row.role,
    content: row.content.length > 200 ? row.content.slice(0, 200) : row.content,
    timestamp: row.timestamp,
    toolName: row.tool_name,
  };
}

// ---------------------------------------------------------------------------
// SqliteMessageStore
// ---------------------------------------------------------------------------

export class SqliteMessageStore implements MessageStore {
  private readonly insertStmt: ReturnType<Database["prepare"]>;
  private readonly searchStmt: (sanitized: string, limit: number) => MessageRow[];

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO messages (session_key, role, content, tool_name, timestamp)
      VALUES (@sessionKey, @role, @content, @toolName, @timestamp)
    `);

    this.searchStmt = (sanitized: string, limit: number): MessageRow[] => {
      return db
        .prepare(
          `
          SELECT m.*
          FROM messages m
          JOIN messages_fts fts ON fts.rowid = m.id
          WHERE messages_fts MATCH ?
          ORDER BY m.timestamp DESC
          LIMIT ?
          `,
        )
        .all(sanitized, limit) as MessageRow[];
    };
  }

  /**
   * Persist one message record to the database.
   *
   * - Wrapped in BEGIN IMMEDIATE transaction (SPEC-R3).
   * - Retried on SQLITE_BUSY with jitter (SPEC-R4).
   * - Increments the shared write counter for checkpoint cadence (SPEC-R5).
   * - FTS5 kept in sync exclusively via INSERT trigger.
   * - NEVER throws to caller — swallows all errors to stderr (AQ-10 parity).
   */
  record(m: SessionMessageRecord): void {
    try {
      const writeTransaction = this.db.transaction(() => {
        this.insertStmt.run({
          sessionKey: m.sessionKey,
          role: m.role,
          content: m.content,
          toolName: m.toolName,
          timestamp: m.timestamp,
        });
      });

      retryWithJitter(() =>
        (writeTransaction as unknown as { immediate: () => void }).immediate(),
      );

      incrementWriteCounter(this.db);
    } catch (err) {
      process.stderr.write(
        `[zia/message-store] SqliteMessageStore.record() failed: ${String(err)}\n`,
      );
    }
  }

  /**
   * Full-text search over messages.
   *
   * Sanitizes the query (shared sanitizeFtsQuery), runs FTS5 MATCH,
   * maps rows to hits with content snippets ≤200 chars (SPEC-F4-4).
   *
   * @param query  Raw search string from caller.
   * @param limit  Max results. Defaults to 20.
   */
  search(query: string, limit = 20): MessageSearchHit[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.searchStmt(sanitized, limit);
    return rows.map(rowToHit);
  }
}
