import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readFichaLlm } from "../src/ficha.ts";

describe("readFichaLlm", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function makeFicha(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-providers-ficha-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "profile.yaml"), yaml, "utf8");
    return dir;
  }

  it("parses provider and model from llm.default", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
`);
    const result = await readFichaLlm(dir);
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o-mini");
    expect(result.credentialEnv).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("honors credentials_env override and thinkingLevel", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
    credentials_env: MY_KEY
    thinkingLevel: high
`);
    const result = await readFichaLlm(dir);
    expect(result.credentialEnv).toBe("MY_KEY");
    expect(result.thinkingLevel).toBe("high");
  });

  it("accepts baseUrl for custom provider entries", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: custom
    model: llama-3.1-8b
    baseUrl: http://localhost:11434/v1
`);
    const result = await readFichaLlm(dir);
    expect(result.provider).toBe("custom");
    expect(result.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("rejects when llm.default.model is missing", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
`);
    await expect(readFichaLlm(dir)).rejects.toThrow(/model/);
  });

  it("rejects when llm.default itself is missing", async () => {
    const dir = await makeFicha(`llm:
  available: []
`);
    await expect(readFichaLlm(dir)).rejects.toThrow(/llm\.default/);
  });

  it("parses llm.cacheRetention (F-CORE-7) at the llm level", async () => {
    const dir = await makeFicha(`llm:
  cacheRetention: long
  default:
    provider: anthropic
    model: claude-sonnet-4-6
`);
    const result = await readFichaLlm(dir);
    expect(result.cacheRetention).toBe("long");
  });

  it("accepts snake_case cache_retention", async () => {
    const dir = await makeFicha(`llm:
  cache_retention: short
  default:
    provider: anthropic
    model: claude-sonnet-4-6
`);
    const result = await readFichaLlm(dir);
    expect(result.cacheRetention).toBe("short");
  });

  it("leaves cacheRetention undefined when absent", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
`);
    const result = await readFichaLlm(dir);
    expect(result.cacheRetention).toBeUndefined();
  });

  it("rejects when cacheRetention is not one of the enum values", async () => {
    const dir = await makeFicha(`llm:
  cacheRetention: forever
  default:
    provider: anthropic
    model: claude-sonnet-4-6
`);
    await expect(readFichaLlm(dir)).rejects.toThrow(/cacheRetention/);
  });

  it("rejects when thinkingLevel is not one of the enum values", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
    thinkingLevel: ultraplus
`);
    await expect(readFichaLlm(dir)).rejects.toThrow(/thinkingLevel/);
  });

  it("rejects when baseUrl is not a parseable URL", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: custom
    model: llama-3.1-8b
    baseUrl: "not a url"
`);
    await expect(readFichaLlm(dir)).rejects.toThrow(/baseUrl/);
  });

  it("rejects when profile.yaml does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zia-providers-ficha-"));
    createdDirs.push(dir);
    await expect(readFichaLlm(dir)).rejects.toThrow(/profile\.yaml/);
  });
});
