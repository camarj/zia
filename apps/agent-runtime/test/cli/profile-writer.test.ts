import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { clearProfileLlmField, updateProfileLlmDefault } from "../../src/cli/profile-writer.ts";

describe("updateProfileLlmDefault", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function makeFicha(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-profilewriter-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "profile.yaml"), yaml, "utf8");
    return dir;
  }

  it("updates provider, model, and thinkingLevel under llm.default", async () => {
    const dir = await makeFicha(`agent:
  id: test
llm:
  default:
    provider: openai
    model: gpt-4o-mini
    thinkingLevel: medium
`);

    await updateProfileLlmDefault(dir, {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      thinkingLevel: "high",
    });

    const content = await readFile(join(dir, "profile.yaml"), "utf8");
    const parsed = parse(content) as { llm: { default: Record<string, unknown> } };
    expect(parsed.llm.default.provider).toBe("anthropic");
    expect(parsed.llm.default.model).toBe("claude-sonnet-4-6");
    expect(parsed.llm.default.thinkingLevel).toBe("high");
  });

  it("preserves comments and unrelated keys in the file", async () => {
    const dir = await makeFicha(`# Header comment
agent:
  id: test
  name: "Test Agent" # inline comment

# block comment before llm
llm:
  # inside llm block
  default:
    provider: openai
    model: gpt-4o-mini
`);

    await updateProfileLlmDefault(dir, {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    const content = await readFile(join(dir, "profile.yaml"), "utf8");
    expect(content).toContain("# Header comment");
    expect(content).toContain("# inline comment");
    expect(content).toContain("# block comment before llm");
    expect(content).toContain("# inside llm block");
    expect(content).toContain('name: "Test Agent"');
  });

  it("writes credentials_env when provided (as snake_case in YAML)", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
`);

    await updateProfileLlmDefault(dir, {
      provider: "openai",
      modelId: "gpt-4o-mini",
      credentialEnv: "MY_OPENAI_KEY",
    });

    const content = await readFile(join(dir, "profile.yaml"), "utf8");
    expect(content).toMatch(/credentials_env:\s*MY_OPENAI_KEY/);
  });

  it("preserves credentials_env when not in the update (partial-update semantics)", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
    credentials_env: KEEP_ME
`);

    await updateProfileLlmDefault(dir, {
      provider: "openai",
      modelId: "gpt-4o-mini",
      // credentialEnv omitted on purpose — should be preserved
    });

    const content = await readFile(join(dir, "profile.yaml"), "utf8");
    expect(content).toMatch(/credentials_env:\s*KEEP_ME/);
  });

  it("preserves thinkingLevel when not in the update", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
    thinkingLevel: high
`);

    await updateProfileLlmDefault(dir, {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      // thinkingLevel omitted — should survive a provider change
    });

    const parsed = parse(await readFile(join(dir, "profile.yaml"), "utf8")) as {
      llm: { default: Record<string, unknown> };
    };
    expect(parsed.llm.default.thinkingLevel).toBe("high");
  });

  it("clearProfileLlmField removes a field explicitly", async () => {
    const dir = await makeFicha(`llm:
  default:
    provider: openai
    model: gpt-4o-mini
    thinkingLevel: medium
    credentials_env: SOME_KEY
`);

    await clearProfileLlmField(dir, "credentials_env");

    const content = await readFile(join(dir, "profile.yaml"), "utf8");
    expect(content).not.toContain("credentials_env");
    expect(content).toContain("thinkingLevel: medium");
  });

  it("creates llm.default if the file has llm: but no default", async () => {
    const dir = await makeFicha(`llm:
  available: []
`);

    await updateProfileLlmDefault(dir, {
      provider: "openai",
      modelId: "gpt-4o-mini",
    });

    const parsed = parse(await readFile(join(dir, "profile.yaml"), "utf8")) as {
      llm: { default: Record<string, unknown> };
    };
    expect(parsed.llm.default.provider).toBe("openai");
    expect(parsed.llm.default.model).toBe("gpt-4o-mini");
  });

  it("rejects when profile.yaml does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zia-profilewriter-"));
    createdDirs.push(dir);

    await expect(
      updateProfileLlmDefault(dir, { provider: "openai", modelId: "gpt-4o-mini" }),
    ).rejects.toThrow(/profile\.yaml/);
  });
});
