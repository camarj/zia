/**
 * dependency-direction.test.ts — SPEC-DEP-1 / SPEC-DEP-2 guardrail (agent-memory).
 *
 * @zia/tools and @zia/core MUST NOT import @zia/memory.
 *
 * Rationale: the memory tools (write_memory / search_memory) receive their
 * write/search capability by INJECTION from the composition root (apps/agent-runtime),
 * exactly like search_session receives its SessionSearchFn. This keeps @zia/tools and
 * @zia/core free of @zia/memory (and, transitively, of @zia/persistence + the native
 * better-sqlite3 addon), so they stay testable without the addon. The composition root
 * is the only allowed place to wire @zia/memory.
 *
 * This test runs as part of `pnpm test` so CI fails the moment the boundary is crossed.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Recursively collect all .ts files under a directory. */
async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      results.push(...(await collectTsFiles(full)));
    } else if (entry.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Return all lines in a file that import @zia/memory. */
async function memoryImportLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter(
      (line) =>
        /from\s+['"]@zia\/memory['"]/.test(line) ||
        /require\s*\(\s*['"]@zia\/memory['"]\s*\)/.test(line),
    );
}

// file → __tests__ → src → tools → packages → repo root  (5 levels up)
const thisFile = new URL(import.meta.url).pathname;
const monorepoRoot = join(thisFile, "../../../../..");

const BANNED_PACKAGES = [
  join(monorepoRoot, "packages/tools"),
  join(monorepoRoot, "packages/core"),
] as const;

describe("dependency-direction guard — @zia/memory (SPEC-DEP-1 / SPEC-DEP-2)", () => {
  for (const pkgDir of BANNED_PACKAGES) {
    const pkgName = pkgDir.split("/").slice(-2).join("/");

    it(`${pkgName}/package.json does not list @zia/memory as a dependency`, async () => {
      const pkgJson = JSON.parse(
        await readFile(join(pkgDir, "package.json"), "utf8"),
      ) as Record<string, unknown>;

      const deps = {
        ...((pkgJson["dependencies"] as Record<string, string> | undefined) ?? {}),
        ...((pkgJson["devDependencies"] as Record<string, string> | undefined) ?? {}),
        ...((pkgJson["peerDependencies"] as Record<string, string> | undefined) ?? {}),
      };

      expect(
        Object.keys(deps),
        `${pkgName}/package.json must not list @zia/memory`,
      ).not.toContain("@zia/memory");
    });

    it(`${pkgName}/src/**/*.ts contains no import of @zia/memory`, async () => {
      const srcDir = join(pkgDir, "src");
      const tsFiles = await collectTsFiles(srcDir);
      expect(tsFiles.length, `Expected at least one .ts file in ${srcDir}`).toBeGreaterThan(0);

      const violations: { file: string; lines: string[] }[] = [];
      for (const file of tsFiles) {
        const lines = await memoryImportLines(file);
        if (lines.length > 0) {
          violations.push({ file, lines });
        }
      }

      expect(
        violations,
        `Found @zia/memory imports in ${pkgName}/src — memory must be injected from the composition root (SPEC-DEP-1):\n` +
          violations
            .map((v) => `  ${v.file}:\n${v.lines.map((l) => `    ${l}`).join("\n")}`)
            .join("\n"),
      ).toHaveLength(0);
    });
  }
});
