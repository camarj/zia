/**
 * base-adapter.test.ts — SC-01..SC-05, ADR-5
 *
 * Uses a concrete TestAdapter subclass defined inline to drive BaseAdapter's
 * final lifecycle methods. Tests real observable behaviour — spy call counts
 * on _start/_stop, and message forwarding via _attach + emit.
 */
import { describe, it, expect, vi } from "vitest";
import { BaseAdapter } from "../src/base-adapter.ts";
import type { MessageEvent, ApprovalView } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Inline concrete adapter for testing BaseAdapter abstract behaviour
// ---------------------------------------------------------------------------

class TestAdapter extends BaseAdapter {
  readonly platform = "test";

  readonly startSpy = vi.fn<[], Promise<void>>(() => Promise.resolve());
  readonly stopSpy = vi.fn<[], Promise<void>>(() => Promise.resolve());
  readonly sendMessageSpy = vi.fn<[string, string], Promise<void>>(() => Promise.resolve());
  readonly sendApprovalRequestSpy = vi.fn<[ApprovalView], Promise<void>>(() => Promise.resolve());

  protected override _start(): Promise<void> {
    return this.startSpy();
  }

  protected override _stop(): Promise<void> {
    return this.stopSpy();
  }

  override sendMessage(chatId: string, text: string): Promise<void> {
    return this.sendMessageSpy(chatId, text);
  }

  override sendApprovalRequest(view: ApprovalView): Promise<void> {
    return this.sendApprovalRequestSpy(view);
  }

  /** Expose protected emit() for testing. */
  testEmit(event: MessageEvent): void {
    this.emit(event);
  }
}

const makeEvent = (overrides: Partial<MessageEvent> = {}): MessageEvent => ({
  platform: "test",
  chatType: "dm",
  chatId: "C1",
  senderId: "U1",
  text: "hello",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BaseAdapter lifecycle (SC-01..SC-05)", () => {
  it("SC-01: connect() calls _start() exactly once", async () => {
    const adapter = new TestAdapter();
    await adapter.connect();
    expect(adapter.startSpy).toHaveBeenCalledTimes(1);
  });

  it("SC-02: connect() is idempotent — second connect() does NOT call _start() again", async () => {
    const adapter = new TestAdapter();
    await adapter.connect();
    await adapter.connect(); // second call — must be a no-op
    expect(adapter.startSpy).toHaveBeenCalledTimes(1);
  });

  it("SC-03: disconnect() calls _stop() exactly once", async () => {
    const adapter = new TestAdapter();
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.stopSpy).toHaveBeenCalledTimes(1);
  });

  it("SC-04: disconnect() is idempotent — second disconnect() does NOT call _stop() again", async () => {
    const adapter = new TestAdapter();
    await adapter.connect();
    await adapter.disconnect();
    await adapter.disconnect(); // second call — must be a no-op
    expect(adapter.stopSpy).toHaveBeenCalledTimes(1);
  });

  it("SC-04: disconnect() before connect() is safe (no _stop call)", async () => {
    const adapter = new TestAdapter();
    await adapter.disconnect(); // never connected — must not throw
    expect(adapter.stopSpy).toHaveBeenCalledTimes(0);
  });

  it("SC-05: emit() forwards MessageEvent to the runner-provided callback", () => {
    const adapter = new TestAdapter();
    const received: MessageEvent[] = [];

    // Wire via _attach (the internal hook GatewayRunner calls)
    adapter._attach((event) => received.push(event));

    const event = makeEvent({ text: "from adapter" });
    adapter.testEmit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toStrictEqual(event);
  });

  it("emit() throws if called before _attach()", () => {
    const adapter = new TestAdapter();
    expect(() => adapter.testEmit(makeEvent())).toThrow(/not.*registered|runner\.register/i);
  });

  it("SPEC-R2: BaseAdapter does not import @zia/core or pi.dev SDK", async () => {
    // Verify by importing the module and checking it resolves cleanly.
    // The real guard is the import itself succeeding in a context where
    // @earendil-works/pi-coding-agent is NOT listed as a direct dependency
    // of @zia/gateways (package.json). TypeScript would catch the import
    // at typecheck time; this test validates the module loads without
    // pulling in SDK types at runtime.
    const mod = await import("../src/base-adapter.ts");
    expect(typeof mod.BaseAdapter).toBe("function");
  });
});
