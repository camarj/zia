import { InteractiveMode, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { TuiApprovalResolver } from "@zia/callbacks";

import { createZiaAgent, type CreateZiaAgentOptions } from "./agent.ts";
import { type MonthlySpendStore } from "./budget-extension.ts";
import { ziaHeaderExtension } from "./tui-header-extension.ts";

/**
 * Options for runZiaAgentTui.
 *
 * Extends CreateZiaAgentOptions with a `monthlySpendStore` forwarding field
 * (3-hop path: tui.ts → tui-runner.ts → agent.ts, per design correction INV-1).
 * This field is optional — omit it to run without budget enforcement.
 */
export interface RunZiaAgentTuiOptions extends CreateZiaAgentOptions {
  monthlySpendStore?: MonthlySpendStore;
}

/**
 * Run a zia agent in interactive TUI mode.
 *
 * The TUI is the approval channel for this run: medio/alto tool calls are
 * surfaced to the human admin via a confirm dialog and only execute once
 * approved. `createZiaAgent` leaves the queue's resolver unbound (fail-closed,
 * D7/D8) so the channel-agnostic core never assumes a UI. The TUI entry point
 * binds the resolver here.
 *
 * `ctx.ui` only exists inside a tool execute call (after InteractiveMode has
 * started), so the resolver is constructed as a shell and bound to `ctx.ui` on
 * the first gated tool call via the `onGatedCtx` hook. Until bound, the resolver
 * is fail-closed (denies + logs), never silently auto-approves.
 */
export async function runZiaAgentTui(opts: RunZiaAgentTuiOptions): Promise<void> {
  // Assigned after createZiaAgent returns (it owns the queue). The onGatedCtx
  // closure below only fires at gated-tool-call time — long after this is set.
  let resolver: TuiApprovalResolver | undefined;

  const { runtime, queue } = await createZiaAgent({
    ...opts,
    // Brand the TUI with zia's header (replaces pi.dev's built-in banner).
    // Merged ahead of any caller-supplied factories so the zia banner wins.
    extensionFactories: [ziaHeaderExtension, ...(opts.extensionFactories ?? [])],
    onGatedCtx: (rest: readonly unknown[]) => {
      const ctx = rest[2] as { ui?: ExtensionUIContext } | undefined;
      if (ctx?.ui && resolver) {
        resolver.bindUi(ctx.ui);
      }
      // Preserve any caller-supplied hook.
      opts.onGatedCtx?.(rest);
    },
    // T-4a.5: forward monthlySpendStore into createZiaAgent (3-hop path).
    monthlySpendStore: opts.monthlySpendStore,
  });

  resolver = new TuiApprovalResolver({ queue });
  queue.setResolver(resolver);

  const mode = new InteractiveMode(runtime);
  await mode.run();
}
