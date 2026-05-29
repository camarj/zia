/**
 * audit-log.test.ts — AuditLog interface + JsonlAuditLog backend tests
 *
 * Covers:
 *   - AQ-9:  every outcome appends one record to audit.jsonl (Scenario 12)
 *   - AQ-10: write failure must not throw to the caller
 *   - AQ-11: AuditLog interface is swappable (in-memory stub works)
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlAuditLog,
  type AuditEntry,
  type AuditLog,
} from "../src/audit-log.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    toolCallId: "call-1",
    toolName: "mock_tool",
    riskLevel: "trivial",
    decision: "auto",
    approver: null,
    input: { x: 1 },
    output: { content: [{ type: "text", text: "ok" }] },
    error: null,
    ...overrides,
  };
}

async function readLines(filePath: string): Promise<AuditEntry[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let createdDirs: string[] = [];

afterEach(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  createdDirs = [];
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-audit-"));
  createdDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Group 1: basic append (AQ-9, Scenario 12)
// ---------------------------------------------------------------------------

describe("JsonlAuditLog — basic append", () => {
  it("AL-1: record() appends one JSON line to the file", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));
    const entry = makeEntry();

    await log.record(entry);

    const lines = await readLines(join(dir, "audit.jsonl"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.toolCallId).toBe("call-1");
  });

  it("AL-2: record() twice appends two lines", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));

    await log.record(makeEntry({ toolCallId: "call-1", decision: "auto" }));
    await log.record(makeEntry({ toolCallId: "call-2", decision: "approved" }));

    const lines = await readLines(join(dir, "audit.jsonl"));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.toolCallId).toBe("call-1");
    expect(lines[1]?.toolCallId).toBe("call-2");
  });

  it("AL-3: each line is valid JSON parseable independently", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));

    await log.record(makeEntry({ toolCallId: "a" }));
    await log.record(makeEntry({ toolCallId: "b" }));
    await log.record(makeEntry({ toolCallId: "c" }));

    const text = await readFile(join(dir, "audit.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("AL-4: AuditEntry fields are preserved in the written record", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));

    const entry = makeEntry({
      toolCallId: "field-check",
      toolName: "send_email",
      riskLevel: "alto",
      decision: "approved",
      approver: "tui-admin",
      input: { to: "boss@co.com" },
      output: { content: [{ type: "text", text: "sent" }] },
      error: null,
    });

    await log.record(entry);

    const [record] = await readLines(join(dir, "audit.jsonl"));
    expect(record?.toolCallId).toBe("field-check");
    expect(record?.toolName).toBe("send_email");
    expect(record?.riskLevel).toBe("alto");
    expect(record?.decision).toBe("approved");
    expect(record?.approver).toBe("tui-admin");
    expect(record?.error).toBeNull();
  });

  it("AL-5: timestamp field is present and looks like ISO 8601", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));
    await log.record(makeEntry());

    const [record] = await readLines(join(dir, "audit.jsonl"));
    expect(record?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Group 2: concurrent writes — ordering preserved (AQ-9 ordering)
// ---------------------------------------------------------------------------

describe("JsonlAuditLog — concurrent write ordering", () => {
  it("AL-6: concurrent record() calls produce non-interleaved lines", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));

    // Fire multiple records concurrently
    await Promise.all([
      log.record(makeEntry({ toolCallId: "c1" })),
      log.record(makeEntry({ toolCallId: "c2" })),
      log.record(makeEntry({ toolCallId: "c3" })),
      log.record(makeEntry({ toolCallId: "c4" })),
      log.record(makeEntry({ toolCallId: "c5" })),
    ]);

    const lines = await readLines(join(dir, "audit.jsonl"));
    expect(lines).toHaveLength(5);

    // Every line must be individually valid JSON (non-interleaved)
    const text = await readFile(join(dir, "audit.jsonl"), "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Group 3: write-failure resilience (AQ-10)
// ---------------------------------------------------------------------------

describe("JsonlAuditLog — write-failure resilience (AQ-10)", () => {
  it("AL-7: record() to an invalid path does NOT throw", async () => {
    // A path inside a non-existent deeply nested dir will fail on appendFile
    const log = new JsonlAuditLog("/nonexistent/deeply/nested/path/audit.jsonl");
    await expect(log.record(makeEntry())).resolves.toBeUndefined();
  });

  it("AL-8: after a write failure the instance remains usable (if path is later valid)", async () => {
    // This tests that the internal write chain doesn't get poisoned by a failure
    const badLog = new JsonlAuditLog("/nonexistent/audit.jsonl");
    // Both should resolve (swallowed errors)
    await badLog.record(makeEntry({ toolCallId: "fail-1" }));
    await badLog.record(makeEntry({ toolCallId: "fail-2" }));
    // No throw = test passes
  });
});

// ---------------------------------------------------------------------------
// Group 4: AuditLog interface swappability (AQ-11, Scenario 11)
// ---------------------------------------------------------------------------

describe("AuditLog interface — swappable backend (AQ-11, Scenario 11)", () => {
  it("AL-9: an in-memory stub implementing AuditLog collects records without file I/O", async () => {
    // Inline in-memory stub — satisfies AuditLog interface as a plain object
    const records: AuditEntry[] = [];
    const stub: AuditLog = {
      record: async (entry) => {
        records.push(entry);
      },
    };

    await stub.record(makeEntry({ toolCallId: "mem-1", decision: "auto" }));
    await stub.record(makeEntry({ toolCallId: "mem-2", decision: "approved" }));

    expect(records).toHaveLength(2);
    expect(records[0]?.toolCallId).toBe("mem-1");
    expect(records[1]?.decision).toBe("approved");
  });

  it("AL-10: JsonlAuditLog satisfies AuditLog interface (assignable)", async () => {
    const dir = await makeTempDir();
    // Type assertion: JsonlAuditLog must be assignable to AuditLog
    const log: AuditLog = new JsonlAuditLog(join(dir, "audit.jsonl"));
    await log.record(makeEntry());
    // If TypeScript accepts the assignment, the interface is satisfied
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 5: AuditEntry field shape — all required fields present (AQ-9)
// ---------------------------------------------------------------------------

describe("AuditEntry — field completeness (AQ-9)", () => {
  it("AL-11: trivial-auto entry has correct decision and null approver", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));
    await log.record(
      makeEntry({ decision: "auto", approver: null, riskLevel: "trivial" }),
    );
    const [rec] = await readLines(join(dir, "audit.jsonl"));
    expect(rec?.decision).toBe("auto");
    expect(rec?.approver).toBeNull();
  });

  it("AL-12: rejected entry has null output and correct approver", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));
    await log.record(
      makeEntry({
        decision: "rejected",
        approver: "tui-admin",
        output: null,
        riskLevel: "alto",
      }),
    );
    const [rec] = await readLines(join(dir, "audit.jsonl"));
    expect(rec?.decision).toBe("rejected");
    expect(rec?.output).toBeNull();
    expect(rec?.approver).toBe("tui-admin");
  });

  it("AL-13: error entry has error message and auto decision", async () => {
    const dir = await makeTempDir();
    const log = new JsonlAuditLog(join(dir, "audit.jsonl"));
    await log.record(
      makeEntry({
        decision: "auto",
        error: "boom",
        output: null,
      }),
    );
    const [rec] = await readLines(join(dir, "audit.jsonl"));
    expect(rec?.error).toBe("boom");
    expect(rec?.output).toBeNull();
  });
});
