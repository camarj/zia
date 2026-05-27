import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildPromptFromFicha } from "../src/prompt-builder.ts";

describe("buildPromptFromFicha", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  it("returns SOUL.md contents verbatim", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    const body = "# I am a test agent\n\nI speak only in lowercase.\n";
    await writeFile(join(fichaDir, "SOUL.md"), body, "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).toBe(body);
  });

  it("rejects with an error naming the missing path when SOUL.md is absent", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    const expectedPath = join(fichaDir, "SOUL.md");

    await expect(buildPromptFromFicha(fichaDir)).rejects.toThrow(expectedPath);
  });
});
