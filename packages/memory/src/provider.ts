/**
 * provider.ts — MemoryProvider interface + MemoryEntry / MemorySearchHit types.
 *
 * Both FileBasedMemoryProvider and SqliteFtsMemoryProvider implement this
 * interface. The composition root (tui.ts) injects closures typed to this
 * interface into the builtin tools — @zia/tools never imports this module
 * directly (GOV-2).
 */

// ---------------------------------------------------------------------------
// MemoryEntry — shape returned by search
// ---------------------------------------------------------------------------

/**
 * A single memory entry as returned by `MemoryProvider.search()`.
 *
 * `id` is either the ISO-date header text (file provider) or the SQLite row id
 * in string form (sqlite provider). Callers should treat it as an opaque
 * identifier.
 */
export interface MemoryEntry {
  /** Opaque identifier (date header or row id string). */
  readonly id: string;
  /** Full text content of the entry (including header for file provider). */
  readonly content: string;
  /** ISO-8601 date string (YYYY-MM-DD or full datetime). */
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// MemorySearchHit — lightweight search result shape
// ---------------------------------------------------------------------------

/**
 * Lightweight search result returned by the file provider's scan path.
 * Also used by SqliteFtsMemoryProvider for FTS5 results.
 */
export interface MemorySearchHit {
  /** ISO date string from the entry header. */
  readonly date: string;
  /** Snippet of the entry body (may be truncated). */
  readonly snippet: string;
}

// ---------------------------------------------------------------------------
// MemoryProvider interface
// ---------------------------------------------------------------------------

/**
 * Unified interface for all zia memory backends.
 *
 * - `write`: append one dated entry, enforce the 50k char cap atomically.
 * - `search`: full-text (or substring) search, newest-first, capped at `limit`.
 *
 * The `now` parameter on `write` is optional so tests can inject a fixed date.
 */
export interface MemoryProvider {
  /**
   * Append a new entry to memory with the current UTC date as header.
   *
   * If the total character count after appending would exceed the cap,
   * the oldest whole entries are evicted until the content fits.
   *
   * @param body  Entry body text (trimmed before writing).
   * @param now   Optional date override for tests.
   */
  write(body: string, now?: Date): Promise<void>;

  /**
   * Search memory for entries matching the query.
   *
   * File provider: case-insensitive substring match.
   * SQLite provider: FTS5 MATCH via sanitizeFtsQuery.
   *
   * Returns entries newest-first, limited to `limit` results (default 20).
   */
  search(query: string, limit?: number): Promise<MemorySearchHit[]>;
}
