/**
 * retry.test.ts — RED tests for retryWithJitter.
 *
 * Covers:
 *   SPEC-R4  retry on SQLITE_BUSY with jitter, ≤15 retries, rethrow on 16th
 */

import { describe, expect, it, vi } from "vitest";

describe("retryWithJitter (SPEC-R4)", () => {
  it("returns the result when fn succeeds on the first call", async () => {
    const { retryWithJitter } = await import("../src/retry.ts");
    const result = retryWithJitter(() => 42);
    expect(result).toBe(42);
  });

  it("retries when fn throws SQLITE_BUSY and eventually succeeds", async () => {
    const { retryWithJitter } = await import("../src/retry.ts");

    let calls = 0;
    const busyError = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });

    const result = retryWithJitter(
      () => {
        calls++;
        if (calls < 3) throw busyError;
        return "ok";
      },
      { maxRetries: 5, minDelayMs: 1, maxDelayMs: 2 },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows on the (maxRetries+1)th consecutive SQLITE_BUSY failure", async () => {
    const { retryWithJitter } = await import("../src/retry.ts");

    const busyError = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });

    expect(() =>
      retryWithJitter(
        () => {
          throw busyError;
        },
        { maxRetries: 3, minDelayMs: 1, maxDelayMs: 2 },
      ),
    ).toThrow("database is locked");
  });

  it("does NOT retry on non-SQLITE_BUSY errors", async () => {
    const { retryWithJitter } = await import("../src/retry.ts");

    let calls = 0;
    const otherError = new Error("SQLITE_CONSTRAINT");

    expect(() =>
      retryWithJitter(
        () => {
          calls++;
          throw otherError;
        },
        { maxRetries: 5, minDelayMs: 1, maxDelayMs: 2 },
      ),
    ).toThrow("SQLITE_CONSTRAINT");

    expect(calls).toBe(1);
  });

  it("uses default options (maxRetries=15) when opts not provided", async () => {
    const { retryWithJitter } = await import("../src/retry.ts");

    let calls = 0;
    const busyError = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });

    expect(() =>
      retryWithJitter(() => {
        calls++;
        throw busyError;
      }),
    ).toThrow("busy");

    // 1 initial call + 15 retries = 16 total
    expect(calls).toBe(16);
  });

  it("delay is within [minDelayMs, maxDelayMs] range (smoke check)", async () => {
    // We spy on Date to verify the sleep duration falls in range.
    // Since retryWithJitter is synchronous (uses Atomics.wait or a busy-spin),
    // we verify indirectly: measure wall-clock time for 1 retry with known bounds.
    const { retryWithJitter } = await import("../src/retry.ts");

    const MIN = 10;
    const MAX = 30;
    let calls = 0;
    const busyError = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });

    const start = Date.now();
    retryWithJitter(
      () => {
        calls++;
        if (calls === 1) throw busyError;
        return "done";
      },
      { maxRetries: 2, minDelayMs: MIN, maxDelayMs: MAX },
    );
    const elapsed = Date.now() - start;

    // At least one sleep of MIN ms should have occurred
    expect(elapsed).toBeGreaterThanOrEqual(MIN - 5); // -5ms tolerance
    expect(elapsed).toBeLessThan(MAX * 3); // generous upper bound
  });
});
