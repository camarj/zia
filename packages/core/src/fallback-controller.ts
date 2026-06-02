/**
 * fallback-controller.ts — automatic cross-model fallback (F-LLM-4, model-fallback).
 *
 * This is NOT a pi.dev ExtensionFactory. It is a SESSION SUBSCRIBER attached to
 * `runtime.session` at the composition root inside createZiaAgent. It performs
 * permanent, session-scoped model switching when pi.dev exhausts its own
 * same-model retries (auto_retry_end { success:false }).
 *
 * WHY a session subscriber (not an extension): the trigger event `auto_retry_end`
 * lives ONLY on AgentSessionEvent (agent-session.d.ts), observable via
 * AgentSession.subscribe(). An ExtensionFactory's `pi: ExtensionAPI` has NO
 * `auto_retry_end` overload and no handle to the AgentSession — so it cannot
 * observe retries. See design #720 (corrected mechanism).
 *
 * Mechanism (dist-verified, agent-session.d.ts):
 *  - Trigger: `auto_retry_end { success:false }` only (SPEC-FB-2).
 *  - Walk scopedModels from current successor (no wrap-around) (SPEC-FB-3).
 *  - session.setModel() THROWS on no-auth → try/catch, emit zia:fallback-skip,
 *    continue the walk (SPEC-FB-4).
 *  - On a successful switch, re-submit the captured last user prompt via
 *    session.sendUserMessage() (SPEC-FB-6).
 *  - Exhaustion → exactly ONE zia:fallback-exhausted notice, no loop (SPEC-FB-5).
 *  - lastUserPrompt captured from message_end(role:user) events (SPEC-FB-6).
 *  - Cascade state (triedModelIds, walkActive, selfSubmitting) resets on a
 *    genuine new user turn; selfSubmitting guards against self-reset (SPEC-FB-7).
 *
 * INV-1: no @zia/persistence import. Fallback touches model switching + re-submit
 * only — never spend. Budget accumulation happens independently in the budget
 * extension's own message_end handler.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One model in the fallback walk. Mirrors the structural fields of
 * ResolvedModelEntry from @zia/providers that the controller needs.
 * `credentialEnv` (SPEC-FB-9) is used to name the missing var in skip notices.
 */
export interface FallbackModelEntry {
  model: Model<any>;
  modelId: string;
  credentialEnv?: string;
  label?: string;
}

export interface FallbackControllerOpts {
  /**
   * Structural subset of AgentSession — exactly the methods the controller
   * uses. Keeping it a Pick<> means tests can supply a plain fake without
   * importing the pi.dev SDK.
   */
  session: Pick<
    AgentSession,
    "subscribe" | "setModel" | "sendUserMessage" | "sendCustomMessage" | "model"
  >;
  /** Fallback walk order — ficha order from resolveAvailableModels (SPEC-FB-3). */
  scopedModels: ReadonlyArray<FallbackModelEntry>;
  /** Agent identifier (profile.yaml agent.id, or slug fallback). */
  agentId: string;
}

// ---------------------------------------------------------------------------
// Internal — event shapes (structural; matches dist AgentSessionEvent)
// ---------------------------------------------------------------------------

interface AutoRetryEndEvent {
  type: "auto_retry_end";
  success: boolean;
  attempt: number;
  finalError?: string;
  [k: string]: unknown;
}

interface MessageEvent {
  type: "message_start" | "message_end";
  message: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    timestamp?: number;
  };
  [k: string]: unknown;
}

type ObservedEvent = { type: string; [k: string]: unknown };

function isAutoRetryFail(ev: ObservedEvent): ev is AutoRetryEndEvent {
  return ev.type === "auto_retry_end" && ev.success === false;
}

function isUserMessageEnd(ev: ObservedEvent): ev is MessageEvent {
  const message = ev.message;
  return (
    ev.type === "message_end" &&
    typeof message === "object" &&
    message !== null &&
    (message as { role?: unknown }).role === "user"
  );
}

/**
 * Extract plain text from a UserMessage content (string or TextContent[]).
 * Image blocks are dropped — MVP re-submits text only (SPEC-FB-6 prose).
 */
function extractText(content: MessageEvent["message"]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Notice copy
// ---------------------------------------------------------------------------

function skipContent(modelId: string, credentialEnv: string | undefined): string {
  const hint = credentialEnv
    ? `missing API credentials (set ${credentialEnv} and restart)`
    : "missing API credentials";
  return `Fallback skipped "${modelId}": ${hint}. Trying next model.`;
}

function exhaustedContent(triedCount: number): string {
  return (
    `All fallback models exhausted for this turn (tried ${triedCount} models). ` +
    `The active model could not complete the request. ` +
    `Try again later, or use /model to switch manually.`
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Attach the fallback controller to a session. Returns a disposer (the
 * subscribe unsubscribe fn) or `null` when there is nothing to fall back to
 * (scopedModels.length < 2) — the caller skips wiring in that case.
 */
export function createFallbackController(
  opts: FallbackControllerOpts,
): { dispose(): void } | null {
  const { session, scopedModels, agentId } = opts;

  // Nothing to fall back to — no subscriber, no work (SPEC-FB-1 gating mirror).
  if (scopedModels.length < 2) {
    return null;
  }

  // --- Closure state ---------------------------------------------------------
  // lastUserPrompt: text of the most recent genuine user message.
  let lastUserPrompt: string | undefined;
  // Per-cascade guards (SPEC-FB-7):
  const triedModelIds = new Set<string>();
  let walkActive = false;
  // selfSubmitting: true between our sendUserMessage and the user message_end
  // it produces — so we don't treat our own re-submit as a genuine new turn.
  let selfSubmitting = false;

  function indexOfModelId(id: string | undefined): number {
    if (!id) return -1;
    return scopedModels.findIndex((m) => m.modelId === id);
  }

  async function emitExhausted(reason?: string): Promise<void> {
    walkActive = false;
    await session.sendCustomMessage(
      {
        customType: "zia:fallback-exhausted",
        display: true,
        content: exhaustedContent(triedModelIds.size),
        details: {
          agentId,
          attemptedModels: [...triedModelIds],
          ...(reason ? { reason } : {}),
        },
      },
      { triggerTurn: false },
    );
  }

  async function walk(): Promise<void> {
    // No captured prompt → cannot re-submit; exhaust immediately (SPEC-FB-6-C).
    if (lastUserPrompt === undefined) {
      await emitExhausted("no-prompt-captured");
      return;
    }

    const curId = session.model?.id;

    if (!walkActive) {
      walkActive = true;
      // Seed with the model that just failed so we never re-try it this cascade.
      triedModelIds.clear();
      if (curId) triedModelIds.add(curId);
    }

    const startIdx = indexOfModelId(curId) + 1;

    for (let i = startIdx; i < scopedModels.length; i++) {
      const candidate = scopedModels[i]!;
      if (triedModelIds.has(candidate.modelId)) continue;
      triedModelIds.add(candidate.modelId);

      try {
        await session.setModel(candidate.model);
      } catch {
        // No auth for this candidate — warn and continue (SPEC-FB-4).
        await session.sendCustomMessage(
          {
            customType: "zia:fallback-skip",
            display: true,
            content: skipContent(candidate.modelId, candidate.credentialEnv),
            details: {
              modelId: candidate.modelId,
              credentialEnv: candidate.credentialEnv,
            },
          },
          { triggerTurn: false },
        );
        continue;
      }

      // Switch succeeded → re-submit the failed prompt on the new model.
      // Guard the resulting user message_end as self-submitted (SPEC-FB-7-C).
      selfSubmitting = true;
      await session.sendUserMessage(lastUserPrompt);
      return;
    }

    // Walk exhausted with no successful switch (SPEC-FB-5).
    await emitExhausted();
  }

  // --- Subscriber ------------------------------------------------------------
  const unsubscribe = session.subscribe((event: ObservedEvent) => {
    if (isUserMessageEnd(event)) {
      const text = extractText(event.message.content);
      if (selfSubmitting) {
        // This is our own re-submit echo — do NOT reset the cascade (SPEC-FB-7-C).
        // Re-arm for the next genuine turn; the walk continues from the
        // successor on the next auto_retry_end.
        selfSubmitting = false;
        return;
      }
      // Genuine new boss turn → reset cascade state (SPEC-FB-7-B) and capture.
      lastUserPrompt = text;
      triedModelIds.clear();
      walkActive = false;
      return;
    }

    if (isAutoRetryFail(event)) {
      // Fire-and-forget: the walk is async. Errors inside are surfaced via
      // notices; we never throw out of the subscriber.
      void walk();
    }
  });

  return { dispose: unsubscribe };
}
