import { describe, expect, it } from 'vitest';
import {
  waitFor,
  waitForConsistent,
  waitForOrLast,
  waitForSettled,
  WaitTimeoutError,
} from '../src/wait-for.js';

describe('waitFor', () => {
  it('returns as soon as the predicate holds, without waiting out the timeout', async () => {
    let calls = 0;
    const started = Date.now();
    const value = await waitFor(
      async () => ++calls,
      (n) => n >= 3,
      { intervalMs: 5, timeoutMs: 5_000 }
    );
    expect(value).toBe(3);
    // The point of polling: a fast platform costs three intervals, not the
    // fixed sleep the scorers used to take regardless.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps waiting when the probe throws, since ingestion errors are transient', async () => {
    let calls = 0;
    const value = await waitFor(
      async () => {
        if (++calls < 3) throw new Error('not ready');
        return 'ok';
      },
      (v) => v === 'ok',
      { intervalMs: 5, timeoutMs: 5_000 }
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws a named timeout so a scorer can tell a slow platform from a real failure', async () => {
    await expect(
      waitFor(
        async () => 'never',
        (v) => v === 'ready',
        {
          intervalMs: 5,
          timeoutMs: 40,
          description: 'the request to be verified',
        }
      )
    ).rejects.toThrow(/the request to be verified/);
  });

  it('waitForOrLast returns the last observation instead of throwing', async () => {
    const value = await waitForOrLast(
      async () => [],
      (v: unknown[]) => v.length > 0,
      {
        intervalMs: 5,
        timeoutMs: 40,
      }
    );
    expect(value).toEqual([]);
  });
});

describe('waitForSettled', () => {
  /** The bug this exists to prevent: a negative assertion scored before the
   *  thing it denies has had a chance to arrive. */
  it('counts what arrives after the condition is first met', async () => {
    let count = 0;
    const value = await waitForSettled(
      async () => ++count,
      (v) => v >= 1,
      { intervalMs: 5, settleMs: 40, timeoutMs: 200 }
    );
    expect(value).toBeGreaterThan(1);
  });

  it('returns the last observation when the condition never holds', async () => {
    const value = await waitForSettled(
      async () => [],
      (v: unknown[]) => v.length > 0,
      { intervalMs: 5, settleMs: 20, timeoutMs: 40 }
    );
    expect(value).toEqual([]);
  });

  it('keeps the previous observation when a probe throws mid-settle', async () => {
    let calls = 0;
    const value = await waitForSettled(
      async () => {
        calls += 1;
        if (calls > 1) throw new Error('transient');
        return 'first';
      },
      (v) => v === 'first',
      { intervalMs: 5, settleMs: 20, timeoutMs: 40 }
    );
    expect(value).toBe('first');
  });
});

describe('waitForConsistent', () => {
  /** The bug this exists for: a condition that holds once, then stops. */
  it('does not return on a single lucky observation', async () => {
    // filtered, not filtered, then filtered from here on — the real shape
    // measured on rule propagation.
    const sequence = [true, false, true, true, true];
    let i = 0;
    const seen: boolean[] = [];
    await waitForConsistent(
      async () => {
        const v = sequence[Math.min(i, sequence.length - 1)];
        i += 1;
        seen.push(v);
        return v;
      },
      (v) => v,
      { consecutive: 3, intervalMs: 1, timeoutMs: 500 }
    );
    // Had it returned on the first `true` it would have stopped at one
    // observation and scored against a rule that was not yet in force.
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  it('resets the streak when the condition stops holding', async () => {
    const sequence = [true, true, false, true, true, true];
    let i = 0;
    await waitForConsistent(
      async () => sequence[Math.min(i++, sequence.length - 1)],
      (v) => v,
      { consecutive: 3, intervalMs: 1, timeoutMs: 500 }
    );
    // Six observations minimum: two, the reset, then three in a row.
    expect(i).toBeGreaterThanOrEqual(6);
  });

  it('reports how far it got when it times out', async () => {
    await expect(
      waitForConsistent(
        async () => false,
        (v) => v,
        {
          consecutive: 3,
          intervalMs: 5,
          timeoutMs: 40,
          description: 'the filter to be enforced',
        }
      )
    ).rejects.toThrow(/the filter to be enforced \(held 0 of 3 required\)/);
  });
});
