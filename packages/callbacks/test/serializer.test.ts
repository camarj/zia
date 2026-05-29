/**
 * serializer.test.ts — ApprovalSerializer concurrency mutex tests (AQ-6, Scenario 6)
 *
 * Verifies: FIFO ordering, failure-isolation (a rejected task doesn't poison
 * the chain), and that the serializer uses a promise-chain (no real timers needed).
 */
import { describe, expect, it, vi } from "vitest";

import { ApprovalSerializer } from "../src/serializer.ts";

// ---------------------------------------------------------------------------
// Group 1: FIFO ordering
// ---------------------------------------------------------------------------

describe("ApprovalSerializer — FIFO ordering", () => {
  it("SER-1: two sequential tasks run in submission order", async () => {
    const serializer = new ApprovalSerializer();
    const order: number[] = [];

    await serializer.runExclusive(async () => {
      order.push(1);
    });
    await serializer.runExclusive(async () => {
      order.push(2);
    });

    expect(order).toEqual([1, 2]);
  });

  it("SER-2: concurrent tasks run strictly one-at-a-time, FIFO", async () => {
    const serializer = new ApprovalSerializer();
    const order: string[] = [];

    // Use controlled promises to prove serialization under concurrency
    let resolveA!: () => void;
    const promiseA = new Promise<void>((r) => {
      resolveA = r;
    });

    const taskA = serializer.runExclusive(async () => {
      order.push("A-start");
      await promiseA;
      order.push("A-end");
    });

    // Schedule B while A is blocked
    const taskB = serializer.runExclusive(async () => {
      order.push("B-start");
      order.push("B-end");
    });

    // Yield to the microtask queue so task A's synchronous start runs,
    // then verify B hasn't started yet (A is still blocking on promiseA).
    await Promise.resolve();
    expect(order).toEqual(["A-start"]);

    resolveA();
    await Promise.all([taskA, taskB]);

    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("SER-3: three concurrent tasks run in submission order", async () => {
    const serializer = new ApprovalSerializer();
    const order: number[] = [];

    const task = (n: number) =>
      serializer.runExclusive(async () => {
        order.push(n);
      });

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Group 2: failure isolation — a rejected task must NOT poison the chain
// ---------------------------------------------------------------------------

describe("ApprovalSerializer — failure isolation", () => {
  it("SER-4: a failing task does not prevent subsequent tasks from running", async () => {
    const serializer = new ApprovalSerializer();
    const order: string[] = [];

    // Task 1: fails
    const task1 = serializer
      .runExclusive(async () => {
        order.push("fail-task");
        throw new Error("deliberate failure");
      })
      .catch(() => {
        /* expected */
      });

    // Task 2: must still run even after task 1 fails
    const task2 = serializer.runExclusive(async () => {
      order.push("after-fail");
    });

    await Promise.all([task1, task2]);
    expect(order).toEqual(["fail-task", "after-fail"]);
  });

  it("SER-5: runExclusive propagates the rejection to the caller", async () => {
    const serializer = new ApprovalSerializer();
    const err = new Error("propagated");

    await expect(
      serializer.runExclusive(async () => {
        throw err;
      })
    ).rejects.toThrow("propagated");
  });

  it("SER-6: two failing tasks — both propagate independently; third task still runs", async () => {
    const serializer = new ApprovalSerializer();
    const order: string[] = [];

    const t1 = serializer
      .runExclusive(async () => {
        order.push("fail-1");
        throw new Error("e1");
      })
      .catch(() => {});
    const t2 = serializer
      .runExclusive(async () => {
        order.push("fail-2");
        throw new Error("e2");
      })
      .catch(() => {});
    const t3 = serializer.runExclusive(async () => {
      order.push("ok-3");
    });

    await Promise.all([t1, t2, t3]);
    expect(order).toEqual(["fail-1", "fail-2", "ok-3"]);
  });
});

// ---------------------------------------------------------------------------
// Group 3: return value passthrough
// ---------------------------------------------------------------------------

describe("ApprovalSerializer — return value passthrough", () => {
  it("SER-7: returns the value produced by fn", async () => {
    const serializer = new ApprovalSerializer();
    const result = await serializer.runExclusive(async () => 42);
    expect(result).toBe(42);
  });

  it("SER-8: returns a complex object", async () => {
    const serializer = new ApprovalSerializer();
    const obj = { approved: true, approver: "tui" };
    const result = await serializer.runExclusive(async () => obj);
    expect(result).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// Group 4: independent instances don't share state
// ---------------------------------------------------------------------------

describe("ApprovalSerializer — instance isolation", () => {
  it("SER-9: two independent serializers don't block each other", async () => {
    const s1 = new ApprovalSerializer();
    const s2 = new ApprovalSerializer();
    const order: string[] = [];

    let resolveS1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolveS1 = r;
    });

    const t1 = s1.runExclusive(async () => {
      order.push("s1-start");
      await blocker;
      order.push("s1-end");
    });

    // s2 is independent — should not be blocked by s1's blocker
    const t2 = s2.runExclusive(async () => {
      order.push("s2");
    });

    await t2; // s2 must complete while s1 is still blocked
    expect(order).toContain("s2");
    expect(order).not.toContain("s1-end");

    resolveS1();
    await t1;
    expect(order).toContain("s1-end");
  });
});

// ---------------------------------------------------------------------------
// Group 5: vi.useFakeTimers compatibility (Scenario 6 analogue)
// ---------------------------------------------------------------------------

describe("ApprovalSerializer — fake timers compatible", () => {
  it("SER-10: works correctly with fake timers active", async () => {
    vi.useFakeTimers();
    const serializer = new ApprovalSerializer();
    const order: number[] = [];

    const p1 = serializer.runExclusive(async () => {
      order.push(1);
    });
    const p2 = serializer.runExclusive(async () => {
      order.push(2);
    });

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
    vi.useRealTimers();
  });
});
