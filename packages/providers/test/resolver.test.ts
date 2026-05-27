import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveModelFromFicha } from "../src/resolver.ts";

describe("resolveModelFromFicha", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function makeFicha(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-providers-resolver-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "profile.yaml"), yaml, "utf8");
    return dir;
  }

  it("resolves a native provider (openai) into a pi.dev Model", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
`);
    const model = await resolveModelFromFicha(dir, { OPENAI_API_KEY: "sk-test" });
    expect(model.id).toBe("gpt-4o-mini");
    expect(model.provider).toBe("openai");
  });

  it("resolves a custom OpenAI-compatible endpoint", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: custom
    model: llama-3.1-8b
    baseUrl: http://localhost:11434/v1
`);
    const model = await resolveModelFromFicha(dir, {});
    expect(model.id).toBe("llama-3.1-8b");
    expect(model.provider).toBe("custom");
    expect(model.api).toBe("openai-completions");
    // The baseUrl field is the whole point of the custom path.
    expect((model as { baseUrl?: string }).baseUrl).toBe("http://localhost:11434/v1");
  });

  it("rejects when the provider is not in the catalog", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: made-up-provider
    model: x
`);
    await expect(resolveModelFromFicha(dir, {})).rejects.toThrow(/made-up-provider/);
  });

  it("rejects when the api-key credential env var is unset, naming the env var and zia model", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
`);
    await expect(resolveModelFromFicha(dir, {})).rejects.toThrow(
      /OPENAI_API_KEY.*zia model|zia model.*OPENAI_API_KEY/,
    );
  });

  it("honors a credentials_env override from the ficha", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
    credentials_env: MY_CUSTOM_OPENAI_KEY
`);
    // With override unset → error names the override, not OPENAI_API_KEY.
    await expect(resolveModelFromFicha(dir, {})).rejects.toThrow(/MY_CUSTOM_OPENAI_KEY/);

    // With override set → resolves cleanly.
    const model = await resolveModelFromFicha(dir, { MY_CUSTOM_OPENAI_KEY: "sk-test" });
    expect(model.id).toBe("gpt-4o-mini");
  });

  it("rejects when a custom provider is declared without baseUrl", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: custom
    model: llama-3.1-8b
`);
    await expect(resolveModelFromFicha(dir, {})).rejects.toThrow(/baseUrl/);
  });

  it("does not require credentials when provider is custom (caller may auth with the endpoint directly)", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: custom
    model: llama-3.1-8b
    baseUrl: http://localhost:11434/v1
`);
    const model = await resolveModelFromFicha(dir, {});
    expect(model.provider).toBe("custom");
  });
});
