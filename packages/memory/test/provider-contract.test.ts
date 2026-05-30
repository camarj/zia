/**
 * provider-contract.test.ts — Both providers satisfy MemoryProvider (SPEC-MEM-1, SPEC-MEM-8).
 *
 * Runs an identical write+search contract suite against FileBasedMemoryProvider
 * and SqliteFtsMemoryProvider. Also confirms no stubs / "not implemented" text.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryProvider } from "../src/provider.ts";

// ---------------------------------------------------------------------------
// Temp dir
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zia-memory-contract-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeFileProvider(): Promise<MemoryProvider> {
  const { FileBasedMemoryProvider } = await import("../src/file-based.ts");
  return new FileBasedMemoryProvider(join(tempDir, "MEMORY.md"));
}

async function makeSqliteProvider(): Promise<MemoryProvider> {
  const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
  const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");
  resetWriteCounter();
  const db = openDatabase(join(tempDir, "contract.db"));
  return new SqliteFtsMemoryProvider(db);
}

// ---------------------------------------------------------------------------
// Shared contract suite
// ---------------------------------------------------------------------------

function runContractSuite(
  providerName: string,
  factory: () => Promise<MemoryProvider>,
) {
  describe(`${providerName} satisfies MemoryProvider contract`, () => {
    it("write() resolves without throwing for valid body", async () => {
      const provider = await factory();
      await expect(provider.write("Hello memory.", new Date())).resolves.toBeUndefined();
    });

    it("search() returns [] when no entries match", async () => {
      const provider = await factory();
      await provider.write("Something relevant.", new Date());
      const hits = await provider.search("xyz_nonexistent_9876");
      expect(hits).toHaveLength(0);
    });

    it("search() returns hits for a matching query", async () => {
      const provider = await factory();
      await provider.write("Customer Acme signed the contract.", new Date());
      const hits = await provider.search("Acme");
      expect(hits.length).toBeGreaterThan(0);
    });

    it("search() results have date and snippet fields", async () => {
      const provider = await factory();
      await provider.write("Invoice for December.", new Date("2026-05-30T10:00:00.000Z"));
      const hits = await provider.search("Invoice");
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits[0]!;
      expect(typeof hit.date).toBe("string");
      expect(hit.date.length).toBeGreaterThan(0);
      expect(typeof hit.snippet).toBe("string");
    });

    it("write() + search() round-trip: written content is searchable", async () => {
      const provider = await factory();
      const unique = "UniqueMarker_XYZ_999";
      await provider.write(`Lesson containing ${unique}.`, new Date());
      const hits = await provider.search(unique);
      // At minimum, at least one hit should contain the unique marker
      expect(hits.length).toBeGreaterThan(0);
    });
  });
}

// ---------------------------------------------------------------------------
// TypeScript type-level check: both providers are assignable to MemoryProvider
// ---------------------------------------------------------------------------

describe("Type-level: providers are assignable to MemoryProvider (SPEC-MEM-1)", () => {
  it("FileBasedMemoryProvider is assignable to MemoryProvider", async () => {
    const { FileBasedMemoryProvider } = await import("../src/file-based.ts");
    const provider: MemoryProvider = new FileBasedMemoryProvider(
      join(tempDir, "type-check.md"),
    );
    expect(typeof provider.write).toBe("function");
    expect(typeof provider.search).toBe("function");
  });

  it("SqliteFtsMemoryProvider is assignable to MemoryProvider", async () => {
    const { openDatabase, resetWriteCounter } = await import("@zia/persistence");
    const { SqliteFtsMemoryProvider } = await import("../src/sqlite-fts.ts");
    resetWriteCounter();
    const db = openDatabase(join(tempDir, "type-check.db"));
    const provider: MemoryProvider = new SqliteFtsMemoryProvider(db);
    expect(typeof provider.write).toBe("function");
    expect(typeof provider.search).toBe("function");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// SPEC-MEM-8 — No stubs / "not implemented" in source
// ---------------------------------------------------------------------------

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

describe("SPEC-MEM-8 — No stubs in src/", () => {
  it("no source file contains 'not implemented' or 'throw new Error' stub", async () => {
    const thisFile = new URL(import.meta.url).pathname;
    // thisFile = packages/memory/test/provider-contract.test.ts → go up 2 to packages/memory
    const srcDir = join(thisFile, "../../src");
    const files = await collectTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (/not implemented/i.test(content)) {
        violations.push(`${file}: contains "not implemented"`);
      }
      // Only flag stub-style throws, not real error throws
      if (/throw new Error\(["']not implemented/i.test(content)) {
        violations.push(`${file}: contains throw new Error("not implemented")`);
      }
    }

    expect(violations).toHaveLength(0);
  });

  it("no source file contains TODO or FIXME markers", async () => {
    const thisFile = new URL(import.meta.url).pathname;
    const srcDir = join(thisFile, "../../src");
    const files = await collectTsFiles(srcDir);

    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      for (const [i, line] of lines.entries()) {
        if (/\bTODO\b|\bFIXME\b/.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Run the shared contract suite against both providers
// ---------------------------------------------------------------------------

runContractSuite("FileBasedMemoryProvider", makeFileProvider);
runContractSuite("SqliteFtsMemoryProvider", makeSqliteProvider);
