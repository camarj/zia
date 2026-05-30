/**
 * sqlite-fts.ts — SqliteFtsMemoryProvider (SPEC-MEM-6, SPEC-MEM-7, SPEC-MEM-8).
 *
 * Persists memory entries in the `memory_entries` table (schema v3) with FTS5
 * search via `memory_entries_fts`. Mirrors SqliteMessageStore exactly:
 *  - BEGIN IMMEDIATE transaction via retryWithJitter (SPEC-R3/R4).
 *  - incrementWriteCounter after every commit (SPEC-R5, 50-write checkpoint).
 *  - FTS5 kept in sync exclusively via triggers — no manual FTS inserts.
 *  - sanitizeFtsQuery wraps tokens in quotes so FTS5 operators are literals.
 *  - Char-cap enforced per-write: SUM(char_count) > limit → DELETE oldest rows.
 *  - NEVER throws to caller — swallows errors to stderr (AQ-10 parity).
 *
 * The `db` handle is injected (schema v3 already applied by openDatabase).
 * This module imports `Database` type-only — no runtime better-sqlite3 dep.
 */

import type { Database } from "@zia/persistence";
import {
  incrementWriteCounter,
  retryWithJitter,
  sanitizeFtsQuery,
} from "@zia/persistence";
import { DEFAULT_MEMORY_CHAR_LIMIT } from "./char-limit.ts";
import { isoDate } from "./entry-format.ts";
import type { MemoryProvider, MemorySearchHit } from "./provider.ts";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: number;
  date: string;
  body: string;
  char_count: number;
  created_at: string;
}

interface SumRow {
  total: number;
}

interface CountRow {
  cnt: number;
}

interface OldestRow {
  id: number;
}

// ---------------------------------------------------------------------------
// SqliteFtsMemoryProvider
// ---------------------------------------------------------------------------

export class SqliteFtsMemoryProvider implements MemoryProvider {
  private readonly insertStmt: ReturnType<Database["prepare"]>;
  private readonly deleteStmt: ReturnType<Database["prepare"]>;
  private readonly getSum: () => SumRow;
  private readonly getCount: () => CountRow;
  private readonly getOldest: () => OldestRow | undefined;

  constructor(
    private readonly db: Database,
    private readonly charLimit: number = DEFAULT_MEMORY_CHAR_LIMIT,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO memory_entries (date, body, char_count, created_at)
      VALUES (@date, @body, @charCount, @createdAt)
    `);

    this.deleteStmt = db.prepare(`
      DELETE FROM memory_entries WHERE id = ?
    `);

    // Store no-param queries as closures to avoid the better-sqlite3 Statement
    // type requiring at least one binding argument on .get() / .run().
    const sumStmt = db.prepare(
      `SELECT COALESCE(SUM(char_count), 0) AS total FROM memory_entries`,
    );
    const countStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM memory_entries`,
    );
    const oldestStmt = db.prepare(
      `SELECT id FROM memory_entries ORDER BY created_at ASC LIMIT 1`,
    );

    this.getSum = () => sumStmt.get({}) as SumRow;
    this.getCount = () => countStmt.get({}) as CountRow;
    this.getOldest = () => oldestStmt.get({}) as OldestRow | undefined;
  }

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  /**
   * Insert one entry, then evict oldest rows until SUM(char_count) <= charLimit.
   *
   * Uses BEGIN IMMEDIATE + retryWithJitter (mirrors SqliteMessageStore.record).
   * FTS5 is maintained by triggers — no manual fts insert needed.
   * NEVER throws to caller.
   */
  async write(body: string, now: Date = new Date()): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) return;

    const date = isoDate(now);
    const createdAt = now.toISOString();
    const charCount = trimmed.length;

    try {
      const writeTransaction = this.db.transaction(() => {
        // Insert the new entry.
        this.insertStmt.run({
          date,
          body: trimmed,
          charCount,
          createdAt,
        });

        // Enforce char cap: delete oldest rows until sum fits.
        // Must keep at least 1 row (the just-inserted one — newest-write-wins).
        let sum = this.getSum().total;
        while (sum > this.charLimit) {
          const count = this.getCount().cnt;
          if (count <= 1) break; // never evict the only (newest) row
          const oldest = this.getOldest();
          if (!oldest) break;
          this.deleteStmt.run(oldest.id);
          sum = this.getSum().total;
        }
      });

      retryWithJitter(() =>
        (writeTransaction as unknown as { immediate: () => void }).immediate(),
      );

      incrementWriteCounter(this.db);
    } catch (err) {
      process.stderr.write(
        `[zia/memory] SqliteFtsMemoryProvider.write() failed: ${String(err)}\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  /**
   * FTS5 search over memory_entries_fts.
   *
   * Sanitizes the query (wrapped tokens) so FTS5 operators are treated as
   * literals. Returns newest-first up to `limit` (default 20).
   * Returns [] when query is empty or sanitization produces nothing.
   */
  async search(query: string, limit = 20): Promise<MemorySearchHit[]> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      const rows = this.db
        .prepare(
          `
          SELECT m.date, m.body
          FROM memory_entries m
          JOIN memory_entries_fts fts ON fts.rowid = m.id
          WHERE memory_entries_fts MATCH ?
          ORDER BY m.created_at DESC
          LIMIT ?
          `,
        )
        .all(sanitized, limit) as Array<{ date: string; body: string }>;

      return rows.map((r) => ({
        date: r.date,
        snippet: r.body.length > 200 ? r.body.slice(0, 200) : r.body,
      }));
    } catch {
      return [];
    }
  }
}
