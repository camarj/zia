/**
 * queue.ts — ApprovalQueue + ApprovalResolver interface.
 *
 * The resolver interface is the swappable seam (D2, AQ-7):
 *   - Slice 2: TuiApprovalResolver
 *   - Slice 4: RpcApprovalResolver (extension_ui_request)
 * Queue and gate code never change when the resolver is swapped.
 *
 * The queue serializes medio/alto decisions through the injected
 * ApprovalSerializer so only one approval prompt is active at a time (AQ-6).
 *
 * Fail-closed (D7): if no resolver is bound, requestApproval rejects with a
 * clear error rather than auto-approving.
 */

import type { RiskLevel } from "./approval.js";
import type { ApprovalSerializer } from "./serializer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Decision returned by ApprovalResolver.resolve() and propagated through
 * ApprovalQueue.requestApproval().
 *
 * Carrying the approver identity is required so the audit record (AQ-9) can
 * record WHO approved without the gate needing to know which resolver is bound
 * (D2 — resolver stays swappable). The fail-closed sentinel uses a
 * self-describing approver string so PR2's gate can audit the denial cleanly.
 */
export type Decision = {
  /** true = approved, false = rejected */
  approved: boolean;
  /** Identity of the decision-maker (e.g. "tui", "rpc:admin", "system:fail-closed") */
  approver: string;
};

export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly riskLevel: RiskLevel;
  readonly params: Record<string, unknown>;
}

/**
 * THE RESOLVER SEAM — implement this interface to provide a decision source.
 * A plain object satisfies it (no class required).
 *
 * resolve() returns a Decision carrying both the approval outcome AND the
 * approver identity. The identity is required by AQ-9 so the audit record
 * knows WHO decided — the queue and gate are agnostic to which resolver is
 * bound (D2: resolver stays swappable without touching queue/gate code).
 */
export interface ApprovalResolver {
  resolve(req: ApprovalRequest): Promise<Decision>;
}

export interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly enqueuedAt: number;
}

// ---------------------------------------------------------------------------
// ApprovalQueue
// ---------------------------------------------------------------------------

export class ApprovalQueue {
  private resolver: ApprovalResolver | null;
  private readonly serializer: ApprovalSerializer;
  private readonly pendingMap = new Map<string, PendingApproval>();

  constructor(
    resolver: ApprovalResolver | null,
    serializer: ApprovalSerializer,
  ) {
    this.resolver = resolver;
    this.serializer = serializer;
  }

  /** Swap the resolver at runtime (D8 — entry-point binding). */
  setResolver(resolver: ApprovalResolver | null): void {
    this.resolver = resolver;
  }

  /**
   * Request a human decision for a medio/alto tool call.
   *
   * The decision is routed through the serializer so only one prompt is
   * active at a time. The pending map tracks in-flight requests for UI
   * rendering (e.g. ctx.ui widget).
   *
   * Fail-closed (D7): if no resolver is bound, rejects with a clear error.
   * The caller (gate) should catch this and treat it as a denial, auditing
   * with approver "system:fail-closed".
   */
  async requestApproval(req: ApprovalRequest): Promise<Decision> {
    if (this.resolver === null) {
      throw new Error(
        `No approval channel attached — cannot route "${req.toolName}" (${req.riskLevel}). ` +
          `Bind a resolver via queue.setResolver() before tool calls arrive.`,
      );
    }

    const resolver = this.resolver;

    return this.serializer.runExclusive(async () => {
      const entry: PendingApproval = {
        request: req,
        enqueuedAt: Date.now(),
      };
      this.pendingMap.set(req.toolCallId, entry);

      try {
        return await resolver.resolve(req);
      } finally {
        this.pendingMap.delete(req.toolCallId);
      }
    });
  }

  /**
   * Out-of-band approve — pending-map cleanup only.
   *
   * Removes the entry from the pending map so the UI widget clears.
   * Does NOT settle the resolver's in-flight promise. Full out-of-band
   * settlement (where approve(id) triggers a stored {resolve,reject} pair
   * keyed by toolCallId) is Slice 4's RPC resolver concern.
   *
   * Safe to call with an unknown id (no-op).
   */
  approve(toolCallId: string): void {
    this.pendingMap.delete(toolCallId);
  }

  /**
   * Out-of-band reject — pending-map cleanup only.
   *
   * Symmetric to approve(). Does NOT settle the resolver's in-flight promise.
   * Full out-of-band settlement is Slice 4.
   *
   * Safe to call with an unknown id (no-op).
   */
  reject(toolCallId: string): void {
    this.pendingMap.delete(toolCallId);
  }

  /** Live view of in-flight approval requests (for UI widget rendering). */
  get pending(): readonly PendingApproval[] {
    return Array.from(this.pendingMap.values());
  }
}
