/**
 * budget-extension.ts — pi.dev ExtensionFactory that enforces per-agent
 * monthly spend budgets (F-CORE-8, SPEC-BUDGET-1..6).
 *
 * Design invariants:
 *  - @zia/core MUST NOT import @zia/persistence (INV-1). MonthlySpendStore is
 *    declared here as a structural interface (mirroring MessageSink in
 *    message-persist-extension.ts). SqliteMonthlySpendStore from @zia/persistence
 *    satisfies it structurally at the composition root.
 *  - Delivered as an ExtensionFactory (same seam as messagePersistExtension).
 *  - budgetUsd <= 0 → returns null; caller must not inject the extension.
 *  - Fail-open on DB read errors: getSpend() returns 0 on error per its own
 *    contract — no additional try/catch needed here.
 *
 * Event handlers registered:
 *  - message_end: accumulate cost.total for assistant messages.
 *  - input:       warn once at ≥80% spend; hard-stop (return {action:"handled"})
 *                 at ≥100% spend.
 *  - tool_call:   secondary gate — block mid-turn when spend crosses ≥100%.
 *
 * Input gate contract (verified against pi.dev dist):
 *   Returning { action: "handled" } from an `input` handler causes prompt()
 *   to return immediately before agent_start — zero LLM provider spend.
 *
 * Tool-call secondary gate contract (verified against pi.dev dist):
 *   Returning { block: true, reason: string } from a `tool_call` handler
 *   prevents the tool from executing.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Public structural interface — owned by @zia/core
// ---------------------------------------------------------------------------

/**
 * Minimal interface for monthly spend tracking.
 *
 * SqliteMonthlySpendStore (from @zia/persistence) satisfies this structurally
 * so @zia/core never imports @zia/persistence (INV-1). Any object that
 * implements these three methods qualifies.
 *
 * getSpend MUST be fail-open: returns 0 on DB error (never throws).
 * accumulate MAY throw on write error (write failures are surfaced).
 */
export interface MonthlySpendStore {
  accumulate(agentId: string, delta: number, yearMonth?: string): void;
  getSpend(agentId: string, yearMonth?: string): number;
  getSpendOrThrow(agentId: string, yearMonth?: string): number;
}

// ---------------------------------------------------------------------------
// Public factory options
// ---------------------------------------------------------------------------

export interface BudgetEnforcementExtensionOpts {
  store: MonthlySpendStore;
  agentId: string;
  budgetUsd: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const WARN_RATIO = 0.8;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a pi.dev ExtensionFactory that enforces a monthly budget for agentId.
 *
 * Returns null when budgetUsd <= 0 — caller MUST check and skip injection
 * (SPEC-BUDGET-5, EC-10). A zero or negative budget is treated as "no budget".
 *
 * Usage (composition root — agent.ts):
 *   const factory = createBudgetEnforcementExtension({ store, agentId, budgetUsd });
 *   if (factory) extensionFactories.push(factory);
 */
export function createBudgetEnforcementExtension(
  opts: BudgetEnforcementExtensionOpts,
): ExtensionFactory | null {
  const { store, agentId, budgetUsd } = opts;

  // EC-10 / SPEC-BUDGET-5 guard: budget must be > 0 to be meaningful.
  if (budgetUsd <= 0) {
    return null;
  }

  return (pi: ExtensionAPI): void => {
    // Per-session state
    let warnSent = false;

    // -----------------------------------------------------------------------
    // message_end: accumulate LLM cost for assistant messages
    // SPEC-BUDGET-1: skip non-assistant; skip cost <= 0 (free/local model)
    // -----------------------------------------------------------------------
    pi.on("message_end", (ev) => {
      const msg = ev.message as {
        role?: string;
        usage?: { cost?: { total?: number } };
      };

      if (msg.role !== "assistant") return;

      const costTotal = msg.usage?.cost?.total;
      if (costTotal === undefined || costTotal === null || costTotal <= 0) return;

      // Synchronous accumulation (better-sqlite3) — completes before any
      // subsequent input gate can fire (SPEC-BUDGET-1).
      store.accumulate(agentId, costTotal);
    });

    // -----------------------------------------------------------------------
    // input: warn at ≥80%; hard-stop at ≥100%
    // SPEC-BUDGET-2, SPEC-BUDGET-3
    // -----------------------------------------------------------------------
    pi.on("input", (_ev, ctx) => {
      const currentYm = new Date().toISOString().slice(0, 7);
      const spend = store.getSpend(agentId, currentYm); // fail-open → 0 on error
      const ratio = spend / budgetUsd;

      // Hard stop at ≥100% (SPEC-BUDGET-3)
      if (ratio >= 1.0) {
        pi.sendMessage({
          customType: "zia:budget-exhausted",
          content:
            `Monthly budget exhausted. Accumulated: $${spend.toFixed(2)} / $${budgetUsd.toFixed(2)} ` +
            `(${(ratio * 100).toFixed(1)}%) for ${currentYm}. ` +
            `The agent will not process new prompts until the budget resets.`,
          display: true,
          details: { agentId, spend, budgetUsd, yearMonth: currentYm },
        });
        ctx.ui.notify(
          `Budget exhausted: $${spend.toFixed(2)} / $${budgetUsd.toFixed(2)} for ${currentYm}`,
          "error",
        );
        return { action: "handled" } as const;
      }

      // Warn once at ≥80% (SPEC-BUDGET-2)
      if (ratio >= WARN_RATIO && !warnSent) {
        warnSent = true;
        pi.sendMessage({
          customType: "zia:budget-warning",
          content:
            `Budget warning: $${spend.toFixed(2)} / $${budgetUsd.toFixed(2)} ` +
            `(${(ratio * 100).toFixed(1)}%) for ${currentYm}. ` +
            `The agent will stop at 100%.`,
          display: true,
          details: { agentId, spend, budgetUsd, yearMonth: currentYm },
        });
        ctx.ui.notify(
          `Budget at ${(ratio * 100).toFixed(1)}%: $${spend.toFixed(2)} / $${budgetUsd.toFixed(2)}`,
          "warning",
        );
      }

      // Allow turn to proceed
      return undefined;
    });

    // -----------------------------------------------------------------------
    // tool_call: secondary gate — block if budget crossed mid-turn
    // SPEC-BUDGET-3-B: a turn may have started before budget crossed 100%;
    // if accumulation during the turn crosses 100%, block further tools.
    // -----------------------------------------------------------------------
    pi.on("tool_call", (_ev) => {
      const currentYm = new Date().toISOString().slice(0, 7);
      const spend = store.getSpend(agentId, currentYm);
      const ratio = spend / budgetUsd;

      if (ratio >= 1.0) {
        return { block: true, reason: "monthly budget exceeded" };
      }

      return undefined;
    });
  };
}
