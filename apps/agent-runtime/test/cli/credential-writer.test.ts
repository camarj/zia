import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { upsertCredential } from "../../src/cli/credential-writer.ts";

describe("upsertCredential", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function tmpAgentDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zia-credwriter-"));
    createdDirs.push(dir);
    return dir;
  }

  it("creates a new .env with the key when none exists, chmod 600", async () => {
    const dir = await tmpAgentDir();
    await upsertCredential(dir, "OPENAI_API_KEY", "sk-newvalue");
    const envPath = join(dir, ".env");
    const content = await readFile(envPath, "utf8");
    expect(content).toContain("OPENAI_API_KEY=sk-newvalue");

    const mode = (await stat(envPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves unrelated keys when upserting", async () => {
    const dir = await tmpAgentDir();
    const envPath = join(dir, ".env");
    await writeFile(
      envPath,
      "# my agent\nAGENT_SLACK_TOKEN=xoxb-existing\nOPENAI_API_KEY=sk-old\n",
      "utf8",
    );

    await upsertCredential(dir, "OPENAI_API_KEY", "sk-new");

    const content = await readFile(envPath, "utf8");
    expect(content).toContain("AGENT_SLACK_TOKEN=xoxb-existing");
    expect(content).toContain("OPENAI_API_KEY=sk-new");
    expect(content).not.toContain("sk-old");
    expect(content).toContain("# my agent");
  });

  it("appends the key when not previously present", async () => {
    const dir = await tmpAgentDir();
    const envPath = join(dir, ".env");
    await writeFile(envPath, "AGENT_SLACK_TOKEN=xoxb\n", "utf8");

    await upsertCredential(dir, "ANTHROPIC_API_KEY", "sk-ant-new");

    const content = await readFile(envPath, "utf8");
    expect(content).toContain("AGENT_SLACK_TOKEN=xoxb");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-new");
  });

  it("is idempotent — re-running with the same value yields the same file", async () => {
    const dir = await tmpAgentDir();
    await upsertCredential(dir, "OPENAI_API_KEY", "sk-stable");
    const first = await readFile(join(dir, ".env"), "utf8");

    await upsertCredential(dir, "OPENAI_API_KEY", "sk-stable");
    const second = await readFile(join(dir, ".env"), "utf8");

    expect(second).toBe(first);
  });

  it("re-applies chmod 600 even if the file already exists with looser perms", async () => {
    const dir = await tmpAgentDir();
    const envPath = join(dir, ".env");
    await writeFile(envPath, "EXISTING=1\n", { mode: 0o644 });

    await upsertCredential(dir, "OPENAI_API_KEY", "sk-test");

    const mode = (await stat(envPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects empty or whitespace values to avoid silent credential blanking", async () => {
    const dir = await tmpAgentDir();
    await expect(upsertCredential(dir, "OPENAI_API_KEY", "")).rejects.toThrow(/empty/);
    await expect(upsertCredential(dir, "OPENAI_API_KEY", "   ")).rejects.toThrow(/empty/);
  });

  it("rejects invalid env-var names", async () => {
    const dir = await tmpAgentDir();
    await expect(upsertCredential(dir, "1BAD", "x")).rejects.toThrow(/env var name/);
    await expect(upsertCredential(dir, "WITH SPACE", "x")).rejects.toThrow(/env var name/);
  });
});
