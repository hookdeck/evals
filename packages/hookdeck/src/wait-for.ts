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
 * Poll until `ready` holds, then keep polling for `settleMs` and return the
 * final observation.
 *
 * For the shape several scenarios share: one thing must happen and another must
 * *not*. A filter routes the matching order and drops the legacy one; a
 * deduplicate rule lets the first payment through and suppresses the second.
 *
 * Waiting for the positive alone is not enough, and is actively worse than the
 * sleep it replaces. Both probes are sent together, so returning the moment the
 * positive lands reads the negative before it has had any chance to arrive, and
 * a rule that does nothing at all scores as a pass. A fixed sleep was at least
 * even-handed about it.
 *
 * So the positive arriving starts the clock rather than stopping it: it proves
 * ingestion has caught up, and `settleMs` past that is the window in which a
 * negative that was going to arrive would have. The value returned is the last
 * one seen, not the one that satisfied `ready`, so anything landing during the
 * settle is counted.
 *
 * Returns the last observation rather than throwing if `ready` never holds. By
 * then the full timeout has elapsed, which is more settle time than the happy
 * path gets, and "nothing arrived" is a result to score rather than an error:
 * it is how "the rule suppressed the original too" is caught.
 */
export async function waitForSettled<T>(
  probe: () => Promise<T>,
  ready: (value: T) => boolean,
  options: WaitForOptions & { settleMs?: number } = {}
): Promise<T> {
  const { settleMs = 5_000, intervalMs = 1_000 } = options;

  const first = await waitForOrLast(probe, ready, options);
  if (!ready(first)) return first;

  let last = first;
  const settleUntil = Date.now() + settleMs;
  while (Date.now() < settleUntil) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      last = await probe();
    } catch {
      // Keep the previous observation; a transient read is not evidence.
    }
  }
  return last;
}

/**
 * Poll until `predicate` has held for `consecutive` observations in a row.
 *
 * For conditions that are not monotonic — where holding once is not evidence it
 * will hold again. `waitFor` and `waitForSettled` both assume that once a thing
 * is true it stays true, which is safe for ingestion: an event that exists does
 * not stop existing, so the first sighting can be acted on.
 *
 * Rule enforcement is not like that. A filter written to a connection is
 * readable through the API before the ingest path applies it, and while it
 * propagates, enforcement alternates: measured on 19 August, a request at +2.5s
 * was filtered and a later one at +4.5s was not. A canary that gets rejected
 * once therefore proves nothing, and a scorer that trusts it records a verdict
 * on a rule that is still coming into force. See hookdeck/evals#25.
 *
 * So the question is not "has it started" but "has it stopped changing", and the
 * only answer available without a readiness signal from the product is
 * agreement across repeated observation.
 *
 * `consecutive` is a confidence dial, not a duration: three agreeing
 * observations at a one-second interval is a weaker claim than three at five
 * seconds, because the failure being guarded against is periodic rather than
 * random. Set `intervalMs` wider than the period you expect to be wrong about.
 */
export async function waitForConsistent<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitForOptions & { consecutive?: number } = {}
): Promise<T> {
  const {
    consecutive = 3,
    timeoutMs = 30_000,
    intervalMs = 2_000,
    description = 'condition',
  } = options;
  const deadline = Date.now() + timeoutMs;
  let run = 0;
  let last: T | undefined;

  for (;;) {
    try {
      last = await probe();
      run = predicate(last) ? run + 1 : 0;
      if (run >= consecutive) return last;
    } catch {
      // A failed observation is not a disagreement, but it is not agreement
      // either: hold the streak rather than counting or resetting it.
    }
    if (Date.now() >= deadline) {
      throw new WaitTimeoutError(
        `${description} (held ${run} of ${consecutive} required)`,
        timeoutMs
      );
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
