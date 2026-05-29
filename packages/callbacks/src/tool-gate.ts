/**
 * tool-gate.ts — wrapToolsWithApproval HOF.
 *
 * Wraps every tool's `execute` with the approval gate BEFORE pi.dev sees it.
 * This is the single enforcement point (AQ-12, design D1, Hermes §2/§9.1):
 * - trivial: execute immediately, audit as "auto"
 * - medio/alto: await human decision via the serializer + queue, then either
 *   execute (approved) or return a clean rejection result (rejected)
 * - any execute throw: caught, audited as "error", returned as error result
 *
 * The gate is TOTAL (AQ-13) — it never throws to pi.dev's tool dispatch.
 * Audit failures are SWALLOWED (AQ-10) — they log to stderr, never block.
 */

import type { PolicyClassifier } from "./approval.js";
import type { AuditEntry, AuditLog } from "./audit-log.js";
import type { ApprovalQueue } from "./queue.js";
import type { ToolResult, WrappableTool } from "./types.js";

// ---------------------------------------------------------------------------
// ToolGateDeps — injected at wiring time by agent.ts (AQ-12)
// ---------------------------------------------------------------------------

export interface ToolGateDeps {
  /** Classifies tool names by risk level from POLICIES.md */
  classifier: PolicyClassifier;
  /** Queues medio/alto decisions through the resolver.
   *  The queue owns the serializer internally — requestApproval() is already
   *  serialized, so the gate does NOT wrap it again.
   */
  queue: ApprovalQueue;
  /** Audit backend — one record per call outcome (AQ-9, AQ-11) */
  auditLog: AuditLog;
  /**
   * Optional hook called for every medio/alto tool execute before dispatching
   * to the queue. Receives the raw trailing args from the SDK execute signature:
   *   rest[0] = signal (AbortSignal | undefined)
   *   rest[1] = onUpdate (AgentToolUpdateCallback | undefined)
   *   rest[2] = ctx (ExtensionContext)
   *
   * Used by the TUI entry point to bind ctx.ui to TuiApprovalResolver on the
   * first gated call (D8 — lazy UI binding because ctx.ui only exists inside
   * InteractiveMode's tool dispatch). Channel-agnostic: the gate passes the
   * raw args; how the caller uses them is the entry point's concern.
   */
  onGatedCtx?: (rest: readonly unknown[]) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Swallow audit failures so they never block a tool result (AQ-10). */
async function auditSafe(auditLog: AuditLog, entry: AuditEntry): Promise<void> {
  try {
    await auditLog.record(entry);
  } catch (err) {
    process.stderr.write(
      `[zia/tool-gate] audit write failure for "${entry.toolName}": ${String(err)}\n`,
    );
  }
}

/** Build a clean rejection ToolResult (AQ-4, AQ-13). */
function rejectionResult(toolName: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Action "${toolName}" was rejected by the human approver.`,
      },
    ],
    details: { rejected: true },
  };
}

/** Build an error ToolResult when the underlying execute throws (AQ-13). */
function errorResult(toolName: string, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Tool "${toolName}" failed: ${message}` }],
    details: { error: message },
  };
}

// ---------------------------------------------------------------------------
// wrapToolsWithApproval — the HOF
// ---------------------------------------------------------------------------

/**
 * Wrap every tool in `tools` with the approval gate.
 *
 * Returns a new array of the same type `T` with only the `execute` function
 * replaced. All other fields (name, label, description, parameters, and any
 * future additions) are spread verbatim so pi.dev receives a complete tool
 * definition (design R2).
 *
 * The returned tools maintain the same length and order as the input.
 */
export function wrapToolsWithApproval<T extends WrappableTool>(
  tools: readonly T[],
  deps: ToolGateDeps,
): T[] {
  const { classifier, queue, auditLog, onGatedCtx } = deps;

  return tools.map((tool): T => {
    const wrappedExecute = async (
      toolCallId: string,
      params: Record<string, unknown>,
      ...rest: unknown[]
    ): Promise<ToolResult> => {
      const risk = classifier.classify({ toolName: tool.name });

      // -----------------------------------------------------------------------
      // Trivial path — immediate execution, no queue involvement (AQ-1)
      // -----------------------------------------------------------------------
      if (risk === "trivial") {
        try {
          const result = await tool.execute(toolCallId, params, ...rest);
          await auditSafe(auditLog, {
            timestamp: new Date().toISOString(),
            toolCallId,
            toolName: tool.name,
            riskLevel: risk,
            decision: "auto",
            approver: null,
            input: params,
            output: result as unknown as Record<string, unknown>,
            error: null,
          });
          return result;
        } catch (err) {
          const result = errorResult(tool.name, err);
          const message = err instanceof Error ? err.message : String(err);
          await auditSafe(auditLog, {
            timestamp: new Date().toISOString(),
            toolCallId,
            toolName: tool.name,
            riskLevel: risk,
            decision: "error",
            approver: null,
            input: params,
            output: null,
            error: message,
          });
          return result;
        }
      }

      // -----------------------------------------------------------------------
      // Medio / alto path — serialized decision required (AQ-2, AQ-6)
      //
      // queue.requestApproval() already routes through the serializer internally,
      // so we call it directly here — no double-wrap needed.
      //
      // Notify the optional onGatedCtx hook with the raw trailing SDK args so
      // the entry point can extract ctx.ui and lazily bind the TUI resolver (D8).
      // -----------------------------------------------------------------------
      onGatedCtx?.(rest);

      // Wrap requestApproval so a queue failure (e.g. no resolver bound → D7
      // fail-closed error) is treated as a denial rather than an uncaught throw.
      // The gate is a total function (AQ-13): it never propagates to pi.dev.
      let decision: import("./queue.js").Decision;
      try {
        decision = await queue.requestApproval({
          toolCallId,
          toolName: tool.name,
          riskLevel: risk,
          params,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[zia/tool-gate] approval channel error for "${tool.name}": ${message}\n`,
        );
        const result = errorResult(tool.name, err);
        await auditSafe(auditLog, {
          timestamp: new Date().toISOString(),
          toolCallId,
          toolName: tool.name,
          riskLevel: risk,
          decision: "error",
          approver: "system:fail-closed",
          input: params,
          output: null,
          error: message,
        });
        return result;
      }

      if (!decision.approved) {
        // Rejected — do NOT call tool.execute (AQ-4)
        const result = rejectionResult(tool.name);
        await auditSafe(auditLog, {
          timestamp: new Date().toISOString(),
          toolCallId,
          toolName: tool.name,
          riskLevel: risk,
          decision: "rejected",
          approver: decision.approver,
          input: params,
          output: null,
          error: null,
        });
        return result;
      }

      // Approved — execute tool body (AQ-3)
      try {
        const result = await tool.execute(toolCallId, params, ...rest);
        await auditSafe(auditLog, {
          timestamp: new Date().toISOString(),
          toolCallId,
          toolName: tool.name,
          riskLevel: risk,
          decision: "approved",
          approver: decision.approver,
          input: params,
          output: result as unknown as Record<string, unknown>,
          error: null,
        });
        return result;
      } catch (err) {
        // Tool's own failure after approval — audit as error (design D6)
        const message = err instanceof Error ? err.message : String(err);
        const result = errorResult(tool.name, err);
        await auditSafe(auditLog, {
          timestamp: new Date().toISOString(),
          toolCallId,
          toolName: tool.name,
          riskLevel: risk,
          decision: "error",
          approver: decision.approver,
          input: params,
          output: null,
          error: message,
        });
        return result;
      }
    };

    // Spread the original tool, override only execute (design R2 — preserve all fields).
    return { ...tool, execute: wrappedExecute } as T;
  });
}
