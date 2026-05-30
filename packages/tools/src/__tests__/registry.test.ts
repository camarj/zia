/**
 * registry.test.ts — BuiltinDescriptor registry tests (A.7, SPEC-F2-1..3).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WrappableTool } from "@zia/callbacks";
import { clear, get, getAll, register } from "../registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(name: string): ReturnType<typeof register> & { name: string; build: (cwd: string) => WrappableTool } {
  return undefined as never; // just for type; use object literals below
}

function fakeToolFrom(name: string): WrappableTool {
  return {
    name,
    label: `Label for ${name}`,
    description: `Description for ${name}`,
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

// ---------------------------------------------------------------------------

describe("registry — register / get / getAll / clear (SPEC-F2-1..3)", () => {
  beforeEach(() => {
    clear();
  });

  afterEach(() => {
    clear();
  });

  it("register() + get() round-trip", () => {
    const desc = { name: "read", build: (_cwd: string) => fakeToolFrom("read") };
    register(desc);
    expect(get("read")).toBe(desc);
  });

  it("getAll() returns all registered descriptors", () => {
    const readDesc = { name: "read", build: (_cwd: string) => fakeToolFrom("read") };
    const bashDesc = { name: "bash", build: (_cwd: string) => fakeToolFrom("bash") };
    register(readDesc);
    register(bashDesc);

    const all = getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(readDesc);
    expect(all).toContain(bashDesc);
  });

  it("clear() empties the registry", () => {
    register({ name: "ls", build: (_cwd: string) => fakeToolFrom("ls") });
    expect(getAll()).toHaveLength(1);
    clear();
    expect(getAll()).toHaveLength(0);
    expect(get("ls")).toBeUndefined();
  });

  it("get() returns undefined for unregistered name", () => {
    expect(get("nonexistent")).toBeUndefined();
  });

  // SPEC-F2-2: duplicate name (different object) throws with name in message
  it("register() throws on duplicate name with different object reference", () => {
    const desc1 = { name: "write", build: (_cwd: string) => fakeToolFrom("write") };
    const desc2 = { name: "write", build: (_cwd: string) => fakeToolFrom("write") };
    register(desc1);
    expect(() => register(desc2)).toThrow(/write/);
  });

  // SPEC-F2-2: same object reference is idempotent — no throw
  it("register() is idempotent for the same object reference", () => {
    const desc = { name: "edit", build: (_cwd: string) => fakeToolFrom("edit") };
    register(desc);
    expect(() => register(desc)).not.toThrow();
    expect(getAll()).toHaveLength(1);
  });

  // SPEC-F2-3: getAll snapshot is independent of internal map mutation
  it("getAll() returns a snapshot — mutations do not affect registry", () => {
    const desc = { name: "grep", build: (_cwd: string) => fakeToolFrom("grep") };
    register(desc);

    const snapshot = getAll();
    // Push a fake element to the snapshot array
    (snapshot as unknown[]).push({ name: "injected" });

    // Registry should be unchanged
    expect(getAll()).toHaveLength(1);
    expect(get("injected")).toBeUndefined();
  });
});
