/**
 * record-lineage.test.ts — SessionStore.recordLineage() (SPEC-LINEAGE-4 extension)
 *
 * recordLineage(childId, parentId) sets parent_session_id on the child session row.
 * The method is a convenience UPDATE — it does NOT create new sessions.
 *
 * Acceptance criteria:
 *   RL-1  recordLineage sets parent_session_id on the child row
 *   RL-2  subsequent resolveByKey returns the updated parentSessionId
 *   RL-3  getLineage traverses the set parent chain
 *   RL-4  recordLineage is exported from the package barrel
 *
 * TDD: these tests MUST fail before SessionStore.recordLineage() is implemented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "zia-record-lineage-"));
}

describe("SessionStore.recordLineage() (RL-1..RL-4)", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("RL-1: sets parent_session_id on the child session row", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "rl1.db"));
    const store = new SessionStore(db);

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

    const child = store.createSession({
      sessionKey: "agent:main:tui:dm:child",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null, // not set yet
    });

    // Before: child has no parent
    expect(store.resolveByKey("agent:main:tui:dm:child")!.parentSessionId).toBeNull();

    // Set the lineage
    store.recordLineage(child.id, parent.id);

    // After: child's parent_session_id is set
    const raw = db
      .prepare("SELECT parent_session_id FROM sessions WHERE id = ?")
      .get(child.id) as { parent_session_id: string | null } | undefined;

    expect(raw?.parent_session_id).toBe(parent.id);
    db.close();
  });

  it("RL-2: resolveByKey returns the updated parentSessionId after recordLineage", async () => {
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

    store.recordLineage(child.id, parent.id);

    const resolved = store.resolveByKey("agent:main:tui:dm:c2");
    expect(resolved).not.toBeNull();
    expect(resolved!.parentSessionId).toBe(parent.id);
    db.close();
  });

  it("RL-3: getLineage traverses the chain set by recordLineage", async () => {
    const { openDatabase } = await import("../src/db.ts");
    const { SessionStore } = await import("../src/session-store.ts");

    const db = openDatabase(join(tempDir, "rl3.db"));
    const store = new SessionStore(db);

    const root = store.createSession({
      sessionKey: "agent:main:tui:dm:root3",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    const child = store.createSession({
      sessionKey: "agent:main:tui:dm:child3",
      sourcePlatform: "tui",
      modelConfig: "{}",
      piSessionPath: null,
      startedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
      endReason: null,
      parentSessionId: null,
    });

    store.recordLineage(child.id, root.id);

    const lineage = store.getLineage(child.id);
    expect(lineage.length).toBe(1);
    expect(lineage[0]!.id).toBe(root.id);
    db.close();
  });

  it("RL-4: recordLineage is exported from the package barrel", async () => {
    // This tests that the method is accessible on an instance imported via the barrel.
    const { SessionStore, openDatabase } = await import("../src/index.ts");

    const db = openDatabase(join(tempDir, "rl4.db"));
    const store = new SessionStore(db);

    expect(typeof store.recordLineage).toBe("function");
    db.close();
  });
});
