/**
 * tool-gate.test.ts — Tests for wrapToolsWithApproval HOF.
 *
 * Maps directly to AQ-1..AQ-13 acceptance scenarios in the spec.
 * Uses fixtures from src/__fixtures__/ — no TUI, no file I/O (in-memory AuditLog stub).
 */

import { describe, expect, it } from "vitest";

import { PolicyClassifier } from "../src/approval.js";
import {
  makeMockExternalPostTool,
  makeMockTrivialReadTool,
  POLICIES_FIXTURE,
} from "../src/__fixtures__/mock-tools.fixture.js";
import {
  AlwaysApproveResolver,
  AlwaysRejectResolver,
  RecordingResolver,
} from "../src/__fixtures__/resolvers.fixture.js";
import type { AuditEntry, AuditLog } from "../src/audit-log.js";
import { ApprovalQueue } from "../src/queue.js";
import { ApprovalSerializer } from "../src/serializer.js";
import type { WrappableTool } from "../src/types.js";
import { wrapToolsWithApproval } from "../src/tool-gate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory AuditLog stub — collects records in an array for assertions. */
class MemoryAuditLog implements AuditLog {
  readonly records: AuditEntry[] = [];
  record(entry: AuditEntry): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
}

/** Always-rejecting AuditLog stub — for audit-failure-swallowed tests. */
class FailingAuditLog implements AuditLog {
  record(_entry: AuditEntry): Promise<void> {
    return Promise.reject(new Error("audit write failure"));
  }
}

function makeDeps(resolver = AlwaysApproveResolver) {
  const classifier = PolicyClassifier.fromPolicies(POLICIES_FIXTURE);
  const auditLog = new MemoryAuditLog();
  const queue = new ApprovalQueue(resolver, new ApprovalSerializer());
  return { classifier, auditLog, queue };
}

/** Assert that an array element at index 0 (or N) is defined. */
function first<T>(arr: T[]): T {
  const v = arr[0];
  if (v === undefined) throw new Error("Expected at least one element");
  return v;
}

function second<T>(arr: T[]): T {
  const v = arr[1];
  if (v === undefined) throw new Error("Expected at least two elements");
  return v;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Trivial auto-execute (AQ-1)
// ---------------------------------------------------------------------------

describe("Scenario 1 — trivial auto-execute", () => {
  it("runs the tool body immediately and leaves queue empty", async () => {
    const store: string[] = [];
    const deps = makeDeps();
    const wrapped = first(wrapToolsWithApproval([makeMockTrivialReadTool(store)], deps));

    const result = await wrapped.execute("call-1", { query: "hello" });

    expect(store).toEqual(["read:call-1"]);
    expect(deps.queue.pending).toHaveLength(0);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("appends an audit record with decision=auto and approver=null", async () => {
    const store: string[] = [];
    const deps = makeDeps();
    const wrapped = first(wrapToolsWithApproval([makeMockTrivialReadTool(store)], deps));

    await wrapped.execute("call-1", { query: "hello" });

    expect(deps.auditLog.records).toHaveLength(1);
    const rec = deps.auditLog.records[0]!;
    expect(rec.decision).toBe("auto");
    expect(rec.approver).toBeNull();
    expect(rec.toolName).toBe("mock_trivial_read");
    expect(rec.riskLevel).toBe("trivial");
  });

  it("returns the tool's own result verbatim", async () => {
    const store: string[] = [];
    const deps = makeDeps();
    const wrapped = first(wrapToolsWithApproval([makeMockTrivialReadTool(store)], deps));

    const result = await wrapped.execute("call-1", { query: "hello" });

    expect(result.content[0]?.text).toContain("hello");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Alto blocks until decision (AQ-2)
// ---------------------------------------------------------------------------

describe("Scenario 2 — alto blocks until decision", () => {
  it("keeps promise pending while no decision is issued", async () => {
    const store: string[] = [];
    const recorder = new RecordingResolver();
    const deps = makeDeps(recorder);
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    const callPromise = wrapped.execute("call-2", { message: "hi" });

    // Give the event loop a tick to settle the serializer chain.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Promise must still be pending — queue has one entry.
    let settled = false;
    void callPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(deps.queue.pending).toHaveLength(1);
    expect(deps.queue.pending[0]!.request.toolCallId).toBe("call-2");
    expect(deps.queue.pending[0]!.request.riskLevel).toBe("alto");

    // Clean up — approve so the test doesn't hang.
    const handle = await recorder.next();
    handle.approve();
    await callPromise;
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Alto approved → side effect runs (AQ-3)
// ---------------------------------------------------------------------------

describe("Scenario 3 — alto approved", () => {
  it("executes the tool body and returns the tool result", async () => {
    const store: string[] = [];
    const deps = makeDeps(AlwaysApproveResolver);
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    const result = await wrapped.execute("call-3", { message: "test" });

    expect(store).toEqual(["post:call-3"]);
    expect(result.content[0]?.text).toContain("Posted");
  });

  it("appends an audit record with decision=approved and the resolver approver", async () => {
    const store: string[] = [];
    const deps = makeDeps(AlwaysApproveResolver);
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    await wrapped.execute("call-3", { message: "test" });

    expect(deps.auditLog.records).toHaveLength(1);
    const rec = deps.auditLog.records[0]!;
    expect(rec.decision).toBe("approved");
    expect(rec.approver).toBe("test-admin");
    expect(rec.output).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Alto rejected → side effect does NOT run (AQ-4)
// ---------------------------------------------------------------------------

describe("Scenario 4 — alto rejected", () => {
  it("does not call the tool body and returns a clean rejection result", async () => {
    const store: string[] = [];
    const deps = makeDeps(AlwaysRejectResolver);
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    const result = await wrapped.execute("call-4", { message: "test" });

    expect(store).toHaveLength(0);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toMatch(/reject/i);
    expect(result.details).toMatchObject({ rejected: true });
  });

  it("does not throw", async () => {
    const store: string[] = [];
    const deps = makeDeps(AlwaysRejectResolver);
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    await expect(wrapped.execute("call-4", {})).resolves.toBeDefined();
  });

  it("appends an audit record with decision=rejected and output=null", async () => {
    const store: string[] = [];
    const deps = makeDeps(AlwaysRejectResolver);
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    await wrapped.execute("call-4", { message: "test" });

    const rec = deps.auditLog.records[0]!;
    expect(rec.decision).toBe("rejected");
    expect(rec.output).toBeNull();
    expect(rec.approver).toBe("test-admin");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Unlisted tool defaults to alto end-to-end (AQ-5)
// ---------------------------------------------------------------------------

describe("Scenario 5 — unlisted tool defaults to alto", () => {
  it("routes unlisted tool through the resolver (does not auto-execute)", async () => {
    const recorder = new RecordingResolver();
    const deps = makeDeps(recorder);

    // An unlisted tool not in POLICIES_FIXTURE.
    const unlisted: WrappableTool = {
      name: "unknown_tool",
      label: "Unknown",
      description: "Not listed in policies",
      parameters: {},
      async execute() {
        return { content: [{ type: "text", text: "executed" }], details: {} };
      },
    };
    const wrapped = first(wrapToolsWithApproval([unlisted], deps));

    const callPromise = wrapped.execute("call-5", {});

    // Give the event loop a tick for the serializer chain to start.
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(recorder.calls).toHaveLength(1);
    expect(deps.queue.pending[0]!.request.riskLevel).toBe("alto");

    const handle = await recorder.next();
    handle.approve();
    await callPromise;
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Serialized concurrent alto calls (AQ-6)
// ---------------------------------------------------------------------------

describe("Scenario 6 — serialized concurrent alto calls", () => {
  it("presents calls to the resolver one at a time (FIFO order)", async () => {
    const store: string[] = [];
    const recorder = new RecordingResolver();
    const deps = makeDeps(recorder);
    const tool = makeMockExternalPostTool(store);
    const wrapped = first(wrapToolsWithApproval([tool], deps));

    // Launch two calls concurrently.
    const pA = wrapped.execute("call-A", { message: "A" });
    const pB = wrapped.execute("call-B", { message: "B" });

    // First handle arrives.
    const h1 = await recorder.next();
    // Second must NOT have arrived yet (serialized).
    expect(recorder.calls).toHaveLength(1);
    h1.approve();

    // Now the second call can proceed.
    const h2 = await recorder.next();
    expect(recorder.calls).toHaveLength(2);
    h2.approve();

    await Promise.all([pA, pB]);
    // Both ran in order.
    expect(store).toContain("post:call-A");
    expect(store).toContain("post:call-B");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Trivial concurrent with blocked alto (AQ-6)
// ---------------------------------------------------------------------------

describe("Scenario 7 — trivial concurrent with blocked alto", () => {
  it("trivial completes immediately even while alto is blocked", async () => {
    const storeRead: string[] = [];
    const storePost: string[] = [];
    const recorder = new RecordingResolver();
    const deps = makeDeps(recorder);
    const trivialTool = makeMockTrivialReadTool(storeRead);
    const altoTool = makeMockExternalPostTool(storePost);
    const _wrapped7 = wrapToolsWithApproval([trivialTool, altoTool], deps);
    const wrappedTrivial = first(_wrapped7);
    const wrappedAlto = second(_wrapped7);

    // Launch both concurrently.
    const pAlto = wrappedAlto.execute("call-alto", { message: "post" });
    const pTrivial = wrappedTrivial.execute("call-trivial", { query: "read" });

    // Trivial must resolve without waiting for alto.
    await pTrivial;
    expect(storeRead).toEqual(["read:call-trivial"]);
    // Alto is still pending.
    expect(storePost).toHaveLength(0);

    // Settle alto.
    const h = await recorder.next();
    h.approve();
    await pAlto;
    expect(storePost).toEqual(["post:call-alto"]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Audit write failure is silent (AQ-10)
// ---------------------------------------------------------------------------

describe("Scenario 8 — audit write failure is silent", () => {
  it("trivial gate still returns result even when audit rejects", async () => {
    const store: string[] = [];
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FIXTURE);
    const failingAudit = new FailingAuditLog();
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    const deps = { classifier, auditLog: failingAudit, queue };
    const wrapped = first(wrapToolsWithApproval([makeMockTrivialReadTool(store)], deps));

    // Must not throw even though audit always rejects.
    const result = await wrapped.execute("call-8", {});
    expect(result.content[0]?.type).toBe("text");
    expect(store).toEqual(["read:call-8"]);
  });

  it("approved gated tool still returns result when audit rejects", async () => {
    const store: string[] = [];
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FIXTURE);
    const failingAudit = new FailingAuditLog();
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    const deps = { classifier, auditLog: failingAudit, queue };
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    const result = await wrapped.execute("call-8b", { message: "test" });
    expect(store).toEqual(["post:call-8b"]);
    expect(result.content[0]?.text).toContain("Posted");
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Underlying tool throws → gate wraps the error (AQ-13)
// ---------------------------------------------------------------------------

describe("Scenario 9 — tool execute throws → gate wraps error", () => {
  it("returns an error result without throwing", async () => {
    const throwingTool: WrappableTool = {
      name: "mock_trivial_read",
      label: "Throwing",
      description: "Throws always",
      parameters: {},
      async execute() {
        throw new Error("boom");
      },
    };

    const deps = makeDeps();
    const wrapped = first(wrapToolsWithApproval([throwingTool], deps));

    const result = await wrapped.execute("call-9", {});
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toMatch(/boom/);
  });

  it("audits with decision=error and error field set", async () => {
    const throwingTool: WrappableTool = {
      name: "mock_trivial_read",
      label: "Throwing",
      description: "Throws always",
      parameters: {},
      async execute() {
        throw new Error("boom");
      },
    };

    const deps = makeDeps();
    const wrapped = first(wrapToolsWithApproval([throwingTool], deps));

    await wrapped.execute("call-9", {});
    const rec = deps.auditLog.records[0]!;
    expect(rec.decision).toBe("error");
    expect(rec.error).toBe("boom");
  });

  it("does not produce an unhandled rejection", async () => {
    const throwingTool: WrappableTool = {
      name: "mock_trivial_read",
      label: "Throwing",
      description: "Throws always",
      parameters: {},
      async execute() {
        throw new Error("boom");
      },
    };

    const deps = makeDeps();
    const wrapped = first(wrapToolsWithApproval([throwingTool], deps));
    await expect(wrapped.execute("call-9b", {})).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — Resolver is swappable (AQ-7)
// ---------------------------------------------------------------------------

describe("Scenario 10 — resolver is swappable without touching gate", () => {
  it("AlwaysApproveResolver causes tool body to run", async () => {
    const store: string[] = [];
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FIXTURE);
    const auditLog = new MemoryAuditLog();
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    const deps = { classifier, auditLog, queue };
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    const result = await wrapped.execute("call-10a", {});
    expect(store).toHaveLength(1);
    expect(result.content[0]?.text).toContain("Posted");
  });

  it("AlwaysRejectResolver causes tool body to NOT run", async () => {
    const store: string[] = [];
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FIXTURE);
    const auditLog = new MemoryAuditLog();
    const queue = new ApprovalQueue(AlwaysRejectResolver, new ApprovalSerializer());
    const deps = { classifier, auditLog, queue };
    const wrapped = first(wrapToolsWithApproval([makeMockExternalPostTool(store)], deps));

    const result = await wrapped.execute("call-10b", {});
    expect(store).toHaveLength(0);
    expect(result.content[0]?.text).toMatch(/reject/i);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11 — AuditLog backend is swappable (AQ-11)
// ---------------------------------------------------------------------------

describe("Scenario 11 — AuditLog is swappable", () => {
  it("in-memory AuditLog stub collects records; no file I/O", async () => {
    const store: string[] = [];
    const deps = makeDeps();
    const wrapped = first(wrapToolsWithApproval([makeMockTrivialReadTool(store)], deps));

    await wrapped.execute("call-11", { query: "test" });

    expect(deps.auditLog.records).toHaveLength(1);
    const rec = deps.auditLog.records[0]!;
    expect(rec.toolCallId).toBe("call-11");
    expect(rec.decision).toBe("auto");
    // No JSONL file was written.
    expect(deps.auditLog.records[0]).not.toHaveProperty("filePath");
  });
});

// ---------------------------------------------------------------------------
// Scenario 12 — Three-call audit completeness (AQ-9)
// ---------------------------------------------------------------------------

describe("Scenario 12 — three-call audit completeness", () => {
  it("produces exactly three records with correct fields", async () => {
    const storeRead: string[] = [];
    const storePost: string[] = [];
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FIXTURE);
    const auditLog = new MemoryAuditLog();
    // Three calls: trivial, medio-approved (use alto tool + approve), alto-rejected.
    const queueApprove = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    const depsApprove = { classifier, auditLog, queue: queueApprove };
    const _wrapped12a = wrapToolsWithApproval(
      [makeMockTrivialReadTool(storeRead), makeMockExternalPostTool(storePost)],
      depsApprove,
    );
    const wrappedTrivial = first(_wrapped12a);
    const wrappedApproved = second(_wrapped12a);

    // Call 1: trivial.
    await wrappedTrivial.execute("c12-trivial", { query: "q" });

    // Call 2: alto approved.
    await wrappedApproved.execute("c12-approved", { message: "m" });

    // Call 3: alto rejected — need a new queue with reject resolver.
    const queueReject = new ApprovalQueue(AlwaysRejectResolver, new ApprovalSerializer());
    const depsReject = { classifier, auditLog, queue: queueReject };
    const wrappedRejected = second(wrapToolsWithApproval(
      [makeMockTrivialReadTool(storePost), makeMockExternalPostTool(storePost)],
      depsReject,
    ));
    await wrappedRejected.execute("c12-rejected", { message: "m" });

    expect(auditLog.records).toHaveLength(3);

    const trivialRec = auditLog.records.find((r) => r.toolCallId === "c12-trivial")!;
    expect(trivialRec.decision).toBe("auto");
    expect(trivialRec.approver).toBeNull();

    const approvedRec = auditLog.records.find((r) => r.toolCallId === "c12-approved")!;
    expect(approvedRec.decision).toBe("approved");
    expect(approvedRec.approver).toBe("test-admin");
    expect(approvedRec.output).not.toBeNull();

    const rejectedRec = auditLog.records.find((r) => r.toolCallId === "c12-rejected")!;
    expect(rejectedRec.decision).toBe("rejected");
    expect(rejectedRec.output).toBeNull();
  });
});
