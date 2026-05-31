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

  it("recognizes a catalog provider the old hardcoded switch omitted (opencode-go)", async () => {
    // opencode-go + amazon-bedrock were missing from agent.ts's defaultCredentialEnv
    // switch; credential env now comes from the @zia/providers catalog, so the
    // env-var name is resolved for every api-key provider, not just the common ones.
    delete process.env.OPENCODE_GO_API_KEY;
    const fichaDir = await makeFicha(
      `llm:\n  default:\n    provider: opencode-go\n    model: kimi-k2.5\n`,
      "# soul\n",
    );

    await expect(createZiaAgent({ fichaDir })).rejects.toThrow(/OPENCODE_GO_API_KEY/);
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

  it("fails early with a `zia model` hint when an OAuth provider has no auth.json", async () => {
    // Point AuthStorage at an empty dir so `hasAuth` is deterministically false
    // regardless of any real ~/.pi/agent/auth.json on the host.
    const emptyAgentDir = await mkdtemp(join(tmpdir(), "zia-pi-agent-"));
    createdDirs.push(emptyAgentDir);
    process.env.PI_CODING_AGENT_DIR = emptyAgentDir;

    const fichaDir = await makeFicha(
      `llm:\n  default:\n    provider: github-copilot\n    model: claude-sonnet-4.5\n`,
      "# soul\n",
    );

    await expect(createZiaAgent({ fichaDir })).rejects.toThrow(
      /github-copilot.*needs an OAuth login.*agent-runtime model.*to authenticate/s,
    );
  });
});
