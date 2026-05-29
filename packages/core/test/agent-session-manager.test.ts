/**
 * agent-session-manager.test.ts — ADR-1: verify the sessionManager DI seam
 * in createZiaAgent.
 *
 * When opts.sessionManager is provided, createZiaAgent must pass it to
 * createAgentSessionRuntime instead of the default SessionManager.create(cwd).
 *
 * When opts.sessionManager is NOT provided, createZiaAgent must fall back to
 * SessionManager.create(cwd) (default behaviour unchanged).
 *
 * The pi.dev SDK is mocked so no real sessions or network calls are made.
 * We use vi.fn() directly on the imported mock so we can inspect calls per-test.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Sentinels declared with vi.hoisted so they are available inside vi.mock
// ---------------------------------------------------------------------------
const { fakeDefaultSessionManager, fakeCustomSessionManager, fakeRuntime } =
  vi.hoisted(() => ({
    fakeDefaultSessionManager: { __tag: "default-sm" } as unknown,
    fakeCustomSessionManager: { __tag: "custom-sm" } as unknown,
    fakeRuntime: {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
  }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => ({
      hasAuth: () => false,
      setRuntimeApiKey: () => {},
    }),
  },
  ModelRegistry: {
    create: () => ({}),
  },
  SessionManager: {
    create: (_cwd?: string) => fakeDefaultSessionManager,
  },
  getAgentDir: () => "/fake-agent-dir",
  createAgentSessionFromServices: vi.fn().mockResolvedValue(fakeRuntime),
  // createAgentSessionRuntime is a vi.fn() — we spy on .mock.calls per test
  createAgentSessionRuntime: vi.fn().mockResolvedValue(fakeRuntime),
  createAgentSessionServices: vi.fn().mockResolvedValue({ diagnostics: {} }),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: () => ({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }),
}));

// Import SDK mock AFTER vi.mock declarations so we get the mocked version
import * as piSdk from "@earendil-works/pi-coding-agent";
import { createZiaAgent } from "../src/agent.ts";

// ---------------------------------------------------------------------------
// Minimal ficha
// ---------------------------------------------------------------------------
const PROFILE_YAML = `
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim();

const SOUL_MD = `# Test Agent\nTest soul.`;
const POLICIES_MD = `# Policies\n## Trivial\nTools: test_read\n`;

async function makeCompleteFicha(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-sm-test-"));
  await writeFile(join(dir, "profile.yaml"), PROFILE_YAML, "utf8");
  await writeFile(join(dir, "SOUL.md"), SOUL_MD, "utf8");
  await writeFile(join(dir, "POLICIES.md"), POLICIES_MD, "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createZiaAgent — sessionManager DI seam (ADR-1)", () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    // Reset call history on the runtime mock between tests
    vi.mocked(piSdk.createAgentSessionRuntime).mockClear();
    process.env.ANTHROPIC_API_KEY = "fake-test-key-sm-seam";
  });

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  async function makeFixture(): Promise<string> {
    const dir = await makeCompleteFicha();
    createdDirs.push(dir);
    return dir;
  }

  it("uses SessionManager.create(cwd) by default when no sessionManager is injected", async () => {
    const fichaDir = await makeFixture();

    await createZiaAgent({ fichaDir, rawTools: [] });

    const calls = vi.mocked(piSdk.createAgentSessionRuntime).mock.calls;
    expect(calls).toHaveLength(1);
    // Second arg is the options object; sessionManager should be the default sentinel
    const opts = calls[0]![1] as { sessionManager?: unknown };
    expect(opts.sessionManager).toBe(fakeDefaultSessionManager);
  });

  it("uses the injected sessionManager when provided (overrides default)", async () => {
    const fichaDir = await makeFixture();

    await createZiaAgent({
      fichaDir,
      rawTools: [],
      sessionManager: fakeCustomSessionManager as never,
    });

    const calls = vi.mocked(piSdk.createAgentSessionRuntime).mock.calls;
    expect(calls).toHaveLength(1);
    const opts = calls[0]![1] as { sessionManager?: unknown };
    // Must use the injected instance, NOT the default
    expect(opts.sessionManager).toBe(fakeCustomSessionManager);
    expect(opts.sessionManager).not.toBe(fakeDefaultSessionManager);
  });

  it("returns a valid handle regardless of which sessionManager path is taken", async () => {
    const fichaDir = await makeFixture();

    const handle = await createZiaAgent({
      fichaDir,
      rawTools: [],
      sessionManager: fakeCustomSessionManager as never,
    });

    expect(handle).toHaveProperty("runtime");
    expect(handle).toHaveProperty("queue");
  });

  it("opts.cwd is used when provided (handle returned cleanly)", async () => {
    const fichaDir = await makeFixture();

    const handle = await createZiaAgent({
      fichaDir,
      rawTools: [],
      cwd: fichaDir,
    });

    expect(handle).toHaveProperty("runtime");
    expect(handle).toHaveProperty("queue");
    // cwd from opts is passed to runtime; verify via mock call opts
    const calls = vi.mocked(piSdk.createAgentSessionRuntime).mock.calls;
    expect(calls).toHaveLength(1);
    const opts = calls[0]![1] as { cwd?: string };
    expect(opts.cwd).toBe(fichaDir);
  });
});
