/**
 * null-adapter.test.ts — SPEC-R7, SC-05 (partial), SC-28 (partial setup)
 *
 * Verifies:
 * - NullAdapter extends BaseAdapter
 * - simulateInbound() triggers emit() to a registered runner callback
 * - sendMessage() appends to .sent
 * - sendApprovalRequest() appends to .approvalRequests
 * - _start/_stop are no-ops that resolve
 * - NullAdapter is NOT exported from the public barrel (SPEC-R7)
 */
import { describe, it, expect } from "vitest";
import { NullAdapter } from "../src/adapters/null-adapter.ts";
import { BaseAdapter } from "../src/base-adapter.ts";
import type { MessageEvent, ApprovalView } from "../src/types.ts";

const makeEvent = (overrides: Partial<MessageEvent> = {}): MessageEvent => ({
  platform: "null",
  chatType: "dm",
  chatId: "C1",
  senderId: "U1",
  text: "hello",
  ...overrides,
});

const makeApprovalView = (): ApprovalView => ({
  id: "tc-1",
  toolName: "send_email",
  riskLevel: "alto",
  summary: "Send email to boss@example.com",
});

describe("NullAdapter (SPEC-R7, SC-05 partial)", () => {
  it("NullAdapter extends BaseAdapter", () => {
    const adapter = new NullAdapter();
    expect(adapter).toBeInstanceOf(BaseAdapter);
  });

  it("platform is 'null'", () => {
    expect(new NullAdapter().platform).toBe("null");
  });

  it("_start and _stop resolve without error (no-ops)", async () => {
    const adapter = new NullAdapter();
    await expect(adapter.connect()).resolves.toBeUndefined();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("SC-05: simulateInbound() triggers the runner callback via emit()", () => {
    const adapter = new NullAdapter();
    const received: MessageEvent[] = [];
    adapter._attach((event) => received.push(event));

    const event = makeEvent({ text: "simulated" });
    adapter.simulateInbound(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toStrictEqual(event);
  });

  it("sendMessage() appends to .sent", async () => {
    const adapter = new NullAdapter();
    await adapter.sendMessage("C1", "hello");
    await adapter.sendMessage("C2", "world");
    expect(adapter.sent).toEqual([
      { chatId: "C1", text: "hello" },
      { chatId: "C2", text: "world" },
    ]);
  });

  it("sendApprovalRequest() appends to .approvalRequests", async () => {
    const adapter = new NullAdapter();
    const view = makeApprovalView();
    await adapter.sendApprovalRequest(view);
    expect(adapter.approvalRequests).toHaveLength(1);
    expect(adapter.approvalRequests[0]).toStrictEqual(view);
  });

  it("SPEC-R7: NullAdapter is NOT exported from the public barrel (src/index.ts)", async () => {
    // Import the barrel and verify NullAdapter is not present as a named export.
    const barrel = await import("../src/index.ts");
    expect((barrel as Record<string, unknown>)["NullAdapter"]).toBeUndefined();
  });
});
