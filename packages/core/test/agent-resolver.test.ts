import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createZiaAgent } from "../src/agent.ts";

/**
 * Integration assertions for `createZiaAgent`'s ficha-driven configuration.
 * We test the failure paths (missing credential, missing SOUL.md) since the
 * happy path requires a real pi.dev session and is covered by manual
 * verification + the resolver/prompt-builder unit tests.
 */
describe("createZiaAgent — ficha-driven configuration", () => {
  let createdDirs: string[] = [];
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function makeFicha(profileYaml: string, soulMd?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-core-agent-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "profile.yaml"), profileYaml, "utf8");
    if (soulMd !== undefined) {
      await writeFile(join(dir, "SOUL.md"), soulMd, "utf8");
    }
    return dir;
  }

  it("surfaces a credential-missing error naming the env var declared in the ficha", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const fichaDir = await makeFicha(
      `llm:\n  default:\n    provider: openai\n    model: gpt-4o-mini\n`,
      "# soul\n",
    );

    await expect(createZiaAgent({ fichaDir })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("surfaces a missing-SOUL.md error from the prompt builder", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fichaDir = await makeFicha(
      `llm:\n  default:\n    provider: openai\n    model: gpt-4o-mini\n`,
      // no SOUL.md
    );

    await expect(createZiaAgent({ fichaDir })).rejects.toThrow(/SOUL\.md/);
  });

  it("surfaces an unknown-provider error from the resolver", async () => {
    const fichaDir = await makeFicha(
      `llm:\n  default:\n    provider: made-up\n    model: x\n`,
      "# soul\n",
    );

    await expect(createZiaAgent({ fichaDir })).rejects.toThrow(/made-up/);
  });
});
