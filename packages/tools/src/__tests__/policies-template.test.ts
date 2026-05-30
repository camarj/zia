/**
 * policies-template.test.ts — SPEC-POLICIES-1 guard.
 *
 * The shipped agent template (agents/_template/POLICIES.md) must classify every
 * builtin tool at its correct risk level, because the PolicyClassifier defaults
 * unknown tools to "alto" (default-deny). If an entry is dropped, that tool would
 * silently start blocking for approval. This test fails the build if the template
 * loses a required risk-level entry.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// file → __tests__ → src → tools → packages → repo root (5 levels up)
const monorepoRoot = join(new URL(import.meta.url).pathname, "../../../../..");
const POLICIES_PATH = join(monorepoRoot, "agents/_template/POLICIES.md");

async function sectionOf(content: string, heading: RegExp): Promise<string> {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##?\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("agents/_template/POLICIES.md — risk classification (SPEC-POLICIES-1)", () => {
  it("lists read/grep/find/ls/search_session/search_memory under Trivial", async () => {
    const content = await readFile(POLICIES_PATH, "utf8");
    const trivial = await sectionOf(content, /##\s+Trivial/);
    for (const tool of ["read", "grep", "find", "ls", "search_session", "search_memory"]) {
      expect(trivial, `${tool} must be under Trivial`).toContain(tool);
    }
  });

  it("lists write_memory under Medio", async () => {
    const content = await readFile(POLICIES_PATH, "utf8");
    const medio = await sectionOf(content, /##\s+Medio/);
    expect(medio, "write_memory must be under Medio").toContain("write_memory");
  });

  it("lists bash/write/edit under Alto", async () => {
    const content = await readFile(POLICIES_PATH, "utf8");
    const alto = await sectionOf(content, /##\s+Alto/);
    for (const tool of ["bash", "write", "edit"]) {
      expect(alto, `${tool} must be under Alto`).toContain(tool);
    }
  });
});
