import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HookdeckApiError, HookdeckClient } from '../src/index.js';

describe('HookdeckClient', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends Bearer auth (verified against the live API, not Basic)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new HookdeckClient({ apiKey: 'secret' }).request('GET', '/sources');
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  it('follows pagination so a wipe cannot miss resources past the first page', async () => {
    const pages = [
      { models: [{ id: 'a' }], pagination: { next: 'cur1' } },
      { models: [{ id: 'b' }], pagination: { next: null } },
    ];
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(pages[i++]), { status: 200 })
      )
    );
    const all = await new HookdeckClient({ apiKey: 'k' }).list('sources');
    expect(all.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('throws a typed error carrying method, path and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"nope"}', { status: 422 }))
    );
    const err = await new HookdeckClient({ apiKey: 'k' })
      .request('POST', '/destinations', {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(HookdeckApiError);
    expect(err).toMatchObject({
      method: 'POST',
      path: '/destinations',
      status: 422,
    });
  });

  it('refuses to construct without an api key', () => {
    expect(() => new HookdeckClient({ apiKey: '' })).toThrow(
      /requires an apiKey/
    );
  });
});
