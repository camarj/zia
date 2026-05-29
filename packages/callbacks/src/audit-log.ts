/**
 * audit-log.ts — AuditLog interface + JSONL append-only backend.
 *
 * Design decisions:
 * - D5: AuditLog is an interface so Slice 3 can swap in SqliteAuditLog without
 *   touching the gate or queue.
 * - AQ-10: write failures are caught and swallowed (logged to stderr) — an
 *   audit outage must never crash the agent or block a tool result.
 * - AQ-9: every tool call outcome produces exactly one record, one JSON object
 *   per line, appended with fs.appendFile (O_APPEND — safe for the
 *   single-process-per-container model zia uses).
 * - Writes are serialized through an internal promise chain to guarantee
 *   line ordering and prevent interleaved partial writes under concurrent
 *   record() calls.
 */

import { appendFile } from "node:fs/promises";
import type { RiskLevel } from "./approval.js";

// ---------------------------------------------------------------------------
// AuditEntry — one record per tool call outcome (AQ-9 field table)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  /** UTC time of record write (ISO 8601) */
  timestamp: string;
  /** pi.dev-provided id — unique per call */
  toolCallId: string;
  /** snake_case tool name */
  toolName: string;
  /** from PolicyClassifier */
  riskLevel: RiskLevel;
  /** outcome of the gate decision */
  decision: "auto" | "approved" | "rejected" | "error";
  /** null for trivial/auto; resolver-supplied string for gated calls */
  approver: string | null;
  /** params passed to the tool */
  input: Record<string, unknown>;
  /** tool result if auto or approved; null if rejected or error */
  output: Record<string, unknown> | null;
  /** error message if decision === "error"; null otherwise */
  error: string | null;
}

// ---------------------------------------------------------------------------
// AuditLog interface — swappable backend (AQ-11)
// ---------------------------------------------------------------------------

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// JsonlAuditLog — append-only JSONL file backend (Slice 2)
// ---------------------------------------------------------------------------

export class JsonlAuditLog implements AuditLog {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /**
   * Append one JSON object + newline to the audit file.
   *
   * Writes are serialized through an internal promise chain to preserve
   * ordering under concurrent calls. A write failure is caught and logged
   * to stderr — it never throws to the caller (AQ-10).
   */
  record(entry: AuditEntry): Promise<void> {
    // Append to the chain so writes are strictly ordered (FIFO).
    // Use a separate `result` promise that the CALLER awaits — it resolves
    // when THIS write has completed (or been swallowed). The chain tail
    // always advances via `finally` so one failure doesn't block subsequent
    // writes.
    let resolveResult!: () => void;
    const result = new Promise<void>((r) => {
      resolveResult = r;
    });

    this.writeChain = this.writeChain
      .then(async () => {
        try {
          const line = JSON.stringify(entry) + "\n";
          await appendFile(this.filePath, line, "utf8");
        } catch (err) {
          // Swallow — audit write failure must not crash the agent (AQ-10)
          process.stderr.write(
            `[zia/audit] write failure for ${this.filePath}: ${String(err)}\n`,
          );
        } finally {
          resolveResult();
        }
      })
      .catch(() => {
        // Belt-and-suspenders: if the .then() itself throws for any reason,
        // still resolve the caller and keep the chain alive.
        resolveResult();
      });

    return result;
  }
}
