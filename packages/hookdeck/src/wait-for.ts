/**
 * Wait for a condition instead of sleeping and hoping.
 *
 * Ingestion is asynchronous: a POST to a source URL returns once the request is
 * accepted, and the request record, its `verified` flag, the event, and the
 * delivery attempt all appear afterwards, at times that vary with load. Every
 * scorer that sends something and then reads it back has to bridge that gap.
 *
 * They all bridged it with a fixed `setTimeout`, typically 8 or 12 seconds.
 * That is a race, and it is the single largest source of false failures in this
 * suite: when the platform is slower than the sleep, the scorer reads too early
 * and records a correct agent as broken. It shows up as a scenario that fails a
 * different cell every run, because which cell loses depends on when its job
 * happened to run rather than on anything the agent did.
 *
 * Polling costs nothing when the platform is quick, which is most of the time,
 * and buys a much longer ceiling when it is not.
 */

export interface WaitForOptions {
  /** Give up after this long. Generous: the cost of waiting is seconds, the
   *  cost of giving up early is a false failure that looks like a real one. */
  timeoutMs?: number;
  /** How often to re-check. */
  intervalMs?: number;
  /** Named in the timeout message, so a failure says what never arrived. */
  description?: string;
}

export class WaitTimeoutError extends Error {
  constructor(description: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for ${description}`);
    this.name = 'WaitTimeoutError';
  }
}

/**
 * Poll `probe` until it returns a value that satisfies `predicate`.
 *
 * Returns the satisfying value. Throws `WaitTimeoutError` on timeout, so a
 * scorer can decide whether that is a failed check or an errored run rather
 * than silently scoring whatever it happened to read.
 *
 * A probe that throws is treated as not-yet-ready and retried: a scorer polling
 * an API during ingestion will meet transient errors, and one of them should not
 * end the wait.
 */
export async function waitFor<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitForOptions = {}
): Promise<T> {
  const {
    timeoutMs = 30_000,
    intervalMs = 1_000,
    description = 'condition',
  } = options;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;

  for (;;) {
    try {
      last = await probe();
      if (predicate(last)) return last;
    } catch {
      // Transient during ingestion; keep waiting.
    }
    if (Date.now() >= deadline) {
      throw new WaitTimeoutError(description, timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Like `waitFor`, but returns the last observed value on timeout instead of
 * throwing.
 *
 * For checks where "it never arrived" is a legitimate result to score rather
 * than an error: a negative check confirming something was *not* delivered
 * still needs to wait long enough to be sure, and then wants the empty answer.
 */
export async function waitForOrLast<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitForOptions = {}
): Promise<T> {
  try {
    return await waitFor(probe, predicate, options);
  } catch (error) {
    if (error instanceof WaitTimeoutError) {
      return await probe();
    }
    throw error;
  }
}
