/**
 * file-based.ts — FileBasedMemoryProvider (SPEC-MEM-2, SPEC-MEM-3, SPEC-MEM-4, SPEC-MEM-8).
 *
 * Writes to a plain-text MEMORY.md file using node:fs/promises only.
 * Zero runtime imports from @zia/persistence or better-sqlite3 (GOV-4).
 *
 * ATOMICITY: write to a unique temp file then fs.rename() (POSIX rename is
 * atomic on the same filesystem). A crash mid-write leaves the original
 * MEMORY.md intact — readers (prompt-builder at next boot) never see a
 * half-written file. Temp file name includes pid + timestamp to avoid
 * collisions in test environments that share a tmp directory.
 *
 * SEARCH: scan-based, O(file size). Parses entries, case-insensitive substring
 * match against the full entry raw text, returns newest-first up to `limit`.
 * Fine at the 50k cap; use SqliteFtsMemoryProvider for heavy search workloads.
 */

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { applyCharLimit, DEFAULT_MEMORY_CHAR_LIMIT } from "./char-limit.ts";
import { formatEntry, isoDate, parseEntries } from "./entry-format.ts";
import type { MemoryProvider, MemorySearchHit } from "./provider.ts";

export class FileBasedMemoryProvider implements MemoryProvider {
  constructor(
    private readonly memoryPath: string,
    private readonly charLimit: number = DEFAULT_MEMORY_CHAR_LIMIT,
  ) {}

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  /**
   * Append a dated entry to MEMORY.md, enforcing the char limit.
   *
   * Steps:
   *  1. Read current content (ENOENT → "").
   *  2. Format the new entry with the current UTC date.
   *  3. Apply char-limit eviction.
   *  4. Atomic write (temp file + rename).
   */
  async write(body: string, now: Date = new Date()): Promise<void> {
    const existing = await this.readSafe();
    const entry = formatEntry(isoDate(now), body.trim());
    const next = applyCharLimit(existing, entry, this.charLimit);
    await this.atomicWrite(next);
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  /**
   * Scan MEMORY.md for entries containing `query` (case-insensitive substring).
   *
   * Returns MemorySearchHit[] ordered newest-first, up to `limit` results.
   * Returns [] if the file does not exist.
   */
  async search(query: string, limit = 20): Promise<MemorySearchHit[]> {
    const content = await this.readSafe();
    if (!content.trim()) return [];

    const lowerQuery = query.toLowerCase();
    const entries = parseEntries(content);

    // Newest-first: reverse a copy (parseEntries returns oldest-first).
    const reversed = [...entries].reverse();

    const hits: MemorySearchHit[] = [];
    for (const entry of reversed) {
      if (hits.length >= limit) break;
      if (entry.raw.toLowerCase().includes(lowerQuery)) {
        const date = entry.header.replace(/^# /, "") || "preamble";
        // Snippet: first 200 chars of the body (raw minus header line).
        const bodyLines = entry.raw.split("\n").slice(entry.header ? 1 : 0);
        const snippet = bodyLines.join("\n").trim().slice(0, 200);
        hits.push({ date, snippet });
      }
    }

    return hits;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Read the memory file; return "" on ENOENT. */
  private async readSafe(): Promise<string> {
    try {
      return await readFile(this.memoryPath, "utf8");
    } catch (err: unknown) {
      if (isEnoent(err)) return "";
      throw err;
    }
  }

  /**
   * Write `content` atomically: write to a unique temp file, then rename.
   * On rename failure the temp file is cleaned up best-effort.
   */
  private async atomicWrite(content: string): Promise<void> {
    const tmp = `${this.memoryPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, content, "utf8");
    try {
      await rename(tmp, this.memoryPath);
    } catch (err) {
      // Clean up the temp file best-effort; re-throw original error.
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
