/**
 * char-limit.ts — Deterministic whole-entry eviction algorithm (SPEC-MEM-4, ADR-M4).
 *
 * Pure functions, zero dependencies. Shared by FileBasedMemoryProvider and
 * SqliteFtsMemoryProvider (the sqlite provider mirrors this logic in-DB for
 * char_count rows, but uses this module for the combined-content path in tests).
 *
 * EVICTION ALGORITHM (8 steps, from ADR-M4):
 *  1. cap = limit ?? DEFAULT_MEMORY_CHAR_LIMIT
 *  2. combined = existing.trimEnd() + "\n\n" + newEntry
 *  3. If combined.length <= cap → return combined (common path, no alloc)
 *  4. Parse combined via parseEntries → [preamble?, e1(oldest), …, eN(newest)]
 *  5. While total > cap AND there is >1 evictable entry: drop the OLDEST
 *     evictable entry (lowest index AFTER the preamble), recompute total.
 *  6. Re-join preamble + remaining entries.
 *  7. EDGE: if single new entry alone (+ preamble) still exceeds cap after
 *     evicting everything else → keep it anyway (newest-write-wins; never
 *     produce empty memory). The 100k prompt-builder safety net catches this.
 *  8. EDGE: empty existing → just return newEntry (no trimEnd join needed).
 */

import { parseEntries } from "./entry-format.ts";

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

/** Default maximum total characters stored in MEMORY.md / memory_entries. */
export const DEFAULT_MEMORY_CHAR_LIMIT = 50_000;

// ---------------------------------------------------------------------------
// applyCharLimit
// ---------------------------------------------------------------------------

/**
 * Append `newEntry` to `existing`, then evict the oldest whole `# YYYY-MM-DD`
 * entries until the total character count is within `limit`.
 *
 * Rules:
 * - The sticky preamble (non-dated leading text) is NEVER evicted.
 * - Eviction always removes WHOLE entries; never partial.
 * - If a single new entry + preamble alone exceeds the cap, it is kept anyway
 *   (newest-write-wins edge case — prevents losing the just-written lesson).
 * - Returns the new content string ready to write to disk / insert into DB.
 *
 * @param existing  Current MEMORY.md content (may be "").
 * @param newEntry  Pre-formatted entry string (output of `formatEntry`).
 * @param limit     Character cap. Defaults to `DEFAULT_MEMORY_CHAR_LIMIT`.
 */
export function applyCharLimit(
  existing: string,
  newEntry: string,
  limit: number = DEFAULT_MEMORY_CHAR_LIMIT,
): string {
  // Step 8 shortcut: empty existing
  if (!existing.trim()) {
    return newEntry;
  }

  // Step 2: combine
  const combined = existing.trimEnd() + "\n\n" + newEntry;

  // Step 3: fast path
  if (combined.length <= limit) {
    return combined;
  }

  // Step 4: parse into entries
  const entries = parseEntries(combined);

  // Separate preamble (header === "") from evictable dated entries.
  // preamble is always at index 0 if it exists.
  let preamble: string | null = null;
  let evictable: string[] = [];

  for (const entry of entries) {
    if (entry.header === "") {
      preamble = entry.raw;
    } else {
      evictable.push(entry.raw);
    }
  }

  // Step 5: evict oldest entries until under cap (keep at least 1 evictable)
  while (evictable.length > 1) {
    const total = (preamble?.length ?? 0) + evictable.reduce((s, e) => s + e.length, 0);
    if (total <= limit) break;
    evictable = evictable.slice(1); // drop oldest
  }

  // Step 6 + 7: re-join (keep newest-write even if still over cap)
  const parts: string[] = [];
  if (preamble !== null) {
    parts.push(preamble.trimEnd());
  }
  for (const e of evictable) {
    parts.push(e.trimEnd());
  }

  return parts.join("\n\n") + "\n";
}
