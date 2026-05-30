/**
 * entry-format.ts — Canonical entry serialization/parsing (SPEC-MEM-2, SPEC-MEM-5).
 *
 * Pure functions, zero dependencies. All writes emit `# YYYY-MM-DD\n<body>\n`
 * entries; the eviction path splits on those same `# YYYY-MM-DD` headers.
 *
 * Multiple writes on the same date append as SEPARATE `# YYYY-MM-DD` blocks —
 * simpler eviction; no merge-into-existing-header parsing required.
 *
 * Parser rule: any leading non-header text (e.g. a `# Memoria del agente`
 * preamble + HTML comment) is a sticky preamble that is NEVER evicted. Only
 * `# YYYY-MM-DD` blocks are evictable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed memory entry (includes its header line in `raw`). */
export interface ParsedEntry {
  /**
   * The `# YYYY-MM-DD` header line, or `""` for the sticky preamble (leading
   * non-dated text).
   */
  readonly header: string;
  /** Full text of this entry including the header line and trailing newline. */
  readonly raw: string;
}

// ---------------------------------------------------------------------------
// isoDate — UTC date string
// ---------------------------------------------------------------------------

/**
 * Return the UTC date of `now` as `YYYY-MM-DD`.
 *
 * @param now  The Date to convert. Defaults to current time.
 */
export function isoDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// formatEntry — serialize one entry
// ---------------------------------------------------------------------------

/**
 * Produce one canonical memory entry: `# YYYY-MM-DD\n<trimmedBody>\n`.
 *
 * @param date  ISO date string, e.g. `"2026-05-30"`.
 * @param body  Entry body text. Leading/trailing whitespace is trimmed.
 */
export function formatEntry(date: string, body: string): string {
  return `# ${date}\n${body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// parseEntries — split MEMORY.md text into ParsedEntry[]
// ---------------------------------------------------------------------------

/** Regex that matches a `# YYYY-MM-DD` line at the start of a line. */
const DATE_HEADER_RE = /^# \d{4}-\d{2}-\d{2}$/m;

/**
 * Split raw MEMORY.md content into discrete `ParsedEntry` items.
 *
 * Splitting rules:
 * - Split on lines matching `# YYYY-MM-DD` (anchor = start of line).
 * - Any text BEFORE the first dated header is treated as a sticky preamble
 *   entry with `header: ""`. The preamble is never evicted.
 * - Each `# YYYY-MM-DD` block becomes one entry with `header: "# YYYY-MM-DD"`.
 * - Entries are returned in document order (oldest first).
 *
 * @param content  Raw MEMORY.md string.
 * @returns        Array of `ParsedEntry`, possibly empty.
 */
export function parseEntries(content: string): ParsedEntry[] {
  if (!content.trim()) return [];

  // Split on date-header boundaries, keeping the delimiter (positive lookahead).
  const parts = content.split(/(?=^# \d{4}-\d{2}-\d{2}$)/m);

  const entries: ParsedEntry[] = [];

  for (const part of parts) {
    if (!part) continue;

    const firstLine = part.split("\n")[0] ?? "";
    if (DATE_HEADER_RE.test(firstLine)) {
      entries.push({ header: firstLine, raw: part });
    } else {
      // Non-dated leading text = preamble (header = "")
      // Only emit a preamble entry if it has actual content.
      if (part.trim()) {
        entries.push({ header: "", raw: part });
      }
    }
  }

  return entries;
}
