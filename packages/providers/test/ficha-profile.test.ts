/**
 * Tests for FichaProfile / FichaModelEntry / FichaLlmDeclaration (SPEC-FICHA-1).
 *
 * Covers acceptance scenarios:
 *   SPEC-FICHA-1-A — minimal ficha (no new fields) parses cleanly
 *   SPEC-FICHA-1-B — full ficha with available[], budget, agent.id
 *   SPEC-FICHA-1-C — agent.id absent → profile.agent?.id is undefined + warning
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readFichaProfile } from "../src/ficha.ts";

describe("readFichaProfile", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function makeFicha(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-providers-profile-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "profile.yaml"), yaml, "utf8");
    return dir;
  }

  // SPEC-FICHA-1-A — minimal ficha (no new fields)
  it("parses minimal ficha (only llm.default + agent.id) without errors", async () => {
    const dir = await makeFicha(`
agent:
  id: min-001
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
`);
    const profile = await readFichaProfile(dir);
    expect(profile.agent?.id).toBe("min-001");
    expect(profile.llm?.available).toBeUndefined();
    expect(profile.llm?.monthly_budget_usd).toBeUndefined();
  });

  it("returns undefined available and monthly_budget_usd when those fields are absent (SPEC-FICHA-1-A)", async () => {
    const dir = await makeFicha(`
agent:
  id: no-extras-001
llm:
  default:
    provider: openai
    model: gpt-4o-mini
`);
    const profile = await readFichaProfile(dir);
    expect(profile.llm?.available).toBeUndefined();
    expect(profile.llm?.monthly_budget_usd).toBeUndefined();
    expect(profile.llm?.fallback_on_error).toBeUndefined();
  });

  // SPEC-FICHA-1-B — full ficha
  it("parses full ficha: agent.id + llm.available[] with 3 entries + monthly_budget_usd (SPEC-FICHA-1-B)", async () => {
    const dir = await makeFicha(`
agent:
  id: finanzas-001
  name: "Asistente Financiero"
  email: finanzas@example.com
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  available:
    - provider: anthropic
      model: claude-sonnet-4-6
      thinkingLevel: medium
      label: "Sonnet (default)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      label: "Opus (deep reasoning)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: custom
      model: llama3.1:70b
      label: "Llama local"
      baseUrl: http://localhost:11434
  monthly_budget_usd: 50
  fallback_on_error: true
`);
    const profile = await readFichaProfile(dir);
    expect(profile.agent?.id).toBe("finanzas-001");
    expect(profile.agent?.name).toBe("Asistente Financiero");
    expect(profile.agent?.email).toBe("finanzas@example.com");
    expect(profile.llm?.available).toHaveLength(3);
    expect(profile.llm?.monthly_budget_usd).toBe(50);
    expect(profile.llm?.fallback_on_error).toBe(true);
  });

  it("maps available[] entries to FichaModelEntry shape (provider, modelId, thinkingLevel, label, credentialEnv, baseUrl)", async () => {
    const dir = await makeFicha(`
agent:
  id: test-001
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  available:
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      label: "Opus"
      credentials_env: ANTHROPIC_API_KEY
    - provider: custom
      model: llama3.1:70b
      label: "Llama"
      baseUrl: http://localhost:11434
`);
    const profile = await readFichaProfile(dir);
    const entries = profile.llm?.available ?? [];
    expect(entries).toHaveLength(2);

    // noUncheckedIndexedAccess: assert non-null after length check
    const opus = entries[0]!;
    expect(opus.provider).toBe("anthropic");
    expect(opus.modelId).toBe("claude-opus-4-7");
    expect(opus.thinkingLevel).toBe("high");
    expect(opus.label).toBe("Opus");
    expect(opus.credentialEnv).toBe("ANTHROPIC_API_KEY");
    expect(opus.baseUrl).toBeUndefined();

    const llama = entries[1]!;
    expect(llama.provider).toBe("custom");
    expect(llama.modelId).toBe("llama3.1:70b");
    expect(llama.thinkingLevel).toBeUndefined();
    expect(llama.label).toBe("Llama");
    expect(llama.credentialEnv).toBeUndefined();
    expect(llama.baseUrl).toBe("http://localhost:11434");
  });

  // SPEC-FICHA-1-C — agent.id absent fallback
  it("returns undefined agent.id and does not throw when agent block is absent (SPEC-FICHA-1-C)", async () => {
    const dir = await makeFicha(`
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
`);
    const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const profile = await readFichaProfile(dir);
      expect(profile.agent?.id).toBeUndefined();
      // Callers should derive slug from path.basename(fichaDir); no error thrown
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("emits a warning to stderr when agent.id is absent (SPEC-FICHA-1-C)", async () => {
    const dir = await makeFicha(`
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
`);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      await readFichaProfile(dir);
      expect(warnings.some((w) => /agent\.id/i.test(w) || /agent id/i.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("still parses llm.default when agent block is absent", async () => {
    const dir = await makeFicha(`
llm:
  default:
    provider: openai
    model: gpt-4o-mini
`);
    // We don't care about the warning here — just that it doesn't throw
    const profile = await readFichaProfile(dir);
    expect(profile.llm?.default).toBeDefined();
  });

  // Passthrough: unknown fields in llm block should not cause parse failure
  it("passes through unknown llm fields (zod passthrough preserved)", async () => {
    const dir = await makeFicha(`
agent:
  id: pass-001
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
  some_future_field: 42
`);
    // Should not throw — passthrough means unknown fields are allowed
    const profile = await readFichaProfile(dir);
    expect(profile.agent?.id).toBe("pass-001");
  });
});
