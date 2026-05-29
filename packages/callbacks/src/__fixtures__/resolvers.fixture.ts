/**
 * resolvers.fixture.ts — Test-only ApprovalResolver implementations.
 *
 * These are NOT production resolvers. They exist to drive approval-gate
 * tests without requiring the TUI or any I/O.
 *
 * Exported resolvers:
 *   - AlwaysApproveResolver: immediately approves with approver "test-admin"
 *   - AlwaysRejectResolver:  immediately rejects with approver "test-admin"
 *   - RecordingResolver:     records each resolve() call in arrival order;
 *                            caller controls settlement via the returned handle
 */

import type { ApprovalRequest, ApprovalResolver, Decision } from "../queue.js";

// ---------------------------------------------------------------------------
// AlwaysApproveResolver
// ---------------------------------------------------------------------------

export const AlwaysApproveResolver: ApprovalResolver = {
  resolve(_req: ApprovalRequest): Promise<Decision> {
    return Promise.resolve({ approved: true, approver: "test-admin" });
  },
};

// ---------------------------------------------------------------------------
// AlwaysRejectResolver
// ---------------------------------------------------------------------------

export const AlwaysRejectResolver: ApprovalResolver = {
  resolve(_req: ApprovalRequest): Promise<Decision> {
    return Promise.resolve({ approved: false, approver: "test-admin" });
  },
};

// ---------------------------------------------------------------------------
// RecordingResolver
// ---------------------------------------------------------------------------

/**
 * A handle for a single pending resolve() call captured by RecordingResolver.
 */
export interface RecordingHandle {
  request: ApprovalRequest;
  /** Settle the pending call with an approval. */
  approve(): void;
  /** Settle the pending call with a rejection. */
  reject(): void;
}

/**
 * A resolver that captures each resolve() call in arrival order.
 *
 * Each call suspends until the caller settles it via the returned handle.
 * Use this to test serialization (Scenario 6), blocking (Scenario 2), and
 * unlisted-tool alt-classification (Scenario 5).
 *
 * Usage:
 *   const recorder = new RecordingResolver();
 *   // ... wrap tools, trigger calls ...
 *   const handle = await recorder.next(); // waits for one call to arrive
 *   handle.approve();
 */
export class RecordingResolver implements ApprovalResolver {
  /** Ordered list of all requests received, regardless of settlement state. */
  readonly calls: ApprovalRequest[] = [];

  private readonly pending: Array<{
    request: ApprovalRequest;
    resolve: (d: Decision) => void;
  }> = [];

  private readonly waiting: Array<(handle: RecordingHandle) => void> = [];

  resolve(req: ApprovalRequest): Promise<Decision> {
    this.calls.push(req);
    return new Promise<Decision>((settleFn) => {
      const handle: RecordingHandle = {
        request: req,
        approve: () => settleFn({ approved: true, approver: "test-admin" }),
        reject: () => settleFn({ approved: false, approver: "test-admin" }),
      };
      // Notify any waiter that a call arrived.
      const waiter = this.waiting.shift();
      if (waiter) {
        waiter(handle);
      } else {
        this.pending.push({ request: req, resolve: (d) => settleFn(d) });
      }
    });
  }

  /**
   * Wait for the next call to arrive at this resolver.
   * Returns a handle that lets you approve or reject it.
   */
  next(): Promise<RecordingHandle> {
    return new Promise<RecordingHandle>((resolve) => {
      // If a call is already pending, grab it immediately.
      if (this.pending.length > 0) {
        const item = this.pending.shift()!;
        const handle: RecordingHandle = {
          request: item.request,
          approve: () => item.resolve({ approved: true, approver: "test-admin" }),
          reject: () => item.resolve({ approved: false, approver: "test-admin" }),
        };
        resolve(handle);
      } else {
        this.waiting.push(resolve);
      }
    });
  }
}
