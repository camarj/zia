/**
 * audit-store.test.ts — RED tests for SqliteAuditLog (SC-05..SC-09).
 *
 * Uses temp-dir file DBs (WAL + trigger behavior requires real files).
 * FTS5 trigger is asserted here — SqliteAuditLog.record() must NOT manually
 * insert into audit_entries_fts; the trigger fires atomically.
 *
 * Covers: SC-05, SC-06, SC-07, SC-08, SC-09
 *         SPEC-R7 (FTS via triggers only), R8 (sanitization), R9 (deser),
 *         R10 (record never throws), AQ-10 parity.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry, RiskLevel } from "@zia/callbacks";

// Helpers -----------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-audit-"));
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    toolCallId: "tc-001",
    toolName: "send_email",
    riskLevel: "alto" satisfies RiskLevel,
    decision: "approved",
    approver: "raulj.camacho@gmail.com",
    input: { to: "test@example.com", subject: "Hello" },
    output: { messageId: "msg-001" },
    error: null,
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// SC-05 — record() persists row in audit_entries with all fields correct
// -------------------------------------------------------------------------

describe("SqliteAuditLog.record() — persistence (SC-05, SPEC-R3)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists a row in audit_entries with all fields matching AuditEntry", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const log = new SqliteAuditLog(db);
    const entry = makeEntry();

    await log.record(entry);

    const row = db
      .prepare("SELECT * FROM audit_entries WHERE tool_call_id = ?")
      .get(entry.toolCallId) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.timestamp).toBe(entry.timestamp);
    expect(row!.tool_call_id).toBe(entry.toolCallId);
    expect(row!.tool_name).toBe(entry.toolName);
    expect(row!.risk_level).toBe(entry.riskLevel);
    expect(row!.decision).toBe(entry.decision);
    expect(row!.approver).toBe(entry.approver);
    expect(row!.input).toBe(JSON.stringify(entry.input));
    expect(row!.output).toBe(JSON.stringify(entry.output));
    expect(row!.error).toBeNull();

    db.close();
  });

  it("stores null output and null error columns correctly", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir, "test2.db"));
    const log = new SqliteAuditLog(db);
    const entry = makeEntry({ output: null, decision: "rejected" });

    await log.record(entry);

    const row = db
      .prepare("SELECT output, error FROM audit_entries WHERE tool_call_id = ?")
      .get(entry.toolCallId) as { output: string | null; error: string | null };

    expect(row.output).toBeNull();
    expect(row.error).toBeNull();
    db.close();
  });
});

// -------------------------------------------------------------------------
// SC-06 — FTS triggered by INSERT, not by manual dual-write (SPEC-R7)
// -------------------------------------------------------------------------

describe("SqliteAuditLog.record() — FTS trigger (SC-06, SPEC-R7)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("trigger populates audit_entries_fts after record()", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const log = new SqliteAuditLog(db);
    const entry = makeEntry({ toolName: "send_email" });

    await log.record(entry);

    // FTS MATCH on tool_name — trigger must have fired
    const ftsRows = db
      .prepare(
        `SELECT rowid FROM audit_entries_fts WHERE audit_entries_fts MATCH '"send_email"'`,
      )
      .all() as { rowid: number }[];

    expect(ftsRows.length).toBeGreaterThan(0);
    db.close();
  });
});

// -------------------------------------------------------------------------
// SC-07 — search() returns matching entry, not unrelated entry
// -------------------------------------------------------------------------

describe("SqliteAuditLog.search() — filtering (SC-07, SPEC-R9)", () => {
  let tempDir: string;
  let tempDir2: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    tempDir2 = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(tempDir2, { recursive: true, force: true });
  });

  it("returns the send_email entry but not query_linear", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const log = new SqliteAuditLog(db);

    await log.record(makeEntry({ toolCallId: "tc-1", toolName: "send_email" }));
    await log.record(
      makeEntry({ toolCallId: "tc-2", toolName: "query_linear" }),
    );

    const results = log.search("send_email");

    const names = results.map((r: AuditEntry) => r.toolName);
    expect(names).toContain("send_email");
    expect(names).not.toContain("query_linear");

    db.close();
  });

  it("deserializes input/output back to Record objects (SPEC-R9)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir2, "test.db"));
    const log = new SqliteAuditLog(db);
    const entry = makeEntry({
      toolName: "query_linear",
      input: { project: "zia", limit: 10 },
      output: { issues: [{ id: "ZIA-1" }] },
    });

    await log.record(entry);

    const results = log.search("query_linear");

    expect(results.length).toBe(1);
    expect(results[0]!.input).toEqual({ project: "zia", limit: 10 });
    expect(results[0]!.output).toEqual({ issues: [{ id: "ZIA-1" }] });

    db.close();
  });
});

// -------------------------------------------------------------------------
// SC-08 — search() sanitizes FTS5 operators (SPEC-R8)
// -------------------------------------------------------------------------

describe("SqliteAuditLog.search() — query sanitization (SC-08, SPEC-R8)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not throw when query contains FTS5 operators", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const log = new SqliteAuditLog(db);
    await log.record(makeEntry({ toolName: "send_email" }));

    // Raw FTS5 operators — must be neutralized by wrapping in double-quotes
    expect(() => log.search("send_email AND NOT query_linear")).not.toThrow();
    expect(() => log.search("NEAR(send_email query_linear)")).not.toThrow();
    expect(() => log.search("send_email*")).not.toThrow();

    db.close();
  });

  it("still finds matching entries after sanitization", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir, "test2.db"));
    const log = new SqliteAuditLog(db);
    await log.record(makeEntry({ toolName: "send_email" }));

    // "send_email AND NOT query_linear" sanitized to '"send_email" "AND" "NOT" "query_linear"'
    // The quoted "AND", "NOT" are literal terms not operators, so no crash.
    // send_email row won't match "AND NOT query_linear" literally, but must not throw.
    const results = log.search("send_email");
    expect(results.length).toBe(1);

    db.close();
  });
});

// -------------------------------------------------------------------------
// SC-09 — record() never throws to caller (SPEC-R10, AQ-10 parity)
// -------------------------------------------------------------------------

describe("SqliteAuditLog.record() — never throws (SC-09, SPEC-R10)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves (does not reject) when audit_entries table has been dropped", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteAuditLog } = await import("../src/audit-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const log = new SqliteAuditLog(db);

    // Simulate write failure by dropping the table
    db.exec("DROP TABLE audit_entries");

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // MUST resolve, not reject
    await expect(log.record(makeEntry())).resolves.toBeUndefined();

    // MUST write something to stderr
    expect(stderrSpy).toHaveBeenCalled();

    stderrSpy.mockRestore();
    db.close();
  });
});
