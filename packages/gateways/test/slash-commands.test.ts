/**
 * slash-commands.test.ts — SC-09..SC-16
 */
import { describe, it, expect } from "vitest";
import { resolveCommand } from "../src/slash-commands.ts";

describe("resolveCommand (SC-09..SC-16)", () => {
  it("SC-09: /stop → { kind: 'stop' }", () => {
    expect(resolveCommand("/stop")).toEqual({ kind: "stop" });
  });

  it("SC-10: /new → { kind: 'new' }", () => {
    expect(resolveCommand("/new")).toEqual({ kind: "new" });
  });

  it("SC-11: /queue → { kind: 'queue' }", () => {
    expect(resolveCommand("/queue")).toEqual({ kind: "queue" });
  });

  it("SC-12: /status → { kind: 'status' }", () => {
    expect(resolveCommand("/status")).toEqual({ kind: "status" });
  });

  it("SC-13: /approve <id> → { kind: 'approve', id }", () => {
    expect(resolveCommand("/approve req-42")).toEqual({ kind: "approve", id: "req-42" });
  });

  it("SC-14: /deny <id> → { kind: 'deny', id }", () => {
    expect(resolveCommand("/deny req-42")).toEqual({ kind: "deny", id: "req-42" });
  });

  it("SC-15: /model <name> → { kind: 'model', name }", () => {
    expect(resolveCommand("/model claude-opus-4-7")).toEqual({
      kind: "model",
      name: "claude-opus-4-7",
    });
  });

  it("SC-16: plain text returns null", () => {
    expect(resolveCommand("hello world")).toBeNull();
  });

  it("SC-16: empty string returns null", () => {
    expect(resolveCommand("")).toBeNull();
  });

  it("SC-16: unknown slash command returns null", () => {
    expect(resolveCommand("/unknown")).toBeNull();
  });

  it("SC-16: slash command without required arg returns null (/approve with no id)", () => {
    expect(resolveCommand("/approve")).toBeNull();
  });

  it("SC-16: slash command without required arg returns null (/deny with no id)", () => {
    expect(resolveCommand("/deny")).toBeNull();
  });

  it("SC-16: slash command without required arg returns null (/model with no name)", () => {
    expect(resolveCommand("/model")).toBeNull();
  });
});
