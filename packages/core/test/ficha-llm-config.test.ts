import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadFichaLlmConfig } from "../src/ficha-llm-config.ts";

describe("loadFichaLlmConfig", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function makeFicha(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "profile.yaml"), yaml, "utf8");
    return dir;
  }

  it("reads provider/model and infers credentials_env from the default map", async () => {
    const fichaDir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
`);
    const cfg = await loadFichaLlmConfig(fichaDir);
    expect(cfg).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
      credentialsEnv: "OPENAI_API_KEY",
      thinkingLevel: undefined,
    });
  });

  it("honors an explicit credentials_env override", async () => {
    const fichaDir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
    credentials_env: MY_CUSTOM_OPENAI_KEY
    thinkingLevel: high
`);
    const cfg = await loadFichaLlmConfig(fichaDir);
    expect(cfg.credentialsEnv).toBe("MY_CUSTOM_OPENAI_KEY");
    expect(cfg.thinkingLevel).toBe("high");
  });

  it("rejects when llm.default is missing", async () => {
    const fichaDir = await makeFicha(`llm:
  available: []
`);
    await expect(loadFichaLlmConfig(fichaDir)).rejects.toThrow(/llm\.default/);
  });

  it("rejects when provider has no known credentials_env and none was declared", async () => {
    const fichaDir = await makeFicha(`llm:
  default:
    provider: some-future-provider
    model: m1
`);
    await expect(loadFichaLlmConfig(fichaDir)).rejects.toThrow(/credentials env var/);
  });
});
