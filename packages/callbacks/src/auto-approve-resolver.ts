/**
 * auto-approve-resolver.ts — AutoApproveResolver for unattended/e2e runs.
 *
 * THIS RESOLVER APPROVES EVERY medio/alto TOOL CALL WITHOUT A HUMAN. It exists
 * for ONE purpose: driving automated end-to-end tests (and explicitly opted-in
 * unattended scenarios) where there is no UI to bind a TuiApprovalResolver to.
 *
 * It is NEVER the default. zia's safe default for a no-human run (cron/webhook
 * print mode) is fail-closed: leave the queue's resolver unbound (null) and the
 * gate denies medio/alto automatically, auditing as "system:fail-closed". That
 * preserves the copilot guarantee — external actions never auto-execute without
 * a human.
 *
 * Binding this resolver is an OBVIOUS, explicit act (e.g. an e2e harness or a
 * print run gated behind an env flag). The approver string is self-describing
 * ("system:auto-approve") so the audit log makes the unattended approval
 * unmistakable.
 */

import type { ApprovalRequest, ApprovalResolver, Decision } from "./queue.js";

/**
 * Resolver that approves every request. The approver identity is recorded in the
 * audit log so an auto-approved action is never mistaken for a human decision.
 *
 * @example
 * // e2e test / explicit unattended run:
 * queue.setResolver(new AutoApproveResolver());
 */
export class AutoApproveResolver implements ApprovalResolver {
  /** Self-describing approver identity recorded in every audit entry. */
  static readonly APPROVER = "system:auto-approve";

  resolve(_req: ApprovalRequest): Promise<Decision> {
    return Promise.resolve({
      approved: true,
      approver: AutoApproveResolver.APPROVER,
    });
  }
}
