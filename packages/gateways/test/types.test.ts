/**
 * types.test.ts — compile-time type enforcement for gateway types (SC-06).
 *
 * Uses TypeScript `satisfies` and assignment checks. The test bodies are
 * intentionally empty at runtime — all enforcement is at compile time.
 * A type error here means the types.ts definitions diverge from the spec.
 */
import { describe, it } from "vitest";
import type {
  MessageEvent,
  AuthorizationResult,
  SlashCommand,
  ApprovalView,
  GatewayConfig,
  PlatformConfig,
  RunState,
  ChatType,
} from "../src/types.ts";

describe("types — compile-time shape enforcement (SC-06)", () => {
  it("MessageEvent requires platform, senderId, chatId, chatType, text", () => {
    // Each of these assignments must type-check. Missing a required field → compile error.
    const _event: MessageEvent = {
      platform: "slack",
      senderId: "U123",
      chatId: "C456",
      chatType: "channel",
      text: "hello",
    };
    void _event;
  });

  it("MessageEvent threadContext is optional", () => {
    const _withThread: MessageEvent = {
      platform: "slack",
      senderId: "U123",
      chatId: "C456",
      chatType: "channel",
      text: "hello",
      threadContext: "T789",
    };
    const _withoutThread: MessageEvent = {
      platform: "slack",
      senderId: "U123",
      chatId: "C456",
      chatType: "channel",
      text: "hello",
    };
    void _withThread;
    void _withoutThread;
  });

  it("ChatType is a discriminated string union", () => {
    const _dm: ChatType = "dm";
    const _channel: ChatType = "channel";
    const _thread: ChatType = "thread";
    const _group: ChatType = "group";
    void _dm; void _channel; void _thread; void _group;
  });

  it("AuthorizationResult is a discriminated union", () => {
    const _authorized: AuthorizationResult = { authorized: true };
    const _denied: AuthorizationResult = { authorized: false, reason: "default-reject" };
    void _authorized; void _denied;
  });

  it("SlashCommand covers all 7 kinds", () => {
    const _stop: SlashCommand = { kind: "stop" };
    const _new: SlashCommand = { kind: "new" };
    const _queue: SlashCommand = { kind: "queue" };
    const _status: SlashCommand = { kind: "status" };
    const _approve: SlashCommand = { kind: "approve", id: "req-42" };
    const _deny: SlashCommand = { kind: "deny", id: "req-42" };
    const _model: SlashCommand = { kind: "model", name: "claude-opus-4-7" };
    void _stop; void _new; void _queue; void _status; void _approve; void _deny; void _model;
  });

  it("ApprovalView has id, toolName, riskLevel, summary — no raw params (ADR-4)", () => {
    const _view: ApprovalView = {
      id: "tc-1",
      toolName: "send_email",
      riskLevel: "alto",
      summary: "Send an email to boss@example.com",
    };
    void _view;

    // Verify no 'params' field exists on the type at compile time.
    // @ts-expect-error — params must NOT exist on ApprovalView (ADR-4)
    const _bad: ApprovalView = { id: "x", toolName: "t", riskLevel: "alto", summary: "s", params: {} };
    void _bad;
  });

  it("GatewayConfig has optional allowAll and platforms", () => {
    const _empty: GatewayConfig = {};
    const _withAll: GatewayConfig = { allowAll: true };
    const _withPlatforms: GatewayConfig = {
      platforms: {
        slack: { allowAll: true },
        email: { allowedUsers: ["boss@example.com"] },
      },
    };
    void _empty; void _withAll; void _withPlatforms;
  });

  it("PlatformConfig has optional allowAll and allowedUsers", () => {
    const _empty: PlatformConfig = {};
    const _withAll: PlatformConfig = { allowAll: true };
    const _withUsers: PlatformConfig = { allowedUsers: ["U123"] };
    void _empty; void _withAll; void _withUsers;
  });

  it("RunState is the right union", () => {
    const _streaming: RunState = "streaming";
    const _idle: RunState = "idle";
    const _compacting: RunState = "compacting";
    void _streaming; void _idle; void _compacting;
  });
});
