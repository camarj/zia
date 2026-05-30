/**
 * fts.ts — Shared FTS5 query sanitization.
 *
 * Extracted from audit-store.ts so both SqliteAuditLog and SqliteMessageStore
 * import from a single source — no duplication (SPEC-F4-4).
 */

/**
 * Wrap each whitespace-delimited token in double-quotes so FTS5 boolean
 * operators (AND, OR, NOT, NEAR, *, :) are treated as literal terms.
 *
 * Internal double-quotes inside a token are escaped by doubling them.
 *
 * Example:
 *   "send_email AND NOT query_linear" → '"send_email" "AND" "NOT" "query_linear"'
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}
