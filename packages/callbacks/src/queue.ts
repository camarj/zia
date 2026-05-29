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

/** true = approved, false = rejected */
export type Decision = boolean;

export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly riskLevel: RiskLevel;
  readonly params: Record<string, unknown>;
}

/**
 * THE RESOLVER SEAM — implement this interface to provide a decision source.
 * A plain object satisfies it (no class required).
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
   * Fail-closed: if no resolver is bound, rejects immediately (D7).
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
   * Out-of-band approve — settles a deferred promise keyed by toolCallId.
   * Used by Slice 4's RPC `/approve` command (Hermes §8 respond pattern).
   * For Slice 2's TUI resolver this is not the primary path (resolver is
   * interactive), but the method must exist for interface completeness.
   * Safe to call with an unknown id (no-op).
   */
  approve(toolCallId: string): void {
    // The out-of-band settle map is populated by resolvers that implement
    // a deferred pattern. For the Slice-2 TUI resolver the resolver itself
    // drives the decision; this method is a no-op until Slice 4.
    this.pendingMap.delete(toolCallId);
  }

  /**
   * Out-of-band reject — symmetric to approve().
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
