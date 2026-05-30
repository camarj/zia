/**
 * db.ts — openDatabase: WAL, busy_timeout, schema migrations, checkpoint.
 *
 * Design decisions (ADR-3, ADR-5, ADR-7, ADR-D6):
 *  - WAL mode is mandatory; openDatabase throws on :memory: (no WAL file).
 *  - busy_timeout = 1000 ms (SQLite-level wait; app retry adds more resilience).
 *  - Schema version gate: throws if DB schema_version > SCHEMA_VERSION.
 *  - Checkpoint cadence: PASSIVE every 50 writes + TRUNCATE on process exit.
 *  - Module-level guard: only ONE process.on('exit') handler is ever registered
 *    per process (prevents handler stacking in test isolation scenarios).
 *  - The caller owns the returned Database handle lifetime.
 *
 * v2 additions: DDL_MESSAGES, DDL_MESSAGES_FTS, DDL_MESSAGES_FTS_TRIGGERS
 * appended after audit blocks (ADR-D6 — additive only, no ALTER).
 */

import Database from "./sqlite-shim.ts";
import type { Database as DB } from "./sqlite-shim.ts";
import {
  DDL_AUDIT_ENTRIES,
  DDL_AUDIT_FTS,
  DDL_AUDIT_FTS_TRIGGERS,
  DDL_MESSAGES,
  DDL_MESSAGES_FTS,
  DDL_MESSAGES_FTS_TRIGGERS,
  DDL_META,
  DDL_SESSIONS,
  SCHEMA_VERSION,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Module-level checkpoint state (shared across all openDatabase calls in the
// same process — coordinates the 50-write cadence and exit handler guard).
// ---------------------------------------------------------------------------

/** Shared write counter across all stores in this process. */
export let writeCounter = 0;

/** Increment the write counter and checkpoint every 50 writes (PASSIVE). */
export function incrementWriteCounter(db: DB): void {
  writeCounter++;
  if (writeCounter % 50 === 0) {
    db.pragma("wal_checkpoint(PASSIVE)");
  }
}

/** Reset write counter (used in tests). */
export function resetWriteCounter(): void {
  writeCounter = 0;
}

// Guard: only register the exit handler once per process lifetime.
let exitHandlerRegistered = false;

// Keep a reference to the most-recently opened DB for the exit checkpoint.
// In zia's one-DB-per-container model this is always the one we care about.
let lastOpenedDb: DB | null = null;

function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  process.on("exit", () => {
    try {
      if (lastOpenedDb && lastOpenedDb.open) {
        lastOpenedDb.pragma("wal_checkpoint(TRUNCATE)");
      }
    } catch {
      // Swallow — we're in exit, nothing to do about it.
    }
  });
}

// ---------------------------------------------------------------------------
// openDatabase
// ---------------------------------------------------------------------------

/**
 * Open (or create) the SQLite database at the given file path.
 *
 * After open:
 *   1. PRAGMA journal_mode=WAL — throws if the FS cannot support WAL.
 *   2. PRAGMA busy_timeout=1000 — 1 s SQLite-level wait.
 *   3. Run DDL migrations (CREATE TABLE IF NOT EXISTS + FTS + triggers).
 *   4. Schema version gate — throws if schema_version > SCHEMA_VERSION.
 *   5. Register process.on('exit') TRUNCATE checkpoint (once per process).
 *
 * @param path  Filesystem path to the SQLite file.
 *              Must NOT be ':memory:' — WAL requires a real file.
 * @returns The opened Database handle. The caller owns the lifetime.
 */
export function openDatabase(path: string): DB {
  if (path === ":memory:") {
    throw new Error(
      "zia/persistence: openDatabase does not accept ':memory:' — " +
        "WAL mode requires a real file path.",
    );
  }

  const db = new Database(path);

  // 1. WAL mode
  const walResult = db.pragma("journal_mode=WAL", { simple: true }) as string;
  if (walResult !== "wal") {
    db.close();
    throw new Error(
      `zia/persistence: Failed to enable WAL mode on '${path}'. ` +
        `journal_mode returned '${walResult}'. ` +
        "WAL is not supported on this filesystem (e.g. NFS).",
    );
  }

  // 2. Busy timeout
  db.pragma("busy_timeout=1000");

  // 3. Schema DDL — run each statement block in sequence.
  //    _meta must be first so the version gate can read it.
  //    v2: messages tables appended after audit blocks (ADR-D6).
  for (const block of [
    DDL_META,
    DDL_SESSIONS,
    DDL_AUDIT_ENTRIES,
    DDL_AUDIT_FTS,
    DDL_AUDIT_FTS_TRIGGERS,
    DDL_MESSAGES,
    DDL_MESSAGES_FTS,
    DDL_MESSAGES_FTS_TRIGGERS,
  ]) {
    db.exec(block);
  }

  // 4. Schema version gate (SPEC-R6)
  const versionRow = db
    .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  const actual = versionRow ? parseInt(versionRow.value, 10) : 0;
  if (actual > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `zia/persistence: DB schema version ${actual} > expected ${SCHEMA_VERSION}. ` +
        "Upgrade the package.",
    );
  }

  // 5. Exit handler (once per process)
  lastOpenedDb = db;
  registerExitHandler();

  return db;
}
