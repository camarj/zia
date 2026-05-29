/**
 * audit-store-concurrency.test.ts — SC-10 multi-process fork harness.
 *
 * Spawns two child processes that share ONE temp-dir file DB and both call
 * SqliteAuditLog.record() concurrently. Asserts both writes succeed with
 * no SQLITE_BUSY surfacing to the caller (retryWithJitter absorbs it).
 *
 * Covers: SC-10, SPEC-R3 (BEGIN IMMEDIATE), SPEC-R4 (retry-with-jitter).
 *
 * Architecture:
 *  - Parent process creates the temp DB, then spawns two child processes
 *    passing the DB path via argv.
 *  - Each child opens the DB, constructs SqliteAuditLog, calls record(),
 *    exits with code 0 on success or 1 on error.
 *  - Parent awaits both children and asserts both exited 0.
 *  - The child script is written to a temp file so vitest pool:forks can
 *    spawn it as a plain Node process without vitest overhead.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline worker script — written to disk so Node can fork it without vitest
// ---------------------------------------------------------------------------

/**
 * The child process script source. It:
 *   1. Imports openDatabase + SqliteAuditLog from the package src.
 *   2. Opens the DB at argv[2].
 *   3. Records one audit entry.
 *   4. Exits 0 on success, 1 on any error.
 *
 * Uses dynamic import so ESM works cleanly in the child fork.
 */
const CHILD_SCRIPT = `
import { openDatabase } from "__SRC__/db.ts";
import { SqliteAuditLog } from "__SRC__/audit-store.ts";

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("child: no DB path provided\\n");
  process.exit(1);
}

try {
  const db = openDatabase(dbPath);
  const log = new SqliteAuditLog(db);

  await log.record({
    timestamp: new Date().toISOString(),
    toolCallId: "concurrency-" + process.pid,
    toolName: "concurrent_tool",
    riskLevel: "trivial",
    decision: "auto",
    approver: null,
    input: { pid: process.pid },
    output: { ok: true },
    error: null,
  });

  db.close();
  process.exit(0);
} catch (err) {
  process.stderr.write("child error: " + String(err) + "\\n");
  process.exit(1);
}
`.trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(__dirname, "..", "src");

function spawnChild(scriptPath: string, dbPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, [dbPath], {
      execArgv: ["--experimental-vm-modules", "--import", "tsx/esm"],
      stdio: "pipe",
    });

    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[child ${child.pid}] ${d.toString()}`);
    });

    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// SC-10 test
// ---------------------------------------------------------------------------

describe("SqliteAuditLog concurrency — two processes, one DB (SC-10)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zia-concurrency-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    "both child processes write successfully with no SQLITE_BUSY surfacing",
    async () => {
      // Create the DB via openDatabase in the parent so schema is ready
      const { openDatabase } = await import("../src/db.ts");
      const dbPath = join(tempDir, "shared.db");
      const db = openDatabase(dbPath);
      db.close(); // release parent handle; children will open their own

      // Write the child script to disk with the resolved src path
      const childScript = CHILD_SCRIPT.replace(/__SRC__/g, srcDir);
      const scriptPath = join(tempDir, "child-worker.mjs");
      writeFileSync(scriptPath, childScript, "utf8");

      // Spawn both children simultaneously
      const [code1, code2] = await Promise.all([
        spawnChild(scriptPath, dbPath),
        spawnChild(scriptPath, dbPath),
      ]);

      expect(code1).toBe(0);
      expect(code2).toBe(0);

      // Verify both rows landed in the DB
      const verifyDb = openDatabase(dbPath);
      const rows = verifyDb
        .prepare(
          "SELECT COUNT(*) as cnt FROM audit_entries WHERE tool_name = 'concurrent_tool'",
        )
        .get() as { cnt: number };

      expect(rows.cnt).toBe(2);
      verifyDb.close();
    },
    30_000, // 30s timeout — fork + retry may take a few seconds
  );
});
