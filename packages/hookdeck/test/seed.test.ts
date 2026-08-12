import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookdeckClient,
  applySeed,
  readSeed,
  type Seed,
} from '../src/index.js';

/** Records every call so tests can assert order and shape. */
function recordingFetch(responses: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method,
      path: u.origin.includes('hkdk') ? u.href : path,
      body,
    });
    const key = `${method} ${path}`;
    return new Response(JSON.stringify(responses[key] ?? { id: 'generated' }), {
      status: 200,
    });
  });
  return { impl, calls };
}

const client = () => new HookdeckClient({ apiKey: 'k' });

describe('readSeed', () => {
  it('returns undefined when a scenario has no seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hd-seed-'));
    expect(readSeed(dir)).toBeUndefined();
  });

  it('reads seed.json when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hd-seed-'));
    writeFileSync(join(dir, 'seed.json'), JSON.stringify({ resources: [] }));
    expect(readSeed(dir)).toEqual({ resources: [] });
  });
});

describe('applySeed', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates resources in declared order', async () => {
    const { impl, calls } = recordingFetch();
    vi.stubGlobal('fetch', impl);
    const seed: Seed = {
      resources: [
        { kind: 'sources', body: { name: 's' } },
        { kind: 'destinations', body: { name: 'd' } },
      ],
    };
    await applySeed(client(), seed);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /sources',
      'POST /destinations',
    ]);
  });

  it('resolves $ref placeholders to ids created earlier', async () => {
    const { impl, calls } = recordingFetch({
      'POST /sources': { id: 'src_1' },
      'POST /destinations': { id: 'dst_1' },
    });
    vi.stubGlobal('fetch', impl);
    await applySeed(client(), {
      resources: [
        { kind: 'sources', ref: 'src', body: { name: 's' } },
        { kind: 'destinations', ref: 'dst', body: { name: 'd' } },
        {
          kind: 'connections',
          body: { source_id: '$ref:src', destination_id: '$ref:dst' },
        },
      ],
    });
    expect(calls.at(-1)?.body).toEqual({
      source_id: 'src_1',
      destination_id: 'dst_1',
    });
  });

  it('rejects a reference to an unknown ref rather than sending a bad body', async () => {
    const { impl } = recordingFetch();
    vi.stubGlobal('fetch', impl);
    await expect(
      applySeed(client(), {
        resources: [{ kind: 'connections', body: { source_id: '$ref:nope' } }],
      })
    ).rejects.toThrow(/unknown ref "nope"/);
  });

  it('applies `then` steps as PUT by default, substituting {id}', async () => {
    // BM8 seeds a paused connection. pause/unpause are PUT on this API; POST 404s.
    const { impl, calls } = recordingFetch({
      'POST /connections': { id: 'web_1' },
    });
    vi.stubGlobal('fetch', impl);
    await applySeed(client(), {
      resources: [
        {
          kind: 'connections',
          body: { name: 'c' },
          then: [{ path: '/connections/{id}/pause' }],
        },
      ],
    });
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/connections/web_1/pause',
    });
  });

  it('honours an explicit method on a `then` step', async () => {
    const { impl, calls } = recordingFetch({
      'POST /sources': { id: 'src_1' },
    });
    vi.stubGlobal('fetch', impl);
    await applySeed(client(), {
      resources: [
        {
          kind: 'sources',
          body: { name: 's' },
          then: [{ path: '/sources/{id}/thing', method: 'POST' }],
        },
      ],
    });
    expect(calls.at(-1)?.method).toBe('POST');
  });

  it('seeds events by POSTing at the source delivery URL', async () => {
    // There is no create-event API; events exist only as a result of delivery.
    const { impl, calls } = recordingFetch({
      'POST /sources': { id: 'src_1', url: 'https://hkdk.events/abc' },
    });
    vi.stubGlobal('fetch', impl);
    await applySeed(client(), {
      resources: [{ kind: 'sources', ref: 'src', body: { name: 's' } }],
      events: [{ source: 'src', count: 3, body: { order_id: 'o_1' } }],
    });
    const posts = calls.filter((c) => c.path === 'https://hkdk.events/abc');
    expect(posts).toHaveLength(3);
    expect(posts[0]?.body).toEqual({ order_id: 'o_1' });
  });

  it('fails loudly when an event references a source with no delivery URL', async () => {
    const { impl } = recordingFetch({ 'POST /sources': { id: 'src_1' } });
    vi.stubGlobal('fetch', impl);
    await expect(
      applySeed(client(), {
        resources: [{ kind: 'sources', ref: 'src', body: { name: 's' } }],
        events: [{ source: 'src' }],
      })
    ).rejects.toThrow(/no delivery URL/);
  });
});

describe('after steps', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('runs after every event has been sent', async () => {
    // A resolve scenario needs history that already failed and a system that is
    // now healthy, which `then` cannot express: it runs at creation time.
    const { impl, calls } = recordingFetch({
      'POST /sources': { id: 'src_1', url: 'https://hkdk.events/abc' },
      'POST /destinations': { id: 'dst_1' },
    });
    vi.stubGlobal('fetch', impl);

    await applySeed(client(), {
      resources: [
        { kind: 'sources', ref: 'src', body: { name: 's' } },
        { kind: 'destinations', ref: 'dst', body: { name: 'd' } },
      ],
      events: [{ source: 'src', body: { a: 1 } }],
      after: [
        {
          path: '/destinations/$ref:dst',
          body: { config: { url: 'https://example.test/fixed' } },
        },
      ],
    });

    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/destinations/dst_1',
    });
    // and it really is after: the event POST came first. Asserted by position in
    // the call list rather than by index, because the settle poll sits between
    // them and an index would break every time that changes.
    const eventPost = calls.findIndex(
      (call) => call.path === 'https://hkdk.events/abc'
    );
    const afterStep = calls.findIndex(
      (call) => call.path === '/destinations/dst_1' && call.method === 'PUT'
    );
    expect(eventPost).toBeGreaterThanOrEqual(0);
    expect(afterStep).toBeGreaterThan(eventPost);
  });

  it('waits for seeded events to be delivered before applying after steps', async () => {
    // The race this guards: a POST to a source URL returns when ingestion
    // accepts it, but delivery is queued. An `after` step that repairs a broken
    // destination can land before the first attempt, so an event seeded to fail
    // succeeds instead and the scenario self-heals with the agent doing nothing.
    const { impl, calls } = recordingFetch({
      'POST /sources': { id: 'src_1', url: 'https://hkdk.events/abc' },
      'POST /destinations': { id: 'dst_1' },
    });
    // Pending on the first poll, delivered on the second.
    let polls = 0;
    const withPending = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/events?')) {
        calls.push({ method: 'GET', path: '/events' });
        polls += 1;
        return new Response(
          JSON.stringify({
            models: [
              {
                created_at: new Date(Date.now() + 1000).toISOString(),
                status: polls === 1 ? 'QUEUED' : 'FAILED',
              },
            ],
          }),
          { status: 200 }
        );
      }
      return impl(url, init);
    });
    vi.stubGlobal('fetch', withPending);

    await applySeed(client(), {
      resources: [
        { kind: 'sources', ref: 'src', body: { name: 's' } },
        { kind: 'destinations', ref: 'dst', body: { name: 'd' } },
      ],
      events: [{ source: 'src', body: { a: 1 } }],
      after: [{ path: '/destinations/$ref:dst', body: { config: {} } }],
    });

    expect(polls).toBe(2);
    // The repair still ran, and only once the event had left QUEUED.
    expect(calls.at(-1)).toMatchObject({ path: '/destinations/dst_1' });
  });

  it('does not wait when a seed has no after steps', async () => {
    // The poll costs seconds and only matters when state changes after events,
    // so every other scenario should not pay for it.
    const { impl, calls } = recordingFetch({
      'POST /sources': { id: 'src_1', url: 'https://hkdk.events/abc' },
    });
    vi.stubGlobal('fetch', impl);

    await applySeed(client(), {
      resources: [{ kind: 'sources', ref: 'src', body: { name: 's' } }],
      events: [{ source: 'src', body: { a: 1 } }],
    });

    expect(calls.some((call) => call.path.startsWith('/events'))).toBe(false);
  });

  it('rejects a path referencing an unknown ref', async () => {
    const { impl } = recordingFetch();
    vi.stubGlobal('fetch', impl);
    await expect(
      applySeed(client(), { after: [{ path: '/destinations/$ref:nope' }] })
    ).rejects.toThrow(/unknown ref "nope"/);
  });
});
