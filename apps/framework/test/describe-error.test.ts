import { describe, expect, it } from 'vitest';
import { describeError } from '../harness/describe-error.js';

/** The shape undici produces: a bare TypeError with the reason on `cause`. */
function fetchFailed(): TypeError {
  const socket = Object.assign(
    new Error('connect ECONNREFUSED 104.18.2.1:443'),
    { code: 'ECONNREFUSED' }
  );
  return new TypeError('fetch failed', { cause: socket });
}

describe('describeError', () => {
  it('names the reason a fetch failed, not just that it did', () => {
    expect(describeError(fetchFailed())).toBe(
      'fetch failed ← connect ECONNREFUSED 104.18.2.1:443'
    );
  });

  it('adds a code the message does not already contain', () => {
    const e = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    });
    expect(describeError(e)).toBe(
      'fetch failed ← Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)'
    );
  });

  it('reads through the wrapper the harness puts around each cell', () => {
    const cell = new Error('claude-code-sonnet-5 x some-eval', {
      cause: fetchFailed(),
    });
    expect(describeError(cell)).toBe(
      'claude-code-sonnet-5 x some-eval ← fetch failed ← connect ECONNREFUSED 104.18.2.1:443'
    );
  });

  it('prints a plain message unchanged', () => {
    expect(describeError(new Error('no transcript event'))).toBe(
      'no transcript event'
    );
  });

  it('handles a thrown non-error', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(new Error('outer', { cause: 42 }))).toBe('outer ← 42');
  });

  it('stops on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(describeError(a)).toBe('a ← b');
  });
});
