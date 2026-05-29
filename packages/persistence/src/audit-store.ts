/**
 * audit-store.ts — SqliteAuditLog implements SearchableAuditLog (ADR-2, ADR-4).
 *
 * Design decisions:
 *  - SearchableAuditLog extends AuditLog (ISP: base stays minimal, search lives here).
 *  - AuditEntry / AuditLog imported from @zia/callbacks — NOT re-declared (O4).
 *  - record() wraps write in BEGIN IMMEDIATE via db.transaction({immediate:true}) (SPEC-R3).
 *  - record() wraps the transaction in retryWithJitter for SQLITE_BUSY resilience (SPEC-R4).
 *  - record() increments the shared write counter for WAL checkpoint cadence (SPEC-R5).
 *  - record() NEVER throws to caller — catches all errors, writes to stderr (SPEC-R10, AQ-10).
 *  - FTS5 is maintained exclusively via triggers — record() does NOT insert into
 *    audit_entries_fts (SPEC-R7).
 *  - search() sanitizes tokens by wrapping each in double-quotes before MATCH (SPEC-R8).
 *  - search() deserializes input/output JSON columns back to Record objects (SPEC-R9).
 *  - Default search limit: 50 results.
 */

import type { AuditEntry, AuditLog } from "@zia/callbacks";
import type { Database } from "./sqlite-shim.ts";
import { incrementWriteCounter } from "./db.ts";
import { retryWithJitter } from "./retry.ts";

// ---------------------------------------------------------------------------
// SearchableAuditLog interface (O2 resolved — declared in persistence, not callbacks)
// ---------------------------------------------------------------------------

/**
 * Extends the minimal AuditLog interface with FTS5-backed full-text search.
 * Declared here so @zia/callbacks stays SDK-free and unaware of SQLite.
 * The gateway/control-panel consumes this wider type; the gate/queue only
 * ever sees the narrow AuditLog.
 */
export interface SearchableAuditLog extends AuditLog {
  /**
   * Full-text search over audit entries using FTS5 MATCH.
   * Query tokens are sanitized (double-quoted) before being passed to MATCH
   * so FTS5 operators (AND, OR, NOT, NEAR, *) cannot be injected.
   *
   * @param query  User-supplied search string; tokens split on whitespace.
   * @param limit  Maximum results to return. Defaults to 50.
   * @returns      Deserialized AuditEntry array, most-recent first.
   */
  search(query: string, limit?: number): AuditEntry[];
}

// ---------------------------------------------------------------------------
// Row shape returned by SQLite for audit_entries
// ---------------------------------------------------------------------------

interface AuditRow {
  id: number;
  timestamp: string;
  tool_call_id: string;
  tool_name: string;
  risk_level: string;
  decision: string;
  approver: string | null;
  input: string;
  output: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// FTS5 query sanitization (SPEC-R8)
// ---------------------------------------------------------------------------

/**
 * Wrap each whitespace-delimited token in double-quotes so FTS5 boolean
 * operators (AND, OR, NOT, NEAR, *, :) are treated as literal terms.
 *
 * Internal double-quotes inside a token are escaped by doubling them.
 *
 * Example:
 *   "send_email AND NOT query_linear" → '"send_email" "AND" "NOT" "query_linear"'
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Row → AuditEntry deserialization (SPEC-R9)
// ---------------------------------------------------------------------------

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    timestamp: row.timestamp,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    // riskLevel is stored as the string literal ("trivial" | "medio" | "alto")
    riskLevel: row.risk_level as AuditEntry["riskLevel"],
    decision: row.decision as AuditEntry["decision"],
    approver: row.approver,
    input: JSON.parse(row.input) as Record<string, unknown>,
    output: row.output !== null
      ? (JSON.parse(row.output) as Record<string, unknown>)
      : null,
    error: row.error,
  };
}

// ---------------------------------------------------------------------------
// SqliteAuditLog
// ---------------------------------------------------------------------------

export class SqliteAuditLog implements SearchableAuditLog {
  private readonly insertStmt: ReturnType<Database["prepare"]>;
  private readonly searchStmt: (sanitized: string, limit: number) => AuditRow[];

  constructor(private readonly db: Database) {
    // Prepare the INSERT once — reused on every record() call.
    this.insertStmt = db.prepare(`
      INSERT INTO audit_entries
        (timestamp, tool_call_id, tool_name, risk_level, decision,
         approver, input, output, error)
      VALUES
        (@timestamp, @toolCallId, @toolName, @riskLevel, @decision,
         @approver, @input, @output, @error)
    `);

    // search() uses a closure to keep the FTS MATCH query parameterized.
    this.searchStmt = (sanitized: string, limit: number): AuditRow[] => {
      return db
        .prepare(
          `
          SELECT ae.*
          FROM audit_entries ae
          JOIN audit_entries_fts fts ON fts.rowid = ae.id
          WHERE audit_entries_fts MATCH ?
          ORDER BY ae.timestamp DESC
          LIMIT ?
          `,
        )
        .all(sanitized, limit) as AuditRow[];
    };
  }

  /**
   * Persist one audit entry to the database.
   *
   * - Wrapped in BEGIN IMMEDIATE transaction for write-lock safety (SPEC-R3).
   * - Retried on SQLITE_BUSY with jitter (SPEC-R4).
   * - Increments the shared write counter for checkpoint cadence (SPEC-R5).
   * - FTS5 kept in sync exclusively via INSERT trigger (SPEC-R7).
   * - NEVER rejects — swallows all errors to stderr (SPEC-R10, AQ-10).
   */
  record(entry: AuditEntry): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const writeTransaction = this.db.transaction(() => {
          this.insertStmt.run({
            timestamp: entry.timestamp,
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            riskLevel: entry.riskLevel,
            decision: entry.decision,
            approver: entry.approver ?? null,
            input: JSON.stringify(entry.input),
            output: entry.output !== null ? JSON.stringify(entry.output) : null,
            error: entry.error ?? null,
          });
        });

        // Run inside retryWithJitter so SQLITE_BUSY is absorbed (SPEC-R4).
        // db.transaction() uses BEGIN by default; to use BEGIN IMMEDIATE we
        // call the transaction as .exclusive() which maps to BEGIN EXCLUSIVE,
        // or we wrap in an explicit immediate transaction.
        // better-sqlite3 exposes .deferred(), .immediate(), .exclusive() on
        // the transaction function.
        retryWithJitter(() => (writeTransaction as unknown as {
          immediate: () => void;
        }).immediate());

        // Increment write counter AFTER successful write (SPEC-R5).
        incrementWriteCounter(this.db);
      } catch (err) {
        // Swallow — audit write failure must never crash the agent (SPEC-R10, AQ-10).
        process.stderr.write(
          `[zia/audit] SqliteAuditLog.record() failed: ${String(err)}\n`,
        );
      } finally {
        resolve();
      }
    });
  }

  /**
   * Full-text search over audit entries.
   *
   * Sanitizes the query (SPEC-R8), runs FTS5 MATCH, deserializes rows (SPEC-R9).
   *
   * @param query  Raw search string from caller.
   * @param limit  Max results. Defaults to 50.
   */
  search(query: string, limit = 50): AuditEntry[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.searchStmt(sanitized, limit);
    return rows.map(rowToEntry);
  }
}
