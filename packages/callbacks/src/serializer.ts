/**
 * serializer.ts — Promise-chain mutex for approval decisions.
 *
 * Ensures that at most one medio/alto approval is surfaced to the resolver at
 * a time, even when pi.dev fires parallel execute() calls in a single turn.
 * Trivial tool calls never touch this — they remain fully concurrent.
 *
 * Mechanism: each call to runExclusive() appends to a single shared promise
 * chain. The `chain` is always set in a `finally` block so a rejected/throwing
 * approval does NOT poison subsequent tasks (failure-isolated FIFO).
 */

export class ApprovalSerializer {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` exclusively: waits for any in-flight exclusive task to finish,
   * then runs `fn`. Returns `fn`'s result (or rethrows its rejection).
   * A failure in `fn` does not prevent subsequent runExclusive() calls.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Capture a handle to the current tail of the chain.
    const previous = this.chain;

    // Build the new tail: wait for previous, then run fn regardless.
    // The `finally` ensures the chain advances even if fn rejects.
    let resolveTail!: () => void;
    const tail = new Promise<void>((r) => {
      resolveTail = r;
    });
    this.chain = tail;

    // The actual work: wait for previous slot, run fn, settle tail.
    const result = previous.then(() => fn()).finally(() => {
      resolveTail();
    });

    return result;
  }
}
