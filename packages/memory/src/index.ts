/**
 * index.ts — @zia/memory public barrel (SPEC-MEM-1).
 *
 * Exports everything the composition root (tui.ts) and tests need.
 * @zia/tools and @zia/core MUST NOT import from this barrel (GOV-1, GOV-2).
 */

export type { MemoryProvider, MemoryEntry, MemorySearchHit } from "./provider.ts";
export { FileBasedMemoryProvider } from "./file-based.ts";
export { SqliteFtsMemoryProvider } from "./sqlite-fts.ts";
export { DEFAULT_MEMORY_CHAR_LIMIT, applyCharLimit } from "./char-limit.ts";
export { formatEntry, isoDate, parseEntries } from "./entry-format.ts";
export type { ParsedEntry } from "./entry-format.ts";
