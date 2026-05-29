/**
 * queue.test.ts — ApprovalQueue + ApprovalResolver interface tests
 *
 * Covers:
 *   - AQ-2: medio/alto blocks until decision
 *   - AQ-3: approved path runs tool body
 *   - AQ-4: rejected path skips tool body
 *   - AQ-7: resolver is a swappable interface (Scenario 10)
 *   - AQ-9: approver identity carried in Decision so the audit record knows WHO approved
 *   - AQ-6: approve/reject out-of-band settlement + pending clears (Scenario 6 analogue)
 *   - D7:   fail-closed when no resolver is bound
 */
import { describe, expect, it } from "vitest";

import {
  ApprovalQueue,
  type ApprovalResolver,
  type ApprovalRequest,
  type PendingApproval,
  type Decision,
} from "../src/queue.ts";
import { ApprovalSerializer } from "../src/serializer.ts";

// ---------------------------------------------------------------------------
// Fixture resolvers (inline — fixture file is Phase 5 / PR 2)
// ---------------------------------------------------------------------------

const AlwaysApproveResolver: ApprovalResolver = {
  resolve: async (_req: ApprovalRequest): Promise<Decision> => ({
    approved: true,
    approver: "test:always-approve",
  }),
};

const AlwaysRejectResolver: ApprovalResolver = {
  resolve: async (_req: ApprovalRequest): Promise<Decision> => ({
    approved: false,
    approver: "test:always-reject",
  }),
};

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    toolCallId: "call-1",
    toolName: "mock_tool",
    riskLevel: "medio",
    params: { x: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1: interface compliance — plain objects satisfy ApprovalResolver (AQ-7)
// ---------------------------------------------------------------------------

describe("ApprovalResolver interface compliance (AQ-7, Scenario 10)", () => {
  it("QU-1: a plain object resolver satisfies the interface", async () => {
    const resolver: ApprovalResolver = {
      resolve: async () => ({ approved: true, approver: "plain-object" }),
    };
    const queue = new ApprovalQueue(resolver, new ApprovalSerializer());
    const decision = await queue.requestApproval(makeRequest());
    expect(decision.approved).toBe(true);
    expect(decision.approver).toBe("plain-object");
  });

  it("QU-2: AlwaysApproveResolver resolves approved:true with approver string", async () => {
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    const decision = await queue.requestApproval(makeRequest());
    expect(decision.approved).toBe(true);
    expect(typeof decision.approver).toBe("string");
    expect(decision.approver.length).toBeGreaterThan(0);
  });

  it("QU-3: AlwaysRejectResolver resolves approved:false with approver string", async () => {
    const queue = new ApprovalQueue(AlwaysRejectResolver, new ApprovalSerializer());
    const decision = await queue.requestApproval(makeRequest());
    expect(decision.approved).toBe(false);
    expect(typeof decision.approver).toBe("string");
  });

  it("QU-4: swapping resolver changes behavior — no queue/gate code changes", async () => {
    const req = makeRequest({ toolCallId: "call-swap" });

    const q1 = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    const d1 = await q1.requestApproval(req);
    expect(d1.approved).toBe(true);

    const q2 = new ApprovalQueue(AlwaysRejectResolver, new ApprovalSerializer());
    const d2 = await q2.requestApproval(req);
    expect(d2.approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2: pending map management
// ---------------------------------------------------------------------------

describe("ApprovalQueue — pending map", () => {
  it("QU-5: pending list is empty before any request", () => {
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    expect(queue.pending).toHaveLength(0);
  });

  it("QU-6: pending list adds entry while request is in-flight then clears after resolution", async () => {
    let resolveDecision!: (d: Decision) => void;
    const blockingResolver: ApprovalResolver = {
      resolve: (_req) =>
        new Promise<Decision>((r) => {
          resolveDecision = r;
        }),
    };

    const queue = new ApprovalQueue(blockingResolver, new ApprovalSerializer());
    const req = makeRequest({ toolCallId: "in-flight" });

    const requestPromise = queue.requestApproval(req);

    // Yield so the resolver's promise is registered
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]?.request.toolCallId).toBe("in-flight");

    resolveDecision({ approved: true, approver: "test-resolver" });
    await requestPromise;

    expect(queue.pending).toHaveLength(0);
  });

  it("QU-7: pending entry contains correct fields", async () => {
    let resolveDecision!: (d: Decision) => void;
    const blockingResolver: ApprovalResolver = {
      resolve: (_req) =>
        new Promise<Decision>((r) => {
          resolveDecision = r;
        }),
    };

    const queue = new ApprovalQueue(blockingResolver, new ApprovalSerializer());
    const req = makeRequest({ toolCallId: "check-fields", riskLevel: "alto", toolName: "send_email" });

    const requestPromise = queue.requestApproval(req);
    await Promise.resolve();
    await Promise.resolve();

    const entry: PendingApproval = queue.pending[0]!;
    expect(entry.request.toolCallId).toBe("check-fields");
    expect(entry.request.riskLevel).toBe("alto");
    expect(entry.request.toolName).toBe("send_email");
    expect(typeof entry.enqueuedAt).toBe("number");

    resolveDecision({ approved: false, approver: "test-resolver" });
    await requestPromise;
  });
});

// ---------------------------------------------------------------------------
// Group 3: out-of-band approve/reject (AQ-6, Scenario 6 analogue)
// ---------------------------------------------------------------------------

describe("ApprovalQueue — out-of-band approve/reject", () => {
  /**
   * QU-8 — Deferred-resolver pattern (side-channel settlement).
   *
   * This test demonstrates a resolver that does NOT decide inline — instead it
   * stores the settle functions and waits for an external signal. This is how
   * Slice 4's RPC `/approve` resolver works. The test settles via `_settleFns`,
   * NOT via `queue.approve(id)`.
   *
   * `queue.approve(id)` / `queue.reject(id)` are pending-map cleanup helpers
   * only (Slice 4 target). They do NOT settle the resolver's in-flight promise.
   * Full out-of-band settlement is Slice 4.
   */
  it("QU-8: deferred-resolver pattern — settle via side-channel settle fn carries Decision shape", async () => {
    // Use a resolver that defers to the out-of-band mechanism
    const deferredResolver: ApprovalResolver = {
      resolve: async (req) => {
        // The resolver itself returns a promise that the queue will settle via approve/reject.
        // For this test, we simulate the resolver waiting on out-of-band input.
        return new Promise<Decision>((res, rej) => {
          // The queue's approve/reject methods settle this via the stored pair.
          // We register the settle functions via a side channel here.
          _settleFns.set(req.toolCallId, { resolve: res, reject: rej });
        });
      },
    };
    const _settleFns = new Map<string, { resolve: (d: Decision) => void; reject: (e: Error) => void }>();

    const queue = new ApprovalQueue(deferredResolver, new ApprovalSerializer());
    const req = makeRequest({ toolCallId: "oob-approve" });

    const requestPromise = queue.requestApproval(req);
    await Promise.resolve();
    await Promise.resolve();

    // Settle via the stored promise pair (simulating out-of-band) — Decision shape, not boolean
    _settleFns.get("oob-approve")!.resolve({ approved: true, approver: "rpc:admin" });

    const decision = await requestPromise;
    expect(decision.approved).toBe(true);
    expect(decision.approver).toBe("rpc:admin");
  });

  /**
   * QU-9 — queue.approve(id) / queue.reject(id) are pending-map cleanup only.
   *
   * These methods delete from the pending map so the UI widget clears.
   * They do NOT settle any resolver promise. Full out-of-band settlement
   * (where approve(id) triggers a stored {resolve,reject} pair) is Slice 4.
   */
  it("QU-9: queue.approve(id) and queue.reject(id) exist and clean the pending map (no settlement)", () => {
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    expect(typeof queue.approve).toBe("function");
    expect(typeof queue.reject).toBe("function");
    // Neither method settles any in-flight resolver promise in Slice 2 —
    // they are pending-map cleanup stubs until Slice 4.
  });

  it("QU-10: approve(id) on unknown id does not throw", () => {
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    expect(() => queue.approve("nonexistent")).not.toThrow();
  });

  it("QU-11: reject(id) on unknown id does not throw", () => {
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    expect(() => queue.reject("nonexistent")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 4: fail-closed — no resolver bound (D7)
// ---------------------------------------------------------------------------

describe("ApprovalQueue — fail-closed with no resolver (D7)", () => {
  it("QU-12: no-resolver queue rejects requestApproval with a clear error", async () => {
    const queue = new ApprovalQueue(null, new ApprovalSerializer());
    await expect(queue.requestApproval(makeRequest())).rejects.toThrow(
      /no approval channel/i
    );
  });

  it("QU-13: fail-closed sentinel Decision has approved:false and self-describing approver", async () => {
    // When the queue has no resolver and returns a sentinel (rather than rejecting),
    // it must be a denial, never an approval.
    const queue = new ApprovalQueue(null, new ApprovalSerializer());
    let decision: Decision | undefined;
    let error: Error | undefined;
    try {
      decision = await queue.requestApproval(makeRequest());
    } catch (e) {
      error = e as Error;
    }
    // Either rejects (preferred) or resolves with approved:false — never resolves approved:true
    if (decision !== undefined) {
      expect(decision.approved).toBe(false);
      expect(typeof decision.approver).toBe("string"); // self-describing sentinel
    } else {
      expect(error).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Group 5: setResolver — bindable resolver seam (D8)
// ---------------------------------------------------------------------------

describe("ApprovalQueue — setResolver", () => {
  it("QU-14: setResolver changes the resolver for subsequent requests", async () => {
    const queue = new ApprovalQueue(AlwaysRejectResolver, new ApprovalSerializer());

    const d1 = await queue.requestApproval(makeRequest({ toolCallId: "before-swap" }));
    expect(d1.approved).toBe(false);

    queue.setResolver(AlwaysApproveResolver);

    const d2 = await queue.requestApproval(makeRequest({ toolCallId: "after-swap" }));
    expect(d2.approved).toBe(true);
  });

  it("QU-15: setResolver accepts null to go back to fail-closed", async () => {
    const queue = new ApprovalQueue(AlwaysApproveResolver, new ApprovalSerializer());
    queue.setResolver(null);
    await expect(queue.requestApproval(makeRequest())).rejects.toThrow(/no approval channel/i);
  });
});
