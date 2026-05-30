/**
 * message-store.test.ts — SqliteMessageStore tests (A.5, SPEC-F4-3, SPEC-F4-4).
 *
 * Uses temp-dir file DBs (WAL + FTS5 trigger behavior requires real files).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-msgstore-"));
}

// ---------------------------------------------------------------------------

describe("SqliteMessageStore — record() and FTS indexing (SPEC-F4-3)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("(a) returns a positive integer id via SELECT after insert", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "a.db"));
    const store = new SqliteMessageStore(db);

    store.record({
      sessionKey: "s1",
      role: "user",
      content: "hello world",
      toolName: null,
      timestamp: new Date().toISOString(),
    });

    const row = db
      .prepare("SELECT id FROM messages WHERE session_key='s1'")
      .get() as { id: number } | undefined;

    expect(row).toBeDefined();
    expect(typeof row!.id).toBe("number");
    expect(row!.id).toBeGreaterThan(0);

    db.close();
  });

  it("(b) SELECT count(*) FROM messages = 1 after one record()", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "b.db"));
    const store = new SqliteMessageStore(db);

    store.record({
      sessionKey: "s2",
      role: "assistant",
      content: "I can help with that",
      toolName: null,
      timestamp: new Date().toISOString(),
    });

    const { cnt } = db
      .prepare("SELECT COUNT(*) as cnt FROM messages")
      .get() as { cnt: number };

    expect(cnt).toBe(1);

    db.close();
  });

  it("(c) FTS5 MATCH hit for exact token", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "c.db"));
    const store = new SqliteMessageStore(db);

    store.record({
      sessionKey: "s3",
      role: "user",
      content: "please approve the invoice",
      toolName: null,
      timestamp: new Date().toISOString(),
    });

    const { cnt } = db
      .prepare("SELECT COUNT(*) as cnt FROM messages_fts WHERE messages_fts MATCH '\"invoice\"'")
      .get() as { cnt: number };

    expect(cnt).toBe(1);

    db.close();
  });
});

// ---------------------------------------------------------------------------

describe("SqliteMessageStore — search() (SPEC-F4-4)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns results matching a token query", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "search1.db"));
    const store = new SqliteMessageStore(db);

    store.record({
      sessionKey: "s",
      role: "user",
      content: "approve the invoice",
      toolName: null,
      timestamp: "2026-01-01T00:00:00Z",
    });
    store.record({
      sessionKey: "s",
      role: "assistant",
      content: "reject the invoice",
      toolName: null,
      timestamp: "2026-01-01T00:01:00Z",
    });
    store.record({
      sessionKey: "s",
      role: "user",
      content: "unrelated message",
      toolName: null,
      timestamp: "2026-01-01T00:02:00Z",
    });

    const hits = store.search("invoice", 10);
    expect(hits.length).toBe(2);

    const contents = hits.map((h) => h.content);
    expect(contents.some((c) => c.includes("approve"))).toBe(true);
    expect(contents.some((c) => c.includes("reject"))).toBe(true);

    db.close();
  });

  it("contentSnippet is truncated to ≤200 chars (SPEC-F4-4)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "search2.db"));
    const store = new SqliteMessageStore(db);

    const longContent = "invoice " + "x".repeat(300);
    store.record({
      sessionKey: "s",
      role: "user",
      content: longContent,
      toolName: null,
      timestamp: new Date().toISOString(),
    });

    const hits = store.search("invoice", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.content.length).toBeLessThanOrEqual(200);

    db.close();
  });

  it("FTS5 operator injection: query 'invoice AND receipt' does NOT throw (SPEC-F4-4)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "search3.db"));
    const store = new SqliteMessageStore(db);

    store.record({
      sessionKey: "s",
      role: "user",
      content: "invoice receipt approved",
      toolName: null,
      timestamp: new Date().toISOString(),
    });

    // Must not throw; sanitizer wraps tokens in double-quotes
    let hits: ReturnType<typeof store.search>;
    expect(() => {
      hits = store.search("invoice AND receipt", 10);
    }).not.toThrow();

    // The sanitized query treats AND as a literal token; result may be empty
    // or non-empty but MUST NOT throw
    expect(Array.isArray(hits!)).toBe(true);

    db.close();
  });

  it("returns empty array when query is blank", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "search4.db"));
    const store = new SqliteMessageStore(db);

    const hits = store.search("   ", 10);
    expect(hits).toEqual([]);

    db.close();
  });
});

// ---------------------------------------------------------------------------

describe("SqliteMessageStore — record() never throws on DB close (SPEC-F4-4 / AQ-10)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("record() swallows error when DB is closed mid-write, never rejects", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SqliteMessageStore } = await import("../src/message-store.ts");

    const db = openDatabase(join(tempDir, "closed.db"));
    const store = new SqliteMessageStore(db);

    // Close DB before record — simulates mid-write failure
    db.close();

    // Must not throw
    expect(() => {
      store.record({
        sessionKey: "s",
        role: "user",
        content: "this should be swallowed",
        toolName: null,
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();
  });
});
