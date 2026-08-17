import { describe, expect, it } from 'vitest';
import { waitFor, waitForOrLast, WaitTimeoutError } from '../src/wait-for.js';

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
