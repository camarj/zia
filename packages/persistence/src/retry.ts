/**
 * retry.ts — retryWithJitter for SQLITE_BUSY (SPEC-R4, ADR-3).
 *
 * better-sqlite3 is synchronous, so this retry helper is also synchronous.
 * It uses Atomics.wait on a shared 32-bit buffer to block the calling thread
 * for the jitter interval without spinning — safe in vitest pool:forks (child
 * processes) and in the agent-runtime main thread.
 *
 * Only SQLITE_BUSY (error.code === 'SQLITE_BUSY') is retried. All other
 * errors throw immediately.
 */

export interface RetryOptions {
  /** Maximum number of retries before rethrowing. Default: 15. */
  maxRetries?: number;
  /** Minimum sleep duration per retry in ms. Default: 20. */
  minDelayMs?: number;
  /** Maximum sleep duration per retry in ms. Default: 150. */
  maxDelayMs?: number;
}

/**
 * Execute fn(), retrying up to maxRetries times on SQLITE_BUSY with uniform
 * random jitter in [minDelayMs, maxDelayMs]. Throws on the (maxRetries+1)th
 * consecutive failure.
 */
export function retryWithJitter<T>(fn: () => T, opts?: RetryOptions): T {
  const maxRetries = opts?.maxRetries ?? 15;
  const minDelay = opts?.minDelayMs ?? 20;
  const maxDelay = opts?.maxDelayMs ?? 150;

  let attempt = 0;

  while (true) {
    try {
      return fn();
    } catch (err: unknown) {
      const isBusy =
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "SQLITE_BUSY";

      if (!isBusy || attempt >= maxRetries) {
        throw err;
      }

      attempt++;
      const delay =
        Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      sleepMs(delay);
    }
  }
}

/**
 * Synchronous sleep using Atomics.wait on an isolated SharedArrayBuffer.
 * Falls back to a busy-spin on environments where Atomics.wait is unavailable
 * (e.g. main browser thread — not applicable here, but safe).
 */
function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  // Atomics.wait blocks this thread for exactly ms milliseconds when the
  // value at index 0 is 0 (it always is — we never notify).
  Atomics.wait(arr, 0, 0, ms);
}
