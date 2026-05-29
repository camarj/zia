/**
 * dependency-direction.test.ts — SPEC-R14 / ADR-2 guardrail
 *
 * @zia/core and @zia/callbacks MUST NOT import @zia/persistence.
 *
 * Rationale: persistence pulls in native `better-sqlite3` (a Node.js native
 * addon). Any package that imports persistence transitively requires the
 * native addon, which makes that package untestable in environments without
 * the addon (e.g. a browser-targeted build or a plain vitest run that mocks
 * the SDK). The composition root (apps/agent-runtime) is the only allowed
 * entry point.
 *
 * This test enforces the ban as part of `pnpm test` so CI catches violations
 * the moment they are introduced — it will FAIL if any source file under
 * packages/core/ or packages/callbacks/ contains an import of @zia/persistence.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Return all lines in a file that reference @zia/persistence as an import. */
async function persistenceImportLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) =>
      // Match: import ... from "@zia/persistence"
      //        import type ... from "@zia/persistence"
      //        require("@zia/persistence")
      /from\s+['"]@zia\/persistence['"]/.test(line) ||
      /require\s*\(\s*['"]@zia\/persistence['"]\s*\)/.test(line),
    );
}

// ---------------------------------------------------------------------------
// Paths — resolved relative to this file's package root, not cwd (which may
// differ when vitest runs from the monorepo root).
// ---------------------------------------------------------------------------

// __filename is not available in ESM without import.meta.url
const thisFile = new URL(import.meta.url).pathname;
// packages/persistence/test/dependency-direction.test.ts
// → go up 4 levels (file → test → persistence → packages → repo root)
const monorepoRoot = join(thisFile, "../../../..");

const BANNED_PACKAGES = [
  join(monorepoRoot, "packages/core"),
  join(monorepoRoot, "packages/callbacks"),
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dependency-direction guard (SPEC-R14 / ADR-2)", () => {
  for (const pkgDir of BANNED_PACKAGES) {
    const pkgName = pkgDir.split("/").slice(-2).join("/");

    it(`${pkgName}/package.json does not list @zia/persistence as a dependency`, async () => {
      const pkgJson = JSON.parse(
        await readFile(join(pkgDir, "package.json"), "utf8"),
      ) as Record<string, unknown>;

      const deps = {
        ...(pkgJson["dependencies"] as Record<string, string> | undefined ?? {}),
        ...(pkgJson["devDependencies"] as Record<string, string> | undefined ?? {}),
        ...(pkgJson["peerDependencies"] as Record<string, string> | undefined ?? {}),
      };

      expect(
        Object.keys(deps),
        `${pkgName}/package.json must not list @zia/persistence`,
      ).not.toContain("@zia/persistence");
    });

    it(`${pkgName}/src/**/*.ts contains no import of @zia/persistence`, async () => {
      const srcDir = join(pkgDir, "src");
      const tsFiles = await collectTsFiles(srcDir);
      expect(tsFiles.length, `Expected at least one .ts file in ${srcDir}`).toBeGreaterThan(0);

      const violations: { file: string; lines: string[] }[] = [];
      for (const file of tsFiles) {
        const lines = await persistenceImportLines(file);
        if (lines.length > 0) {
          violations.push({ file, lines });
        }
      }

      expect(
        violations,
        `Found @zia/persistence imports in ${pkgName}/src — this violates the core→persistence ban (SPEC-R14):\n` +
          violations.map((v) => `  ${v.file}:\n${v.lines.map((l) => `    ${l}`).join("\n")}`).join("\n"),
      ).toHaveLength(0);
    });
  }
});
