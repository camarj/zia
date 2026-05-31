/**
 * agent-cache-wiring.test.ts — F-CORE-7: verify prompt-cache config + validation
 * is wired into createZiaAgent and surfaced on the handle.
 *
 * createZiaAgent calls the pi.dev SDK internally. We mock the SDK (same pattern
 * as audit-log-injection.test.ts) so the function runs to completion without
 * network, letting us assert handle.cache.{retention,eligibility} and the
 * PI_CACHE_RETENTION env lever.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => {
  const fakeRuntime = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  return {
    AuthStorage: {
      create: () => ({
        hasAuth: () => false,
        setRuntimeApiKey: () => {},
      }),
    },
    ModelRegistry: { create: () => ({}) },
    SessionManager: { create: () => ({}) },
    getAgentDir: () => "/fake-agent-dir",
    createAgentSessionFromServices: vi.fn().mockResolvedValue(fakeRuntime),
    createAgentSessionRuntime: vi.fn().mockResolvedValue(fakeRuntime),
    createAgentSessionServices: vi.fn().mockResolvedValue({ diagnostics: {} }),
  };
});

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
}));

import { createZiaAgent } from "../src/agent.ts";

const SOUL_MD = "# Test Agent\nA soul for the caching wiring test.";
const POLICIES_MD = "# Policies\n## Trivial\nTools: test_read\n";

function profileYaml(opts: { provider: string; model: string; cacheRetention?: string }): string {
  const retentionLine =
    opts.cacheRetention !== undefined ? `  cacheRetention: ${opts.cacheRetention}\n` : "";
  return `llm:\n${retentionLine}  default:\n    provider: ${opts.provider}\n    model: ${opts.model}\n`;
}

async function makeFicha(opts: {
  provider: string;
  model: string;
  cacheRetention?: string;
  soul?: string;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-cache-wiring-"));
  await writeFile(join(dir, "profile.yaml"), profileYaml(opts), "utf8");
  await writeFile(join(dir, "SOUL.md"), opts.soul ?? SOUL_MD, "utf8");
  await writeFile(join(dir, "POLICIES.md"), POLICIES_MD, "utf8");
  return dir;
}

describe("createZiaAgent — prompt-cache wiring (F-CORE-7)", () => {
  let createdDirs: string[] = [];
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "fake-test-key-cache-wiring";
    process.env.OPENAI_API_KEY = "fake-test-key-cache-wiring";
    delete process.env.PI_CACHE_RETENTION;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function fixture(opts: {
    provider: string;
    model: string;
    cacheRetention?: string;
    soul?: string;
  }): Promise<string> {
    const dir = await makeFicha(opts);
    createdDirs.push(dir);
    return dir;
  }

  it('defaults retention to "short" and reports eligibility on the handle', async () => {
    const fichaDir = await fixture({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    expect(handle.cache.retention).toBe("short");
    expect(handle.cache.eligibility.provider).toBe("anthropic");
    // The minimal fixture SOUL is below the cache minimum → ineligible.
    expect(handle.cache.eligibility.eligible).toBe(false);
    // "short" must NOT touch the env lever (pi.dev default).
    expect(process.env.PI_CACHE_RETENTION).toBeUndefined();
  });

  it('applies PI_CACHE_RETENTION=long when the ficha asks for "long"', async () => {
    const fichaDir = await fixture({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cacheRetention: "long",
    });
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    expect(handle.cache.retention).toBe("long");
    expect(process.env.PI_CACHE_RETENTION).toBe("long");
  });

  it("reports an Anthropic ficha large enough to cache as eligible", async () => {
    const bigSoul = `# Big Agent\n${"knowledge. ".repeat(600)}`;
    const fichaDir = await fixture({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      soul: bigSoul,
    });
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    expect(handle.cache.eligibility.eligible).toBe(true);
    expect(handle.cache.eligibility.estimatedTokens).toBeGreaterThan(1024);
  });

  it("reports non-Anthropic providers as a caching no-op", async () => {
    const bigSoul = `# Big Agent\n${"knowledge. ".repeat(600)}`;
    const fichaDir = await fixture({ provider: "openai", model: "gpt-4o", soul: bigSoul });
    const handle = await createZiaAgent({ fichaDir, rawTools: [] });

    expect(handle.cache.eligibility.eligible).toBe(false);
    expect(handle.cache.eligibility.reason).toMatch(/only applies to Anthropic/);
  });
});
