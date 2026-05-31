/**
 * session-store.test.ts — RED tests for buildSessionKey + SessionStore
 *                          (SC-11..SC-14, SPEC-R3, SPEC-R12).
 *
 * Also covers the exit-handler stacking guard (review suggestion from PR1):
 * calling openDatabase twice in one process must not grow
 * process.listenerCount('exit').
 *
 * Uses temp-dir file DBs for WAL-real tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Helpers -----------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-session-"));
}

// -------------------------------------------------------------------------
// SC-11 — buildSessionKey format (SPEC-R12)
// -------------------------------------------------------------------------

describe("buildSessionKey — format (SC-11, SPEC-R12)", () => {
  it("returns 'agent:main:{platform}:{chatType}:{chatId}'", async () => {
    const { buildSessionKey } = await import("../src/session-store.ts");

    const key = buildSessionKey({
      platform: "slack",
      chatType: "channel",
      chatId: "C12345",
    });

    expect(key).toBe("agent:main:slack:channel:C12345");
  });

  it("works with tui/dm/local parts", async () => {
    const { buildSessionKey } = await import("../src/session-store.ts");

    const key = buildSessionKey({
      platform: "tui",
      chatType: "dm",
      chatId: "local",
    });

    expect(key).toBe("agent:main:tui:dm:local");
  });
});

// -------------------------------------------------------------------------
// SC-12 — buildSessionKey rejects colons (SPEC-R12)
// -------------------------------------------------------------------------

describe("buildSessionKey — colon guard (SC-12, SPEC-R12)", () => {
  it("throws when platform contains a colon", async () => {
    const { buildSessionKey } = await import("../src/session-store.ts");

    expect(() =>
      buildSessionKey({ platform: "slack:extra", chatType: "channel", chatId: "C1" }),
    ).toThrow();
  });

  it("throws when chatType contains a colon", async () => {
    const { buildSessionKey } = await import("../src/session-store.ts");

    expect(() =>
      buildSessionKey({ platform: "slack", chatType: "chan:nel", chatId: "C1" }),
    ).toThrow();
  });

  it("throws when chatId contains a colon", async () => {
    const { buildSessionKey } = await import("../src/session-store.ts");

    expect(() =>
      buildSessionKey({ platform: "slack", chatType: "channel", chatId: "C1:2" }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------
// SC-13 — SessionStore.createSession() + resolveByKey() round-trip
// -------------------------------------------------------------------------

describe("SessionStore.createSession() + resolveByKey() (SC-13)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns a record with a generated id and all fields matching input", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const store = new SessionStore(db);

    const created = store.createSession({
      sessionKey: "agent:main:tui:dm:local",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    // Generated id must be a non-empty string
    expect(typeof created.id).toBe("string");
    expect(created.id.length).toBeGreaterThan(0);

    // Resolve by key — must return same record
    const resolved = store.resolveByKey("agent:main:tui:dm:local");

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(created.id);
    expect(resolved!.sessionKey).toBe("agent:main:tui:dm:local");
    expect(resolved!.sourcePlatform).toBe("tui");
    expect(resolved!.modelConfig).toBe("{}");
    expect(resolved!.piSessionPath).toBeNull();
    expect(resolved!.startedAt).toBe("2025-01-01T00:00:00Z");
    expect(resolved!.endedAt).toBeNull();
    expect(resolved!.endReason).toBeNull();
    expect(resolved!.parentSessionId).toBeNull();

    db.close();
  });

  it("returns null when session key does not exist", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "test2.db"));
    const store = new SessionStore(db);

    const result = store.resolveByKey("agent:main:nonexistent:dm:local");
    expect(result).toBeNull();

    db.close();
  });
});

// -------------------------------------------------------------------------
// SC-14 — SessionStore.endSession()
// -------------------------------------------------------------------------

describe("SessionStore.endSession() (SC-14)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sets endedAt and endReason on the session", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const store = new SessionStore(db);

    const session = store.createSession({
      sessionKey: "agent:main:tui:dm:local",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    store.endSession(session.id, "graceful_shutdown");

    const resolved = store.resolveByKey("agent:main:tui:dm:local");

    expect(resolved).not.toBeNull();
    expect(resolved!.endedAt).not.toBeNull();
    expect(typeof resolved!.endedAt).toBe("string");
    // endedAt must be a valid ISO string
    expect(() => new Date(resolved!.endedAt!)).not.toThrow();
    expect(resolved!.endReason).toBe("graceful_shutdown");

    db.close();
  });
});

// -------------------------------------------------------------------------
// getLineage — flat parent chain, oldest first
// -------------------------------------------------------------------------

describe("SessionStore.getLineage() — flat parent chain", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array for a root session (no parent)", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "test.db"));
    const store = new SessionStore(db);

    const root = store.createSession({
      sessionKey: "agent:main:tui:dm:root",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    expect(store.getLineage(root.id)).toEqual([]);
    db.close();
  });

  it("returns flat parent chain oldest first for a child session", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "test2.db"));
    const store = new SessionStore(db);

    const grandparent = store.createSession({
      sessionKey: "agent:main:tui:dm:gp",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    const parent = store.createSession({
      sessionKey: "agent:main:tui:dm:parent",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2025-01-01T01:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: grandparent.id,
    });

    const child = store.createSession({
      sessionKey: "agent:main:tui:dm:child",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2025-01-01T02:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: parent.id,
    });

    const lineage = store.getLineage(child.id);

    // Oldest first: grandparent, then parent
    expect(lineage.length).toBe(2);
    expect(lineage[0]!.id).toBe(grandparent.id);
    expect(lineage[1]!.id).toBe(parent.id);

    db.close();
  });
});

// -------------------------------------------------------------------------
// SPEC-LINEAGE-4 — SessionStore.createSession records parentSessionId
// -------------------------------------------------------------------------

describe("SessionStore.createSession() — parentSessionId (SPEC-LINEAGE-4)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records parentSessionId when provided and returns it in the SessionRecord", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "lineage.db"));
    const store = new SessionStore(db);

    // Create parent
    const parent = store.createSession({
      sessionKey: "agent:main:tui:dm:parent",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    // Create child with parentSessionId set
    const child = store.createSession({
      sessionKey: "agent:main:tui:dm:child",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: parent.id,
    });

    // Returned record must have parentSessionId
    expect(child.parentSessionId).toBe(parent.id);

    // DB must also store it
    const row = db
      .prepare("SELECT parent_session_id FROM sessions WHERE id = ?")
      .get(child.id) as { parent_session_id: string } | undefined;
    expect(row?.parent_session_id).toBe(parent.id);

    db.close();
  });
});

// -------------------------------------------------------------------------
// SPEC-LINEAGE-4b — SessionStore.recordLineage() convenience method
// -------------------------------------------------------------------------

describe("SessionStore.recordLineage() (SPEC-LINEAGE-4b)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sets parent_session_id on an existing session row", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "rl.db"));
    const store = new SessionStore(db);

    const parent = store.createSession({
      sessionKey: "agent:main:tui:dm:p",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    const child = store.createSession({
      sessionKey: "agent:main:tui:dm:c",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null, // not set yet
    });

    // recordLineage links child → parent after creation
    store.recordLineage(child.id, parent.id);

    // Verify persisted
    const row = db
      .prepare("SELECT parent_session_id FROM sessions WHERE id = ?")
      .get(child.id) as { parent_session_id: string } | undefined;
    expect(row?.parent_session_id).toBe(parent.id);

    db.close();
  });

  it("is idempotent — calling twice with same args does not throw", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "rl2.db"));
    const store = new SessionStore(db);

    const parent = store.createSession({
      sessionKey: "agent:main:tui:dm:p2",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    const child = store.createSession({
      sessionKey: "agent:main:tui:dm:c2",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    expect(() => {
      store.recordLineage(child.id, parent.id);
      store.recordLineage(child.id, parent.id);
    }).not.toThrow();

    db.close();
  });
});

// -------------------------------------------------------------------------
// Exit-handler stacking guard (review suggestion from PR1)
// Calling openDatabase twice must not grow process.listenerCount('exit').
// -------------------------------------------------------------------------

describe("openDatabase exit-handler stacking guard", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not add more than one exit listener even when called multiple times", async () => {
    const { openDatabase, resetWriteCounter } = await import("../src/db.ts");

    const before = process.listenerCount("exit");

    const db1 = openDatabase(join(tempDir, "guard1.db"));
    const after1 = process.listenerCount("exit");

    const db2 = openDatabase(join(tempDir, "guard2.db"));
    const after2 = process.listenerCount("exit");

    // Second open must NOT add another listener
    expect(after2).toBe(after1);

    // First open may have added at most one listener
    expect(after1 - before).toBeLessThanOrEqual(1);

    resetWriteCounter();
    db1.close();
    db2.close();
  });
});
