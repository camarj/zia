/**
 * agent-message-subscription.test.ts — SPEC-F4-5
 *
 * Verifies messagePersistExtension behavior:
 *  - mock pi.on captures the registered handler
 *  - synthetic MessageEndEvents (user / assistant / toolResult) → correct sink.record calls
 *  - empty-content assistant turn → sink.record NOT called (skipped)
 *  - missing onMessageEnd / no-op path: factory created but not called
 *
 * Strategy: unit test the ExtensionFactory directly. We capture the registered
 * "message_end" handler by intercepting pi.on() and invoke it with synthetic events.
 * No pi.dev session is started — zero credentials or network required.
 */

import { describe, expect, it, vi } from "vitest";

import { messagePersistExtension, type MessageSink } from "../src/message-persist-extension.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Synthetic pi ExtensionAPI — records the message_end handler registered via pi.on(). */
function makeMockPi(): {
  pi: { on: ReturnType<typeof vi.fn> };
  capturedHandlers: Map<string, (ev: unknown) => unknown>;
} {
  const capturedHandlers = new Map<string, (ev: unknown) => unknown>();

  const pi = {
    on: vi.fn((event: string, handler: (ev: unknown) => unknown) => {
      capturedHandlers.set(event, handler);
    }),
  };

  return { pi, capturedHandlers };
}

/** MessageSink spy — records every call to record(). */
function makeMockSink(): {
  sink: MessageSink;
  calls: Array<{
    sessionKey: string;
    role: string;
    content: string;
    toolName: string | null;
    timestamp: string;
  }>;
} {
  const calls: Array<{
    sessionKey: string;
    role: string;
    content: string;
    toolName: string | null;
    timestamp: string;
  }> = [];

  const sink: MessageSink = {
    record(m) {
      calls.push({ ...m });
    },
  };

  return { sink, calls };
}

// ---------------------------------------------------------------------------
// Synthetic AgentMessage shapes (mirroring pi-ai types.d.ts@0.76.0)
// ---------------------------------------------------------------------------

function makeUserMessageEvent(content: string, timestamp = 1000): object {
  return {
    type: "message_end",
    message: {
      role: "user",
      content,
      timestamp,
    },
  };
}

function makeUserMessageArrayEvent(parts: Array<Record<string, unknown>>, timestamp = 1000): object {
  return {
    type: "message_end",
    message: {
      role: "user",
      content: parts,
      timestamp,
    },
  };
}

function makeAssistantMessageEvent(
  parts: Array<Record<string, unknown>>,
  timestamp = 2000,
): object {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: parts,
      timestamp,
    },
  };
}

function makeToolResultMessageEvent(
  content: Array<Record<string, unknown>>,
  toolName: string,
  timestamp = 3000,
): object {
  return {
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "call-abc",
      toolName,
      content,
      timestamp,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messagePersistExtension — factory registration", () => {
  it("registers a message_end handler via pi.on", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink } = makeMockSink();

    const factory = messagePersistExtension(sink, "test-session");
    factory(pi as never);

    expect(pi.on).toHaveBeenCalledWith("message_end", expect.any(Function));
    expect(capturedHandlers.has("message_end")).toBe(true);
  });
});

describe("messagePersistExtension — user message (string content)", () => {
  it("calls sink.record with correct role/content/timestamp for a string-body user message", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-1");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(makeUserMessageEvent("hello world", 1_700_000_000_000));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionKey: "sess-1",
      role: "user",
      content: "hello world",
      toolName: null,
    });
    // ISO timestamp derived from the epoch ms
    expect(calls[0]!.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("calls sink.record for a user message with array TextContent", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-2");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(
      makeUserMessageArrayEvent(
        [
          { type: "text", text: "part one " },
          { type: "image", data: "base64data" }, // should be ignored
          { type: "text", text: "part two" },
        ],
        2000,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.content).toBe("part one part two");
    expect(calls[0]!.role).toBe("user");
  });
});

describe("messagePersistExtension — assistant message", () => {
  it("extracts text content from assistant message parts", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-3");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(
      makeAssistantMessageEvent(
        [
          { type: "thinking", thinking: "internal thoughts" }, // should be ignored
          { type: "text", text: "I will read the file." },
          { type: "tool_call", name: "read", input: {} }, // should be ignored
        ],
        5000,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.role).toBe("assistant");
    expect(calls[0]!.content).toBe("I will read the file.");
    expect(calls[0]!.toolName).toBeNull();
  });

  it("skips a pure-tool-call assistant turn with no text content (SPEC-F4-5 empty→skipped)", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-4");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(
      makeAssistantMessageEvent(
        [
          { type: "tool_call", name: "bash", input: { cmd: "ls" } },
        ],
        6000,
      ),
    );

    // Empty text → skipped entirely
    expect(calls).toHaveLength(0);
  });

  it("skips a pure-thinking assistant turn with no text", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-5");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(
      makeAssistantMessageEvent(
        [{ type: "thinking", thinking: "deep thoughts" }],
        7000,
      ),
    );

    expect(calls).toHaveLength(0);
  });
});

describe("messagePersistExtension — toolResult message", () => {
  it("records toolResult with correct toolName and text content", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-6");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(
      makeToolResultMessageEvent(
        [{ type: "text", text: "file contents here" }],
        "read",
        8000,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionKey: "sess-6",
      role: "toolResult",
      content: "file contents here",
      toolName: "read",
    });
  });

  it("skips toolResult with empty text content", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-7");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(
      makeToolResultMessageEvent(
        [{ type: "image", data: "imgdata" }],
        "read",
        9000,
      ),
    );

    expect(calls).toHaveLength(0);
  });
});

describe("messagePersistExtension — timestamp fallback", () => {
  it("uses Date.now() when the message has no timestamp field", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-8");
    factory(pi as never);

    const before = Date.now();
    const handler = capturedHandlers.get("message_end")!;
    handler({
      type: "message_end",
      message: {
        role: "user",
        content: "no timestamp here",
        // deliberately no `timestamp` field
      },
    });
    const after = Date.now();

    expect(calls).toHaveLength(1);
    const ts = new Date(calls[0]!.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("messagePersistExtension — multiple messages", () => {
  it("records each message_end event independently", () => {
    const { pi, capturedHandlers } = makeMockPi();
    const { sink, calls } = makeMockSink();

    const factory = messagePersistExtension(sink, "sess-9");
    factory(pi as never);

    const handler = capturedHandlers.get("message_end")!;
    handler(makeUserMessageEvent("first", 1000));
    handler(makeAssistantMessageEvent([{ type: "text", text: "second" }], 2000));
    handler(makeToolResultMessageEvent([{ type: "text", text: "third" }], "bash", 3000));
    // skip: pure tool call
    handler(makeAssistantMessageEvent([{ type: "tool_call", name: "x" }], 4000));

    expect(calls).toHaveLength(3);
    expect(calls[0]!.content).toBe("first");
    expect(calls[1]!.content).toBe("second");
    expect(calls[2]!.content).toBe("third");
  });
});
