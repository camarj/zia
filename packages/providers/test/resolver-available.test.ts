/**
 * Tests for resolveAvailableModels (SPEC-MODELS-1).
 *
 * Covers acceptance scenarios:
 *   SPEC-MODELS-1-A — all creds registered; returns 2 entries; hasAuth is true
 *   SPEC-MODELS-1-B — missing env var for a model → throws ZiaConfigError
 *   SPEC-MODELS-1-C — absent llm.available → single-entry fallback (default model)
 *   SPEC-MODELS-1-D — ollama / custom entry (no credentialEnv) → succeeds
 *
 * AuthStorage is a structural interface owned by @zia/providers — tests use
 * a plain mock that satisfies it, without importing @earendil-works/pi-coding-agent.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAvailableModels, ZiaConfigError } from "../src/resolver.ts";
import type { AuthStorageLike } from "../src/resolver.ts";

/** Minimal in-memory AuthStorage mock that satisfies AuthStorageLike. */
function makeAuthStorage(): AuthStorageLike & { _keys: Map<string, string> } {
  const _keys = new Map<string, string>();
  return {
    _keys,
    setRuntimeApiKey(provider: string, key: string) {
      _keys.set(provider, key);
    },
    hasAuth(provider: string) {
      return _keys.has(provider);
    },
  };
}

describe("resolveAvailableModels", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function makeFicha(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-providers-avail-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "profile.yaml"), yaml, "utf8");
    return dir;
  }

  // SPEC-MODELS-1-A — all creds registered
  it("returns array of length 2 and registers anthropic auth when both entries have ANTHROPIC_API_KEY (SPEC-MODELS-1-A)", async () => {
    const dir = await makeFicha(`
agent:
  id: fin-001
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  available:
    - provider: anthropic
      model: claude-sonnet-4-6
      thinkingLevel: medium
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      credentials_env: ANTHROPIC_API_KEY
`);
    const auth = makeAuthStorage();
    const result = await resolveAvailableModels(dir, { ANTHROPIC_API_KEY: "sk-test" }, auth);

    expect(result).toHaveLength(2);
    expect(result[0]!.model.id).toBe("claude-sonnet-4-6");
    expect(result[1]!.model.id).toBe("claude-opus-4-7");
    expect(auth.hasAuth("anthropic")).toBe(true);
  });

  it("returns entries in ficha order (SPEC-MODELS-1-A)", async () => {
    const dir = await makeFicha(`
agent:
  id: order-test
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  available:
    - provider: anthropic
      model: claude-opus-4-7
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-sonnet-4-6
      credentials_env: ANTHROPIC_API_KEY
`);
    const auth = makeAuthStorage();
    const result = await resolveAvailableModels(dir, { ANTHROPIC_API_KEY: "sk-test" }, auth);

    expect(result[0]!.model.id).toBe("claude-opus-4-7");
    expect(result[1]!.model.id).toBe("claude-sonnet-4-6");
  });

  it("maps thinkingLevel from each entry (SPEC-MODELS-1-A)", async () => {
    const dir = await makeFicha(`
agent:
  id: thinking-test
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  available:
    - provider: anthropic
      model: claude-sonnet-4-6
      thinkingLevel: medium
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      credentials_env: ANTHROPIC_API_KEY
`);
    const auth = makeAuthStorage();
    const result = await resolveAvailableModels(dir, { ANTHROPIC_API_KEY: "sk-key" }, auth);

    expect(result[0]!.thinkingLevel).toBe("medium");
    expect(result[1]!.thinkingLevel).toBe("high");
  });

  // SPEC-MODELS-1-B (realigned) — missing env var for an available[] entry does NOT throw.
  // The old SPEC-MODELS-1-B behavior (throw ZiaConfigError for missing available[] creds)
  // has been realigned to match Hermes §7 + pi.dev multi-model: the available[] loop is
  // now LAZY. Only the ACTIVE (llm.default) model's credential is checked strictly — and
  // that check lives in agent.ts, not in resolveAvailableModels. See engram #704.
  it("does NOT throw when an available[] entry has credentialEnv set but the env var is missing (SPEC-MODELS-1-B realigned: lazy auth)", async () => {
    const dir = await makeFicha(`
agent:
  id: err-test
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  available:
    - provider: anthropic
      model: claude-sonnet-4-6
      credentials_env: MY_KEY
`);
    const auth = makeAuthStorage();
    // Must resolve successfully — key is absent but that is lazy (no throw).
    const result = await resolveAvailableModels(dir, {}, auth);
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("claude-sonnet-4-6");
    // No key registered (env var absent — skipped)
    expect(auth.hasAuth("anthropic")).toBe(false);
  });

  it("skips auth registration for missing env var but still returns the descriptor (SPEC-MODELS-1-B realigned)", async () => {
    const dir = await makeFicha(`
agent:
  id: err-test
llm:
  default:
    provider: openai
    model: gpt-4o-mini
  available:
    - provider: openai
      model: gpt-4o-mini
      credentials_env: MY_OPENAI_KEY
`);
    const auth = makeAuthStorage();
    // Must not throw; descriptor is returned with no auth registered.
    const result = await resolveAvailableModels(dir, {}, auth);
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gpt-4o-mini");
    expect(auth.hasAuth("openai")).toBe(false);
  });

  // SPEC-MODELS-1-C — absent llm.available → single-entry fallback
  it("returns array of length 1 with the default model when llm.available is absent (SPEC-MODELS-1-C)", async () => {
    const dir = await makeFicha(`
agent:
  id: no-avail
llm:
  default:
    provider: openai
    model: gpt-4o-mini
    credentials_env: OPENAI_API_KEY
`);
    const auth = makeAuthStorage();
    const result = await resolveAvailableModels(dir, { OPENAI_API_KEY: "sk-test" }, auth);

    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gpt-4o-mini");
    // W-1: the fallback path registers the api-key explicitly (parity with the
    // loop path), not only relying on pi.dev's env-var fallback. The mock's
    // hasAuth only reflects setRuntimeApiKey calls, so this asserts registration.
    expect(auth.hasAuth("openai")).toBe(true);
  });

  it("returns array of length 1 when llm.available is an empty array (SPEC-MODELS-1-C / EC-11)", async () => {
    const dir = await makeFicha(`
agent:
  id: empty-avail
llm:
  default:
    provider: openai
    model: gpt-4o-mini
    credentials_env: OPENAI_API_KEY
  available: []
`);
    const auth = makeAuthStorage();
    const result = await resolveAvailableModels(dir, { OPENAI_API_KEY: "sk-test" }, auth);

    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gpt-4o-mini");
  });

  // SPEC-MODELS-1-D — ollama/custom (no credentialEnv) → succeeds without auth registration
  it("resolves a custom/ollama entry with no credentialEnv without error (SPEC-MODELS-1-D)", async () => {
    const dir = await makeFicha(`
agent:
  id: ollama-test
llm:
  default:
    provider: custom
    model: llama3.1:70b
    baseUrl: http://localhost:11434
  available:
    - provider: custom
      model: llama3.1:70b
      label: "Llama local"
      baseUrl: http://localhost:11434
`);
    const auth = makeAuthStorage();
    const result = await resolveAvailableModels(dir, {}, auth);

    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("llama3.1:70b");
  });

  it("does not require any env var for a custom entry with no credentialEnv (SPEC-MODELS-1-D)", async () => {
    const dir = await makeFicha(`
agent:
  id: ollama-no-key
llm:
  default:
    provider: custom
    model: llama3.1:70b
    baseUrl: http://localhost:11434
  available:
    - provider: custom
      model: llama3.1:70b
      baseUrl: http://localhost:11434
`);
    const auth = makeAuthStorage();
    // Empty env — must not throw ZiaConfigError
    await expect(resolveAvailableModels(dir, {}, auth)).resolves.toBeDefined();
  });

  // SPEC-MODELS-1 (OAuth prose) / EC-6 — OAuth provider (no credentialEnv) gates on hasAuth
  it("resolves an OAuth entry (no credentialEnv) when AuthStorage already has the token (SPEC-MODELS-1 OAuth)", async () => {
    const dir = await makeFicha(`
agent:
  id: oauth-ok
llm:
  default:
    provider: github-copilot
    model: gpt-4o
  available:
    - provider: github-copilot
      model: gpt-4o
      label: "Copilot"
`);
    const auth = makeAuthStorage();
    // Pre-seed the OAuth token as pi.dev's AuthStorage would at session start.
    auth.setRuntimeApiKey("github-copilot", "oauth-token");

    const result = await resolveAvailableModels(dir, {}, auth);
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gpt-4o");
  });

  // OAuth lazy auth: an available[] OAuth entry without a token does NOT throw.
  // The strict check (hasAuth required at startup) applies only to the ACTIVE
  // (llm.default) OAuth model — enforced in agent.ts. See engram #704.
  it("does NOT throw for an OAuth available[] entry when AuthStorage has no token (lazy auth, EC-6 realigned)", async () => {
    const dir = await makeFicha(`
agent:
  id: oauth-missing
llm:
  default:
    provider: github-copilot
    model: gpt-4o
  available:
    - provider: github-copilot
      model: gpt-4o
`);
    const auth = makeAuthStorage();
    // No token seeded — hasAuth("github-copilot") is false.
    // With lazy auth the menu resolver must NOT throw; it returns the descriptor.
    const result = await resolveAvailableModels(dir, {}, auth);
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gpt-4o");
    // No auth registered (OAuth token absent — skipped silently).
    expect(auth.hasAuth("github-copilot")).toBe(false);
  });

  // Mixed: anthropic + custom in available[]
  it("registers credentials for api-key entries but skips custom entries in a mixed list", async () => {
    const dir = await makeFicha(`
agent:
  id: mixed-test
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  available:
    - provider: anthropic
      model: claude-sonnet-4-6
      credentials_env: ANTHROPIC_API_KEY
    - provider: custom
      model: llama3.1:70b
      baseUrl: http://localhost:11434
`);
    const auth = makeAuthStorage();
    const result = await resolveAvailableModels(
      dir,
      { ANTHROPIC_API_KEY: "sk-test" },
      auth,
    );

    expect(result).toHaveLength(2);
    expect(auth.hasAuth("anthropic")).toBe(true);
    // Custom provider: no auth registration, no error
    expect(result[1]!.model.id).toBe("llama3.1:70b");
  });
});
