import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('lists the addresses inside an AggregateError with an empty message', () => {
    // What Node 22 throws when every address of a multi-address host refuses.
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), {
        code: 'ECONNREFUSED',
      });
    const all = Object.assign(
      new AggregateError(
        [refused('2606:4700::1:443'), refused('104.18.2.1:443')],
        ''
      ),
      { code: 'ECONNREFUSED' }
    );
    expect(describeError(new TypeError('fetch failed', { cause: all }))).toBe(
      'fetch failed ← ECONNREFUSED [connect ECONNREFUSED 2606:4700::1:443; connect ECONNREFUSED 104.18.2.1:443]'
    );
  });

  it('names the address a real fetch failed to reach', async () => {
    // Whatever shape this Node version throws — one error or an
    // AggregateError per address — the address has to reach the line.
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((r) => server.close(() => r()));

    const error = await fetch(`http://127.0.0.1:${port}/`).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(describeError(error)).toContain(`127.0.0.1:${port}`);
  });

  it('describes a null-prototype object cause without throwing', () => {
    const cause = Object.assign(Object.create(null), { reason: 'gone' });
    const line = describeError(new Error('outer', { cause }));
    expect(line).toMatch(/^outer ← /);
    expect(line).toContain('gone');
  });

  it('prints a plain object cause rather than [object Object]', () => {
    expect(describeError(new Error('outer', { cause: { status: 502 } }))).toBe(
      'outer ← { status: 502 }'
    );
  });

  it('keeps the root cause when the chain is longer than maxDepth', () => {
    let e: Error = new Error('root cause');
    for (let i = 1; i <= 8; i += 1) e = new Error(`layer ${i}`, { cause: e });
    const line = describeError(e, 4);
    expect(line).toBe('layer 8 ← layer 7 ← layer 6 ← … ← root cause');
  });
});
