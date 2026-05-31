export { openDatabase, incrementWriteCounter, resetWriteCounter } from "./db.ts";
export type { Database } from "./sqlite-shim.ts";
export { retryWithJitter } from "./retry.ts";
export type { RetryOptions } from "./retry.ts";
export { sanitizeFtsQuery } from "./fts.ts";
export {
  SCHEMA_VERSION,
  DDL_META,
  DDL_SESSIONS,
  DDL_AUDIT_ENTRIES,
  DDL_AUDIT_FTS,
  DDL_AUDIT_FTS_TRIGGERS,
  DDL_MESSAGES,
  DDL_MESSAGES_FTS,
  DDL_MESSAGES_FTS_TRIGGERS,
  DDL_MEMORY_ENTRIES,
  DDL_MEMORY_FTS,
  DDL_MEMORY_FTS_TRIGGERS,
} from "./schema.ts";
export { SessionStore, buildSessionKey } from "./session-store.ts";
export { SqliteAuditLog } from "./audit-store.ts";
export type { SearchableAuditLog } from "./audit-store.ts";
export type { SessionRecord, SessionKeyParts } from "./types.ts";
export { SqliteMessageStore } from "./message-store.ts";
export type { MessageStore, SessionMessageRecord, MessageSearchHit } from "./message-store.ts";
