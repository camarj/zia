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

  // PB-SC-2 (was "returns SOUL.md contents verbatim" — updated for role-tagged header)
  it("wraps SOUL.md in an IDENTITY header when only SOUL.md is present", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    const body = "# I am a test agent\n\nI speak only in lowercase.\n";
    await writeFile(join(fichaDir, "SOUL.md"), body, "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).toBe(`# IDENTITY (SOUL)\n\n${body.trim()}`);
    expect(result).not.toContain("# GOVERNANCE POLICIES");
    expect(result).not.toContain("# KNOWLEDGE");
    expect(result).not.toContain("# MEMORY");
  });

  // PB-SC-3 (unchanged — rejects with path when SOUL.md is absent)
  it("rejects with an error naming the missing path when SOUL.md is absent", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    const expectedPath = join(fichaDir, "SOUL.md");

    await expect(buildPromptFromFicha(fichaDir)).rejects.toThrow(expectedPath);
  });

  // PB-SC-1: All four files present — correct order and headers
  it("PB-SC-1: assembles all four sections in order with role-tagged headers", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);

    await writeFile(join(fichaDir, "SOUL.md"), "soul content", "utf8");
    await writeFile(join(fichaDir, "POLICIES.md"), "policies content", "utf8");
    await writeFile(join(fichaDir, "KNOWLEDGE.md"), "knowledge content", "utf8");
    await writeFile(join(fichaDir, "MEMORY.md"), "memory content", "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).toMatch(/^# IDENTITY \(SOUL\)/);

    const iSoul = result.indexOf("# IDENTITY (SOUL)");
    const iPolicies = result.indexOf("# GOVERNANCE POLICIES");
    const iKnowledge = result.indexOf("# KNOWLEDGE");
    const iMemory = result.indexOf("# MEMORY (snapshot)");

    expect(iSoul).toBeGreaterThanOrEqual(0);
    expect(iPolicies).toBeGreaterThan(iSoul);
    expect(iKnowledge).toBeGreaterThan(iPolicies);
    expect(iMemory).toBeGreaterThan(iKnowledge);

    expect(result).toContain("soul content");
    expect(result).toContain("policies content");
    expect(result).toContain("knowledge content");
    expect(result).toContain("memory content");

    // exactly one blank line between segments (\\n\\n, not \\n\\n\\n)
    expect(result).not.toMatch(/\n\n\n/);
  });

  // PB-SC-4: SOUL.md present but empty → throws with path
  it("PB-SC-4: rejects when SOUL.md is whitespace-only", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    await writeFile(join(fichaDir, "SOUL.md"), "   \n  \n", "utf8");

    await expect(buildPromptFromFicha(fichaDir)).rejects.toThrow(
      join(fichaDir, "SOUL.md")
    );
  });

  // PB-SC-5: POLICIES.md empty → skipped
  it("PB-SC-5: skips POLICIES.md when it is empty (0 bytes)", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    await writeFile(join(fichaDir, "SOUL.md"), "soul content", "utf8");
    await writeFile(join(fichaDir, "POLICIES.md"), "", "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).not.toContain("# GOVERNANCE POLICIES");
  });

  // PB-SC-6: KNOWLEDGE.md absent → skipped
  it("PB-SC-6: skips # KNOWLEDGE when KNOWLEDGE.md is absent", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    await writeFile(join(fichaDir, "SOUL.md"), "soul content", "utf8");
    await writeFile(join(fichaDir, "POLICIES.md"), "policies content", "utf8");
    // no KNOWLEDGE.md

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).not.toContain("# KNOWLEDGE");
  });

  // PB-SC-7: MEMORY.md whitespace-only → skipped
  it("PB-SC-7: skips # MEMORY when MEMORY.md is whitespace-only", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    await writeFile(join(fichaDir, "SOUL.md"), "soul content", "utf8");
    await writeFile(join(fichaDir, "MEMORY.md"), "\n   \n", "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).not.toContain("# MEMORY");
  });

  // PB-SC-8: Oversized KNOWLEDGE.md — truncated, not thrown
  it("PB-SC-8: truncates oversized KNOWLEDGE.md and does NOT throw", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    await writeFile(join(fichaDir, "SOUL.md"), "soul content", "utf8");
    const bigContent = "k".repeat(100_001);
    await writeFile(join(fichaDir, "KNOWLEDGE.md"), bigContent, "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).toContain("# KNOWLEDGE");
    const knowledgeIdx = result.indexOf("# KNOWLEDGE");
    const knowledgeSection = result.slice(knowledgeIdx);
    // The 100k chars + [TRUNCATED] marker must be present (exact spec format)
    expect(knowledgeSection).toContain("\n [TRUNCATED]");
    // The truncated body is exactly 100_000 chars of "k"
    expect(knowledgeSection).toContain("k".repeat(100_000));
    // The 100_001st char must NOT appear (i.e. we don't have 100_001 k's in a row)
    expect(knowledgeSection).not.toContain("k".repeat(100_001));
  });

  // PB-SC-9: Oversized SOUL.md — truncated, not thrown
  it("PB-SC-9: truncates oversized SOUL.md and does NOT throw", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    const bigSoul = "s".repeat(100_001);
    await writeFile(join(fichaDir, "SOUL.md"), bigSoul, "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).toMatch(/^# IDENTITY \(SOUL\)/);
    expect(result).toContain("[TRUNCATED]");
    expect(result).toContain("s".repeat(100_000));
    expect(result).not.toContain("s".repeat(100_001));
  });

  // PB-SC-10: Section order SOUL → KNOWLEDGE → MEMORY when POLICIES absent
  it("PB-SC-10: KNOWLEDGE appears before MEMORY when POLICIES.md is absent", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    await writeFile(join(fichaDir, "SOUL.md"), "soul content", "utf8");
    await writeFile(join(fichaDir, "KNOWLEDGE.md"), "knowledge content", "utf8");
    await writeFile(join(fichaDir, "MEMORY.md"), "memory content", "utf8");

    const result = await buildPromptFromFicha(fichaDir);

    expect(result).not.toContain("# GOVERNANCE POLICIES");
    const iKnowledge = result.indexOf("# KNOWLEDGE");
    const iMemory = result.indexOf("# MEMORY (snapshot)");
    expect(iKnowledge).toBeGreaterThanOrEqual(0);
    expect(iMemory).toBeGreaterThan(iKnowledge);
  });
});
