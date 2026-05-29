/**
 * null-adapter.ts — In-memory adapter for integration tests (@internal).
 *
 * @internal
 *
 * SPEC-R7: NullAdapter MUST NOT be re-exported from packages/gateways/src/index.ts.
 * Import it directly from this path in tests:
 *   import { NullAdapter } from "@zia/gateways/src/adapters/null-adapter.ts"
 *   // or in test files:
 *   import { NullAdapter } from "../src/adapters/null-adapter.ts"
 *
 * SPEC-R2: This file MUST NOT import @zia/core or the pi.dev SDK.
 */
import { BaseAdapter } from "../base-adapter.ts";
import type { ApprovalView, MessageEvent } from "../types.ts";

/**
 * NullAdapter — in-memory adapter used as a test seam.
 *
 * - _start/_stop are no-ops.
 * - simulateInbound(event) calls this.emit(event), driving the runner.
 * - sendMessage() appends to .sent for assertions.
 * - sendApprovalRequest() appends to .approvalRequests for assertions.
 *
 * @internal
 */
export class NullAdapter extends BaseAdapter {
  readonly platform = "null";

  /** All messages sent via sendMessage() — assert in tests. */
  readonly sent: Array<{ chatId: string; text: string }> = [];

  /** All approval views surfaced via sendApprovalRequest() — assert in tests. */
  readonly approvalRequests: ApprovalView[] = [];

  protected override _start(): Promise<void> {
    return Promise.resolve();
  }

  protected override _stop(): Promise<void> {
    return Promise.resolve();
  }

  override sendMessage(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
    return Promise.resolve();
  }

  override sendApprovalRequest(view: ApprovalView): Promise<void> {
    this.approvalRequests.push(view);
    return Promise.resolve();
  }

  /**
   * Simulate an inbound message — calls this.emit(event) directly.
   * Used by tests to drive the runner without a real transport.
   * The adapter must be registered with a runner (_attach called) before
   * calling this, or emit() will throw.
   */
  simulateInbound(event: MessageEvent): void {
    this.emit(event);
  }
}
