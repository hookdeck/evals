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
