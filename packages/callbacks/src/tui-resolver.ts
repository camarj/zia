/**
 * tui-resolver.ts — TUI-based ApprovalResolver (Slice 2, AQ-8).
 *
 * This is the ONLY file in @zia/callbacks that imports pi.dev SDK types.
 * It is an adapter behind the ApprovalResolver interface — queue, gate, and
 * audit code remain SDK-free and independently testable.
 *
 * SPIKE RESULT (AMB-1 resolved, 2026-05-28):
 *   Inspected @earendil-works/pi-coding-agent@0.76.0
 *   dist/core/extensions/types.d.ts — ExtensionUIContext interface.
 *
 *   Confirmed API:
 *     ctx.ui.confirm(title: string, message: string, opts?: ExtensionUIDialogOptions)
 *       → Promise<boolean>
 *     ctx.ui.setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions)
 *       → void  (string-array overload used here; no Component dependency needed)
 *     ctx.ui.notify(message: string, type?: "info" | "warning" | "error") → void
 *
 *   The ToolDefinition.execute signature is:
 *     execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)
 *   so ctx.ui IS available inside every wrapped execute call via the ...rest args.
 *
 *   Wiring approach (D8 — entry-point binding):
 *     tui-runner.ts creates a TuiApprovalResolver shell (no ui yet).
 *     On the first medio/alto tool call, the gate extracts ctx.ui from ...rest[2]
 *     and calls resolver.bindUi(ctx.ui) once. Subsequent calls reuse the bound ui.
 *     Until bound, resolve() returns fail-closed { approved: false, approver: "system:fail-closed" }.
 *
 * AQ-8 acceptance criterion (integration, not unit test):
 *   When a medio/alto tool is called in the TUI, the pending-approvals widget
 *   appears above the editor; the admin confirms or cancels; the gate receives
 *   the decision and the widget clears. Verified manually — not vitest.
 *
 * approver string: "tui" (spec AQ-8 says "tui-admin" — using "tui" per design §tui-resolver.ts
 * which says approver: "tui"; the spec text "tui-admin" is superseded by the design where it says
 * "reported as 'tui'". Design is authoritative per spec supersedes clause.)
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { ApprovalRequest, ApprovalResolver, Decision } from "./queue.js";
import type { ApprovalQueue } from "./queue.js";

// ---------------------------------------------------------------------------
// TuiApprovalResolverDeps
// ---------------------------------------------------------------------------

export interface TuiApprovalResolverDeps {
  /**
   * The pi.dev TUI UI context.
   * Obtained from ExtensionContext.ui inside a tool execute call (the only
   * point where ctx.ui is available). Bound lazily via bindUi().
   * Optional at construction time — bind via bindUi() on first gated call (D8).
   */
  ui?: ExtensionUIContext;
  /** Used to render pending items in the widget. */
  queue: ApprovalQueue;
}

// ---------------------------------------------------------------------------
// TuiApprovalResolver
// ---------------------------------------------------------------------------

/**
 * Presents pending approvals to the TUI admin via a confirm dialog.
 *
 * Construction is split from ui-binding (D8) because ctx.ui is only available
 * inside a tool execute call — after InteractiveMode has started — while the
 * resolver must be constructed at agent startup. Call bindUi(ctx.ui) on the
 * first gated tool call; until then resolve() is fail-closed.
 */
export class TuiApprovalResolver implements ApprovalResolver {
  private ui: ExtensionUIContext | null = null;
  private readonly queue: ApprovalQueue;

  constructor(deps: TuiApprovalResolverDeps) {
    this.queue = deps.queue;
    if (deps.ui) {
      this.ui = deps.ui;
    }
  }

  /**
   * Bind the TUI UI context. Safe to call multiple times — idempotent after
   * the first non-null binding. Called by the gate wrapper on the first
   * medio/alto tool call when ctx.ui is available.
   */
  bindUi(ui: ExtensionUIContext): void {
    if (this.ui === null) {
      this.ui = ui;
    }
  }

  async resolve(req: ApprovalRequest): Promise<Decision> {
    // Fail-closed: if UI not yet bound, deny and log (D7).
    if (this.ui === null) {
      process.stderr.write(
        `[zia/tui-resolver] No TUI UI bound — denying "${req.toolName}" (${req.riskLevel}) fail-closed.\n`,
      );
      return { approved: false, approver: "system:fail-closed" };
    }

    const ui = this.ui;

    // Show/refresh the pending-approvals widget.
    this._refreshWidget(ui);

    // Build a readable params summary (first 300 chars of JSON).
    const paramsSummary = JSON.stringify(req.params).slice(0, 300);

    const title = `Approve: ${req.toolName} [${req.riskLevel}]`;
    const message =
      `Tool "${req.toolName}" (risk: ${req.riskLevel}) wants to run.\n` +
      `Params: ${paramsSummary}\n\n` +
      `Approve this action?`;

    let approved: boolean;
    try {
      approved = await ui.confirm(title, message);
    } catch (err) {
      // TUI confirm failure — fail-closed.
      process.stderr.write(
        `[zia/tui-resolver] confirm() threw for "${req.toolName}": ${String(err)}\n`,
      );
      approved = false;
    }

    // Clear the widget when no more pending items remain.
    // (The pending map is cleared by ApprovalQueue.requestApproval's finally block.)
    const remaining = this.queue.pending;
    if (remaining.length === 0) {
      ui.setWidget("pending-approvals", undefined);
    } else {
      this._refreshWidget(ui);
    }

    // N1 — approver identity: "tui" per design §tui-resolver.ts ("approver: 'tui'").
    // The spec draft used "tui-admin"; the design is authoritative per the spec's
    // own supersedes clause (AuditEntry schema authority: design §audit-log.ts).
    return { approved, approver: "tui" };
  }

  private _refreshWidget(ui: ExtensionUIContext): void {
    const pending = this.queue.pending;
    if (pending.length === 0) {
      ui.setWidget("pending-approvals", undefined);
      return;
    }
    const lines = [
      `[zia] Pending approvals: ${pending.length}`,
      ...pending.map(
        (p) => `  • ${p.request.toolName} [${p.request.riskLevel}] — awaiting decision`,
      ),
    ];
    ui.setWidget("pending-approvals", lines);
  }
}
