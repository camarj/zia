/**
 * agent-wiring.test.ts — AQ-12: verify the governance gate is wired into the
 * agent composition root.
 *
 * Full pi.dev session creation requires live credentials and network — these
 * tests isolate the wiring logic by extracting and exercising `buildGatedTools`
 * helpers that mirror what createZiaAgent does. This lets us assert the gate
 * contract (trivial runs immediately, gated blocks) without spawning an
 * AgentSession.
 *
 * The structural assertion (no raw tool path to customTools) is verified
 * visually in the PR description (AQ-12 task 8.6) and via the typecheck gate
 * — the customTools cast comment is the documentation of that boundary.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AlwaysApproveResolver,
  AlwaysRejectResolver,
} from "../../callbacks/src/__fixtures__/resolvers.fixture.js";
import {
  makeMockExternalPostTool,
  makeMockTrivialReadTool,
  POLICIES_FIXTURE,
} from "../../callbacks/src/__fixtures__/mock-tools.fixture.js";
import {
  ApprovalQueue,
  ApprovalSerializer,
  PolicyClassifier,
  TuiApprovalResolver,
  type ApprovalResolver,
  type AuditEntry,
  type AuditLog,
  wrapToolsWithApproval,
} from "@zia/callbacks";

// ---------------------------------------------------------------------------
// In-memory audit stub
// ---------------------------------------------------------------------------

class MemAuditLog implements AuditLog {
  readonly records: AuditEntry[] = [];
  record(entry: AuditEntry): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers — mirror createZiaAgent's governance wiring in isolation
// (no pi.dev session, no credentials, no network).
// ---------------------------------------------------------------------------

async function makeFichaDir(policiesMd?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-wiring-"));
  await writeFile(join(dir, "POLICIES.md"), policiesMd ?? POLICIES_FIXTURE, "utf8");
  return dir;
}

/**
 * Build a gated tools array + supporting deps the same way createZiaAgent does.
 * Accepts an optional resolver override so tests can drive the decision path.
 */
async function buildGatedTools(fichaDir: string, resolverOverride?: ApprovalResolver | null) {
  const classifier = await PolicyClassifier.fromFichaDir(fichaDir);
  const serializer = new ApprovalSerializer();
  const queue = new ApprovalQueue(null, serializer);
  const tuiResolver = new TuiApprovalResolver({ queue });
  queue.setResolver(resolverOverride ?? tuiResolver);
  const auditLog = new MemAuditLog();

  const rawTools = [
    makeMockTrivialReadTool([]),
    makeMockExternalPostTool([]),
  ];

  const gated = wrapToolsWithApproval(rawTools, { classifier, queue, auditLog });
  return { gated, queue, tuiResolver, auditLog };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent wiring — gate is always applied (AQ-12)", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  async function makeFixture(policies?: string): Promise<string> {
    const dir = await makeFichaDir(policies);
    createdDirs.push(dir);
    return dir;
  }

  // -------------------------------------------------------------------------
  // AQ-12 structural: trivial tools run without touching the queue
  // -------------------------------------------------------------------------
  it("trivial tool runs immediately and does not enqueue", async () => {
    const fichaDir = await makeFixture();
    const { gated, queue } = await buildGatedTools(fichaDir, AlwaysApproveResolver);

    const trivial = gated[0]!; // mock_trivial_read
    const result = await trivial.execute("wt-1", { query: "ping" });

    expect(result.content[0]?.type).toBe("text");
    expect(queue.pending).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AQ-12 structural: alto tool blocks until decision
  // -------------------------------------------------------------------------
  it("alto tool routes through the approval queue before executing", async () => {
    const fichaDir = await makeFixture();
    const store: string[] = [];

    const classifier = await PolicyClassifier.fromFichaDir(fichaDir);
    const serializer = new ApprovalSerializer();
    const queue = new ApprovalQueue(AlwaysApproveResolver, serializer);
    const auditLog = new MemAuditLog();
    createdDirs.push(fichaDir); // already pushed by makeFixture

    const raw = [makeMockExternalPostTool(store)];
    const gated = wrapToolsWithApproval(raw, { classifier, queue, auditLog });

    await gated[0]!.execute("wt-2", { message: "hello" });

    // Tool body ran (approved) and audit recorded the decision.
    expect(store).toEqual(["post:wt-2"]);
    expect(auditLog.records[0]?.decision).toBe("approved");
  });

  // -------------------------------------------------------------------------
  // AQ-12 structural: alto tool is blocked when rejected
  // -------------------------------------------------------------------------
  it("alto tool body does NOT run when rejected", async () => {
    const fichaDir = await makeFixture();
    const store: string[] = [];

    const classifier = await PolicyClassifier.fromFichaDir(fichaDir);
    const serializer = new ApprovalSerializer();
    const queue = new ApprovalQueue(AlwaysRejectResolver, serializer);
    const auditLog = new MemAuditLog();

    const raw = [makeMockExternalPostTool(store)];
    const gated = wrapToolsWithApproval(raw, { classifier, queue, auditLog });

    const result = await gated[0]!.execute("wt-3", { message: "hello" });

    expect(store).toHaveLength(0); // body never ran
    expect(result.content[0]?.text).toMatch(/reject/i);
    expect(auditLog.records[0]?.decision).toBe("rejected");
  });

  // -------------------------------------------------------------------------
  // AQ-12 structural: fail-closed when no resolver is bound
  // -------------------------------------------------------------------------
  it("alto tool is denied when no resolver is bound (fail-closed, D7)", async () => {
    const fichaDir = await makeFixture();
    const store: string[] = [];

    const classifier = await PolicyClassifier.fromFichaDir(fichaDir);
    const serializer = new ApprovalSerializer();
    // null resolver — intentionally no binding
    const queue = new ApprovalQueue(null, serializer);
    const auditLog = new MemAuditLog();

    const raw = [makeMockExternalPostTool(store)];
    const gated = wrapToolsWithApproval(raw, { classifier, queue, auditLog });

    // The queue throws when no resolver is bound; the gate catches it and
    // returns a clean error ToolResult (total function — AQ-13, D7).
    // Tool body must not run and no unhandled rejection must escape.
    const result = await gated[0]!.execute("wt-4", { message: "hello" });

    expect(store).toHaveLength(0); // body never ran
    // Gate wraps the queue error as a text error result (AQ-13).
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toMatch(/No approval channel/i);
  });

  // -------------------------------------------------------------------------
  // DeferredResolver / TuiApprovalResolver: fail-closed when ui not bound
  // -------------------------------------------------------------------------
  it("TuiApprovalResolver returns fail-closed decision when ui not yet bound", async () => {
    const fichaDir = await makeFixture();
    const queue = new ApprovalQueue(null, new ApprovalSerializer());
    const resolver = new TuiApprovalResolver({ queue });
    queue.setResolver(resolver);

    // resolve() with no ui bound → fail-closed { approved: false }
    const decision = await resolver.resolve({
      toolCallId: "wt-5",
      toolName: "mock_external_post",
      riskLevel: "alto",
      params: {},
    });

    expect(decision.approved).toBe(false);
    expect(decision.approver).toBe("system:fail-closed");
  });

  // -------------------------------------------------------------------------
  // onGatedCtx hook wires ctx.ui lazily (D8 binding path)
  // -------------------------------------------------------------------------
  it("onGatedCtx hook is called for gated tool calls and skipped for trivial", async () => {
    const fichaDir = await makeFixture();
    const classifier = await PolicyClassifier.fromFichaDir(fichaDir);
    const serializer = new ApprovalSerializer();
    const queue = new ApprovalQueue(AlwaysApproveResolver, serializer);
    const auditLog = new MemAuditLog();

    const ctxCallsForGated: unknown[][] = [];
    const raw = [
      makeMockTrivialReadTool([]),
      makeMockExternalPostTool([]),
    ];
    const gated = wrapToolsWithApproval(raw, {
      classifier,
      queue,
      auditLog,
      onGatedCtx: (rest) => ctxCallsForGated.push([...rest]),
    });

    // Trivial: hook must NOT be called.
    await gated[0]!.execute("wt-6t", { query: "read" });
    expect(ctxCallsForGated).toHaveLength(0);

    // Gated: hook MUST be called with the rest args.
    await gated[1]!.execute("wt-6g", { message: "post" }, "signal-stub", "onUpdate-stub", { ui: "ctx-stub" });
    expect(ctxCallsForGated).toHaveLength(1);
    expect(ctxCallsForGated[0]).toEqual(["signal-stub", "onUpdate-stub", { ui: "ctx-stub" }]);
  });
});
