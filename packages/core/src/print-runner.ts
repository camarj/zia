import { runPrintMode } from "@earendil-works/pi-coding-agent";
import type { ApprovalResolver } from "@zia/callbacks";

import { createZiaAgent, type CreateZiaAgentOptions } from "./agent.ts";

/**
 * Options for a one-shot print run. Extends the agent options with the prompt
 * to send and the output mode.
 */
export interface RunZiaAgentPrintOptions extends CreateZiaAgentOptions {
  /** The prompt to send to the agent. Required — a print run with no prompt is a no-op. */
  prompt: string;
  /** "text" prints only the final assistant message; "json" streams all events as JSONL. */
  mode?: "text" | "json";
  /** Additional prompts sent after the first (multi-turn one-shot). */
  followUps?: string[];
  /**
   * Optional approval resolver for medio/alto tool calls.
   *
   * DEFAULT (omitted) = fail-closed: the queue stays unbound, so the gate denies
   * every medio/alto call and audits it as "system:fail-closed". This is the
   * safe default for an unattended run (cron/webhook) — external actions never
   * auto-execute without a human (the copilot guarantee).
   *
   * Pass AutoApproveResolver ONLY for e2e tests or an explicitly opted-in
   * unattended scenario where auto-approval is intended.
   */
  approvalResolver?: ApprovalResolver;
}

/**
 * Run a zia agent in non-interactive print (single-shot) mode.
 *
 * Mirrors runZiaAgentTui but drives the runtime with pi.dev's runPrintMode
 * instead of InteractiveMode. There is NO UI, so:
 *  - the zia TUI header extension is not loaded (it self-guards on hasUI anyway);
 *  - ctx.ui is undefined inside tool executions, so a TuiApprovalResolver could
 *    never bind — hence the resolver model here is explicit (see approvalResolver).
 *
 * runPrintMode disposes the runtime in its own finally block, so callers MUST NOT
 * dispose the runtime again. They are still responsible for their own resources
 * (MCP adapter, DB handle) in the composition root.
 *
 * @returns the process exit code from runPrintMode (0 = success, 1 = error/abort).
 */
export async function runZiaAgentPrint(opts: RunZiaAgentPrintOptions): Promise<number> {
  const { prompt, mode, followUps, approvalResolver, ...agentOpts } = opts;

  const { runtime, queue } = await createZiaAgent(agentOpts);

  // Bind the resolver only if one is supplied. Omitted = fail-closed: the queue
  // stays null-bound and the gate denies medio/alto, auditing "system:fail-closed".
  // No onGatedCtx is wired — there is no UI to bind lazily in print mode.
  if (approvalResolver) {
    queue.setResolver(approvalResolver);
  }

  return runPrintMode(runtime, {
    mode: mode ?? "text",
    initialMessage: prompt,
    messages: followUps,
  });
}
