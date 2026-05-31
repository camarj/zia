/**
 * session-store.ts — SessionStore class + buildSessionKey() (spec §3.2, §3.3).
 *
 * Design decisions:
 *  - SessionStore accepts an opened Database handle via constructor (O1).
 *  - All methods are synchronous — better-sqlite3 is sync; callers in async
 *    contexts do NOT need to await.
 *  - Write transactions use BEGIN IMMEDIATE via .immediate() (SPEC-R3).
 *  - Each write increments the shared write counter for checkpoint (SPEC-R5).
 *  - buildSessionKey() is a standalone exported function — not a class method.
 *    It enforces the "agent:main:{platform}:{chatType}:{chatId}" format and
 *    throws if any part contains a colon (SPEC-R12).
 *  - getLineage() walks the flat parent chain iteratively (no recursive CTE),
 *    returning ancestors oldest-first (ADR-6).
 */

import { v4 as uuidv4 } from "uuid";
import type { Database } from "./sqlite-shim.ts";
import type { SessionKeyParts, SessionRecord } from "./types.ts";
import { incrementWriteCounter } from "./db.ts";
import { retryWithJitter } from "./retry.ts";

// ---------------------------------------------------------------------------
// buildSessionKey (SPEC-R12)
// ---------------------------------------------------------------------------

/**
 * Build the canonical session key from its three variable parts.
 *
 * Format: "agent:main:{platform}:{chatType}:{chatId}"
 *
 * None of platform / chatType / chatId may contain a colon. Throws if any
 * part contains one — this prevents ambiguous key parsing at the gateway.
 *
 * @throws Error if any part contains a colon character.
 */
export function buildSessionKey(parts: SessionKeyParts): string {
  const { platform, chatType, chatId } = parts;

  for (const [name, value] of [
    ["platform", platform],
    ["chatType", chatType],
    ["chatId", chatId],
  ] as const) {
    if (value.includes(":")) {
      throw new Error(
        `zia/persistence: buildSessionKey — '${name}' must not contain a colon, got: "${value}"`,
      );
    }
  }

  return `agent:main:${platform}:${chatType}:${chatId}`;
}

// ---------------------------------------------------------------------------
// Row shape returned by SQLite for sessions
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  session_key: string;
  source_platform: string;
  model_config: string;
  pi_session_path: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  parent_session_id: string | null;
}

// ---------------------------------------------------------------------------
// Row → SessionRecord mapping
// ---------------------------------------------------------------------------

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    sourcePlatform: row.source_platform,
    modelConfig: row.model_config,
    piSessionPath: row.pi_session_path,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    parentSessionId: row.parent_session_id,
  };
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly insertStmt: ReturnType<Database["prepare"]>;
  private readonly selectByKeyStmt: ReturnType<Database["prepare"]>;
  private readonly selectByIdStmt: ReturnType<Database["prepare"]>;
  private readonly endSessionStmt: ReturnType<Database["prepare"]>;
  private readonly setParentStmt: ReturnType<Database["prepare"]>;

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO sessions
        (id, session_key, source_platform, model_config, pi_session_path,
         started_at, ended_at, end_reason, parent_session_id)
      VALUES
        (@id, @sessionKey, @sourcePlatform, @modelConfig, @piSessionPath,
         @startedAt, @endedAt, @endReason, @parentSessionId)
    `);

    this.selectByKeyStmt = db.prepare(`
      SELECT * FROM sessions WHERE session_key = ?
    `);

    this.selectByIdStmt = db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    this.endSessionStmt = db.prepare(`
      UPDATE sessions
         SET ended_at  = @endedAt,
             end_reason = @endReason
       WHERE id = @id
    `);

    this.setParentStmt = db.prepare(`
      UPDATE sessions
         SET parent_session_id = @parentSessionId
       WHERE id = @id
    `);
  }

  /**
   * Insert a new session row and return the full SessionRecord (with generated id).
   * Uses BEGIN IMMEDIATE for write-lock safety (SPEC-R3).
   */
  createSession(record: Omit<SessionRecord, "id">): SessionRecord {
    const id = uuidv4();

    const writeTransaction = this.db.transaction(() => {
      this.insertStmt.run({
        id,
        sessionKey: record.sessionKey,
        sourcePlatform: record.sourcePlatform,
        modelConfig: record.modelConfig,
        piSessionPath: record.piSessionPath ?? null,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? null,
        endReason: record.endReason ?? null,
        parentSessionId: record.parentSessionId ?? null,
      });
    });

    retryWithJitter(() =>
      (writeTransaction as unknown as { immediate: () => void }).immediate(),
    );

    incrementWriteCounter(this.db);

    return { id, ...record };
  }

  /**
   * Look up a session by its canonical key.
   * Returns null if not found.
   */
  resolveByKey(sessionKey: string): SessionRecord | null {
    const row = this.selectByKeyStmt.get(sessionKey) as
      | SessionRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Mark a session as ended with a timestamp and reason.
   * Uses BEGIN IMMEDIATE (SPEC-R3).
   */
  endSession(id: string, reason: string): void {
    const endedAt = new Date().toISOString();

    const writeTransaction = this.db.transaction(() => {
      this.endSessionStmt.run({ id, endedAt, endReason: reason });
    });

    retryWithJitter(() =>
      (writeTransaction as unknown as { immediate: () => void }).immediate(),
    );

    incrementWriteCounter(this.db);
  }

  /**
   * Return the flat ancestor chain for a session, oldest first.
   *
   * Walks the parent_session_id FK iteratively (no recursive CTE — MVP).
   * The session itself is NOT included; only its ancestors.
   * Returns [] if the session has no parent.
   */
  getLineage(id: string): SessionRecord[] {
    const ancestors: SessionRecord[] = [];

    let current = this.selectByIdStmt.get(id) as SessionRow | undefined;
    if (!current) return [];

    // Walk up the parent chain
    while (current?.parent_session_id) {
      const parent = this.selectByIdStmt.get(
        current.parent_session_id,
      ) as SessionRow | undefined;
      if (!parent) break;
      ancestors.unshift(rowToRecord(parent)); // oldest first
      current = parent;
    }

    return ancestors;
  }

  /**
   * Record a parent→child lineage relationship between two existing sessions.
   *
   * Sets `parent_session_id` on the child row to point at the parent. This is
   * the write-side of the compaction lineage contract (F-CORE-6, SPEC-LINEAGE-2,
   * ADR-4): after pi.dev fires `compaction_end` the composition root calls this
   * method so ancestry queries via `getLineage()` traverse the full generation
   * chain.
   *
   * Uses BEGIN IMMEDIATE for write-lock safety (SPEC-R3).
   *
   * @param childId   ID of the session that was born from compaction.
   * @param parentId  ID of the session that triggered the compaction.
   */
  recordLineage(childId: string, parentId: string): void {
    const writeTransaction = this.db.transaction(() => {
      this.setParentStmt.run({ id: childId, parentSessionId: parentId });
    });

    retryWithJitter(() =>
      (writeTransaction as unknown as { immediate: () => void }).immediate(),
    );

    incrementWriteCounter(this.db);
  }
}
