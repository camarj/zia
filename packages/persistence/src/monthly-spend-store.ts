/**
 * monthly-spend-store.ts — MonthlySpendStore: per-agent monthly LLM cost
 * accumulation for budget enforcement (F-CORE-8, SPEC-SPEND-STORE-1).
 *
 * Design decisions:
 *  - Uses upsert-add: reads existing cost_usd then writes back existing + delta.
 *    INSERT OR REPLACE is NOT used because it would reset cost_usd on conflict
 *    rather than adding. Pattern: SELECT then INSERT OR REPLACE with summed value.
 *  - year_month defaults to `new Date().toISOString().slice(0, 7)` — always UTC.
 *  - accumulate() throws on write errors (write failures are surfaced; the
 *    budget extension's fail-open policy applies to READ errors only per spec).
 *  - getSpend() is fail-open: returns 0 and logs a warning on any DB error.
 *    This prevents a broken DB from bricking the agent.
 *  - getSpendOrThrow() exposes the underlying error — for tests that need to
 *    detect DB failures explicitly.
 *  - delta must be >= 0. Negative deltas throw immediately (spec: delta >= 0).
 *  - delta = 0 is a no-op guard (free/local models, SPEC-BUDGET-1-C).
 */

import type { Database } from "./sqlite-shim.ts";

// ---------------------------------------------------------------------------
// MonthlySpendStore interface (also re-exported from index.ts)
// ---------------------------------------------------------------------------

/**
 * Stores and retrieves per-agent monthly LLM spend for budget enforcement.
 *
 * year_month format: 'YYYY-MM' (UTC). When omitted, defaults to the current
 * UTC calendar month: `new Date().toISOString().slice(0, 7)`.
 */
export interface MonthlySpendStore {
  /**
   * Add `delta` to the accumulated spend for (agentId, yearMonth).
   * Uses a read-then-upsert pattern: reads existing cost, writes back
   * existing + delta atomically.
   *
   * yearMonth defaults to the current UTC 'YYYY-MM' if omitted.
   * delta MUST be >= 0. Negative deltas throw immediately.
   * delta = 0 is a no-op (does not write to the DB).
   *
   * May throw on DB write error (write failures are surfaced to caller).
   */
  accumulate(agentId: string, delta: number, yearMonth?: string): void;

  /**
   * Return the total accumulated spend for (agentId, yearMonth).
   * yearMonth defaults to the current UTC 'YYYY-MM' if omitted.
   * Returns 0 if no row exists.
   *
   * NEVER throws on DB error. On error: logs a warning to stderr, returns 0.
   */
  getSpend(agentId: string, yearMonth?: string): number;

  /**
   * Return the total accumulated spend for (agentId, yearMonth).
   * Same as getSpend but throws on DB error instead of fail-open.
   * Intended for tests that need to detect DB failures explicitly.
   */
  getSpendOrThrow(agentId: string, yearMonth?: string): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Create a MonthlySpendStore backed by the given SQLite database.
 * The database MUST have been opened via `openDatabase` (schema v5+).
 */
export function createMonthlySpendStore(db: Database): MonthlySpendStore {
  // Prepared statements — created once, reused across calls (better-sqlite3
  // stmt objects are safe to cache and re-run on the same db connection).
  const selectStmt = db.prepare<[string, string], { cost_usd: number }>(
    "SELECT cost_usd FROM monthly_spend WHERE agent_id = ? AND year_month = ?",
  );

  const upsertStmt = db.prepare<[string, string, number], void>(
    `INSERT INTO monthly_spend (agent_id, year_month, cost_usd)
     VALUES (?, ?, ?)
     ON CONFLICT (agent_id, year_month)
     DO UPDATE SET cost_usd = monthly_spend.cost_usd + excluded.cost_usd`,
  );

  function readSpend(agentId: string, yearMonth: string): number {
    const row = selectStmt.get(agentId, yearMonth);
    return row?.cost_usd ?? 0;
  }

  return {
    accumulate(agentId: string, delta: number, yearMonth?: string): void {
      if (delta < 0) {
        throw new RangeError(
          `MonthlySpendStore.accumulate: delta must be >= 0, got ${delta}`,
        );
      }
      // delta = 0 is a no-op — free/local models produce zero cost
      if (delta === 0) return;

      const ym = yearMonth ?? currentYearMonth();
      // Use atomic UPSERT-ADD: the ON CONFLICT clause adds delta to the
      // existing value. This avoids a separate read-then-write race.
      upsertStmt.run(agentId, ym, delta);
    },

    getSpend(agentId: string, yearMonth?: string): number {
      const ym = yearMonth ?? currentYearMonth();
      try {
        return readSpend(agentId, ym);
      } catch (err) {
        // Fail-open: a broken DB must not prevent turns from proceeding.
        process.stderr.write(
          `[zia/monthly-spend-store] getSpend failed for agent=${agentId} ` +
            `month=${ym}: ${String(err)}\n`,
        );
        return 0;
      }
    },

    getSpendOrThrow(agentId: string, yearMonth?: string): number {
      const ym = yearMonth ?? currentYearMonth();
      return readSpend(agentId, ym);
    },
  };
}
