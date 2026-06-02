/**
 * fallback-controller.test.ts — SPEC-FB-2 through SPEC-FB-7 (model-fallback, F-LLM-4)
 *
 * Verifies createFallbackController, the SESSION SUBSCRIBER that performs
 * automatic cross-model fallback when pi.dev exhausts its same-model retries.
 *
 * Coverage:
 *  T-2.1  SPEC-FB-2-A/B/C — trigger ONLY on auto_retry_end { success:false }
 *  T-2.2  SPEC-FB-3-A/B   — model walk & switch (successor only, no wrap)
 *  T-2.3  SPEC-FB-4-A/B   — skip unauthenticated candidate (setModel throws)
 *  T-2.4  SPEC-FB-5-A/B   — exhaustion: one notice, no loop
 *  T-2.5  SPEC-FB-6-A/B/C — prompt capture & re-submission
 *  T-2.6  SPEC-FB-7-A/B/C — permanence + cascade reset + selfSubmitting guard
 *
 * Strategy: a fake session implementing the structural subset
 *   { subscribe, setModel, sendUserMessage, sendCustomMessage, model }.
 * The captured subscribe listener is invoked directly with synthetic events.
 * No pi.dev SDK import — the controller is testable in isolation.
 */

import { describe, expect, it, vi } from "vitest";

import { createFallbackController } from "../src/fallback-controller.ts";
import type { FallbackControllerOpts } from "../src/fallback-controller.ts";

// ---------------------------------------------------------------------------
// Fake session + helpers
// ---------------------------------------------------------------------------

type SessionEvent = { type: string; [k: string]: unknown };
type Listener = (event: SessionEvent) => void;

interface FakeModel {
  id: string;
}

/** Build a scopedModels entry with a minimal Model-shaped object. */
function entry(modelId: string, credentialEnv?: string, label?: string) {
  return {
    model: { id: modelId } as unknown as FakeModel,
    modelId,
    credentialEnv,
    label,
  };
}

interface FakeSession {
  subscribe: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  sendCustomMessage: ReturnType<typeof vi.fn>;
  model: FakeModel | undefined;
  /** Emit an event to the subscribed listener (after createFallbackController). */
  emit(event: SessionEvent): void;
  /** Current captured listener. */
  _listener: Listener | undefined;
}

function makeSession(activeModelId: string): FakeSession {
  const s: FakeSession = {
    _listener: undefined,
    subscribe: vi.fn((listener: Listener) => {
      s._listener = listener;
      return () => {
        s._listener = undefined;
      };
    }),
    setModel: vi.fn(async (model: FakeModel) => {
      // Default: switch succeeds and updates the active model getter.
      s.model = model;
    }),
    sendUserMessage: vi.fn(async () => {}),
    sendCustomMessage: vi.fn(async () => {}),
    model: { id: activeModelId },
    emit(event: SessionEvent) {
      if (!s._listener) throw new Error("no listener subscribed");
      s._listener(event);
    },
  };
  return s;
}

/** A genuine user message_end event (from a boss). */
function userMessageEnd(text: string): SessionEvent {
  return {
    type: "message_end",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function autoRetryFail(): SessionEvent {
  return { type: "auto_retry_end", success: false, attempt: 3 };
}

function autoRetryOk(): SessionEvent {
  return { type: "auto_retry_end", success: true, attempt: 2 };
}

function buildOpts(
  session: FakeSession,
  models: ReturnType<typeof entry>[],
  agentId = "fin-001",
): FallbackControllerOpts {
  return {
    session: session as unknown as FallbackControllerOpts["session"],
    scopedModels: models as unknown as FallbackControllerOpts["scopedModels"],
    agentId,
  };
}

/** Flush microtasks so the controller's async walk completes. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// T-2.1 — SPEC-FB-2: trigger discrimination
// ---------------------------------------------------------------------------

describe("createFallbackController — trigger discrimination (SPEC-FB-2)", () => {
  it("fires setModel on auto_retry_end { success:false } (SPEC-FB-2-A)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("hello"));
    session.emit(autoRetryFail());
    await flush();

    expect(session.setModel).toHaveBeenCalledTimes(1);
    expect(session.setModel).toHaveBeenCalledWith(models[1]!.model);
  });

  it("does NOT fire on auto_retry_end { success:true } (SPEC-FB-2-B)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("hello"));
    session.emit(autoRetryOk());
    await flush();

    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does NOT fire on agent_end without a preceding auto_retry_end (SPEC-FB-2-C)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("hello"));
    session.emit({ type: "agent_end", willRetry: false, messages: [] });
    await flush();

    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("returns null when scopedModels.length < 2 (no subscribe)", () => {
    const session = makeSession("m0");
    const controller = createFallbackController(buildOpts(session, [entry("m0")]));
    expect(controller).toBeNull();
    expect(session.subscribe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-2.2 — SPEC-FB-3: model walk & switch
// ---------------------------------------------------------------------------

describe("createFallbackController — model walk & switch (SPEC-FB-3)", () => {
  it("3 models, active=entry[0] fails → switches to entry[1], retries, entry[2] not attempted (SPEC-FB-3-A)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1"), entry("m2")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("do the thing"));
    session.emit(autoRetryFail());
    await flush();

    expect(session.setModel).toHaveBeenCalledTimes(1);
    expect(session.setModel).toHaveBeenCalledWith(models[1]!.model);
    expect(session.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(session.sendUserMessage).toHaveBeenCalledWith("do the thing");
    // entry[2] never attempted because the walk stops on first success.
    expect(session.setModel).not.toHaveBeenCalledWith(models[2]!.model);
  });

  it("active model is last in list → exhaustion fires immediately, no setModel (SPEC-FB-3-B)", async () => {
    const session = makeSession("m2");
    const models = [entry("m0"), entry("m1"), entry("m2")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("last model prompt"));
    session.emit(autoRetryFail());
    await flush();

    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.sendUserMessage).not.toHaveBeenCalled();
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(session.sendCustomMessage.mock.calls[0]![0].customType).toBe(
      "zia:fallback-exhausted",
    );
  });
});

// ---------------------------------------------------------------------------
// T-2.3 — SPEC-FB-4: skip unauthenticated candidate
// ---------------------------------------------------------------------------

describe("createFallbackController — skip unauthenticated (SPEC-FB-4)", () => {
  it("setModel(entry[1]) throws → skip notice, then setModel(entry[2]) succeeds (SPEC-FB-4-A)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1", "OPENAI_API_KEY"), entry("m2")];
    // entry[1] throws (no auth); entry[2] succeeds.
    session.setModel.mockImplementation(async (model: FakeModel) => {
      if (model.id === "m1") throw new Error("no auth configured for model");
      session.model = model;
    });
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("retry me"));
    session.emit(autoRetryFail());
    await flush();

    // Both candidates attempted.
    expect(session.setModel).toHaveBeenCalledWith(models[1]!.model);
    expect(session.setModel).toHaveBeenCalledWith(models[2]!.model);
    // Skip notice emitted naming entry[1].
    const skipCall = session.sendCustomMessage.mock.calls.find(
      (c) => c[0].customType === "zia:fallback-skip",
    );
    expect(skipCall).toBeDefined();
    expect(skipCall![0].details.modelId).toBe("m1");
    // Final success re-submits on entry[2].
    expect(session.sendUserMessage).toHaveBeenCalledWith("retry me");
  });

  it("skip notice content includes the credentialEnv name (SPEC-FB-4-B)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1", "OPENAI_API_KEY"), entry("m2")];
    session.setModel.mockImplementation(async (model: FakeModel) => {
      if (model.id === "m1") throw new Error("no auth");
      session.model = model;
    });
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("x"));
    session.emit(autoRetryFail());
    await flush();

    const skipCall = session.sendCustomMessage.mock.calls.find(
      (c) => c[0].customType === "zia:fallback-skip",
    );
    expect(skipCall).toBeDefined();
    expect(skipCall![0].content).toContain("OPENAI_API_KEY");
    expect(skipCall![0].details.credentialEnv).toBe("OPENAI_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// T-2.4 — SPEC-FB-5: exhaustion
// ---------------------------------------------------------------------------

describe("createFallbackController — exhaustion (SPEC-FB-5)", () => {
  it("all setModel calls throw → exactly one exhausted notice, no sendUserMessage, no extra setModel (SPEC-FB-5-A)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1"), entry("m2")];
    session.setModel.mockImplementation(async () => {
      throw new Error("no auth");
    });
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("prompt"));
    session.emit(autoRetryFail());
    await flush();

    // Both successors attempted (m1, m2), then exhausted.
    expect(session.setModel).toHaveBeenCalledTimes(2);
    expect(session.sendUserMessage).not.toHaveBeenCalled();
    const exhausted = session.sendCustomMessage.mock.calls.filter(
      (c) => c[0].customType === "zia:fallback-exhausted",
    );
    expect(exhausted).toHaveLength(1);
  });

  it("exhausted notice details contain agentId and attemptedModels (SPEC-FB-5-B)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1"), entry("m2")];
    session.setModel.mockImplementation(async () => {
      throw new Error("no auth");
    });
    createFallbackController(buildOpts(session, models, "fin-001"));

    session.emit(userMessageEnd("prompt"));
    session.emit(autoRetryFail());
    await flush();

    const exhausted = session.sendCustomMessage.mock.calls.find(
      (c) => c[0].customType === "zia:fallback-exhausted",
    );
    expect(exhausted).toBeDefined();
    expect(exhausted![0].details.agentId).toBe("fin-001");
    expect(exhausted![0].details.attemptedModels).toEqual(
      expect.arrayContaining(["m1", "m2"]),
    );
  });
});

// ---------------------------------------------------------------------------
// T-2.5 — SPEC-FB-6: prompt capture & re-submission
// ---------------------------------------------------------------------------

describe("createFallbackController — prompt capture (SPEC-FB-6)", () => {
  it("re-submits the captured user prompt on fallback (SPEC-FB-6-A)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("Generate financial summary"));
    session.emit(autoRetryFail());
    await flush();

    expect(session.sendUserMessage).toHaveBeenCalledWith("Generate financial summary");
  });

  it("uses only the LAST user message when several arrive (SPEC-FB-6-B)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("First prompt"));
    session.emit(userMessageEnd("Second prompt"));
    session.emit(autoRetryFail());
    await flush();

    expect(session.sendUserMessage).toHaveBeenCalledWith("Second prompt");
    expect(session.sendUserMessage).not.toHaveBeenCalledWith("First prompt");
  });

  it("extracts text from TextContent[] content shape (SPEC-FB-6 prose)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    session.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "part one " },
          { type: "image", url: "x" },
          { type: "text", text: "part two" },
        ],
        timestamp: Date.now(),
      },
    });
    session.emit(autoRetryFail());
    await flush();

    expect(session.sendUserMessage).toHaveBeenCalledWith("part one part two");
  });

  it("trigger before any user message → exhausted with reason no-prompt-captured, no sendUserMessage (SPEC-FB-6-C)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    session.emit(autoRetryFail());
    await flush();

    expect(session.sendUserMessage).not.toHaveBeenCalled();
    const exhausted = session.sendCustomMessage.mock.calls.find(
      (c) => c[0].customType === "zia:fallback-exhausted",
    );
    expect(exhausted).toBeDefined();
    expect(exhausted![0].details.reason).toBe("no-prompt-captured");
    // No model walk attempted when there is no prompt to re-submit.
    expect(session.setModel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-2.6 — SPEC-FB-7: permanence + cascade reset + selfSubmitting guard
// ---------------------------------------------------------------------------

describe("createFallbackController — permanence & cascade reset (SPEC-FB-7)", () => {
  it("subsequent genuine user turn uses the switched model; no auto-revert (SPEC-FB-7-A)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1")];
    createFallbackController(buildOpts(session, models));

    // First cascade: switch m0 → m1.
    session.emit(userMessageEnd("prompt one"));
    session.emit(autoRetryFail());
    await flush();
    expect(session.model!.id).toBe("m1");

    // The controller's self-resubmission produces a user message_end; mark it.
    // Then a genuine new boss prompt arrives — model must remain m1.
    session.emit(userMessageEnd("prompt one")); // self-resubmit echo (selfSubmitting)
    session.emit(userMessageEnd("a brand new question")); // genuine
    await flush();

    // No setModel call reverted to m0.
    expect(session.setModel).not.toHaveBeenCalledWith(models[0]!.model);
    expect(session.model!.id).toBe("m1");
  });

  it("re-submitted turn that fails again continues from successor, each model once (SPEC-FB-7 / EC-FB-6)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1"), entry("m2")];
    createFallbackController(buildOpts(session, models));

    // Cascade 1: m0 fails → switch to m1, re-submit.
    session.emit(userMessageEnd("p"));
    session.emit(autoRetryFail());
    await flush();
    expect(session.setModel).toHaveBeenLastCalledWith(models[1]!.model);

    // The self-resubmit echo (selfSubmitting) — must NOT reset cascade.
    session.emit(userMessageEnd("p"));
    // m1 also fails → continue to m2 (NOT back to m1).
    session.emit(autoRetryFail());
    await flush();
    expect(session.setModel).toHaveBeenLastCalledWith(models[2]!.model);
    // m1 attempted exactly once across the cascade.
    const m1Calls = session.setModel.mock.calls.filter((c) => c[0].id === "m1");
    expect(m1Calls).toHaveLength(1);
  });

  it("genuine new user turn (selfSubmitting=false) resets cascade state (SPEC-FB-7-B)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1"), entry("m2")];
    createFallbackController(buildOpts(session, models));

    // Cascade 1: switch to m1.
    session.emit(userMessageEnd("p1"));
    session.emit(autoRetryFail());
    await flush();
    session.emit(userMessageEnd("p1")); // self-resubmit echo

    // Genuine new prompt resets cascade. Active model is now m1.
    session.emit(userMessageEnd("p2"));
    await flush();
    session.setModel.mockClear();

    // New failure on m1 → fresh cascade walks to m2 (successor of m1).
    session.emit(autoRetryFail());
    await flush();
    expect(session.setModel).toHaveBeenCalledWith(models[2]!.model);
  });

  it("self-resubmission (selfSubmitting=true) does NOT reset cascade state (SPEC-FB-7-C)", async () => {
    const session = makeSession("m0");
    const models = [entry("m0"), entry("m1"), entry("m2")];
    createFallbackController(buildOpts(session, models));

    session.emit(userMessageEnd("p"));
    session.emit(autoRetryFail());
    await flush();
    // The first user message_end after re-submission is the self echo.
    session.emit(userMessageEnd("p"));
    // Immediately another failure (still same cascade) → must go to m2, not m1.
    session.emit(autoRetryFail());
    await flush();
    expect(session.setModel).toHaveBeenLastCalledWith(models[2]!.model);
  });
});
