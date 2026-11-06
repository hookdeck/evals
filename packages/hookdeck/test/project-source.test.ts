import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ISSUE_TRIGGERS,
  FixedProjectSource,
  HookdeckClient,
  muteIssueTriggerNotifications,
  type PristineSnapshot,
} from '../src/index.js';

/**
 * A fake Hookdeck API. The provisioner only ever lists and deletes, so this
 * models a project as a map of kind -> resources and records the deletes.
 */
function fakeApi(initial: Record<string, string[]> = {}) {
  const state = new Map<string, Set<string>>();
  for (const [kind, ids] of Object.entries(initial)) {
    state.set(kind, new Set(ids));
  }
  const deleted: Array<{ kind: string; id: string }> = [];

  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const [, kind, id] = path.split('/');

    if (method === 'DELETE') {
      state.get(kind)?.delete(id);
      deleted.push({ kind, id });
      return new Response('', { status: 200 });
    }
    const models = [...(state.get(kind) ?? [])].map((rid) => ({ id: rid }));
    return new Response(JSON.stringify({ models }), { status: 200 });
  });

  return { fetchImpl, deleted, state };
}

function tempSnapshotPath() {
  return join(mkdtempSync(join(tmpdir(), 'hd-evals-')), 'pristine.json');
}

describe('FixedProjectSource', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('captures a pristine snapshot on first acquire', async () => {
    const { fetchImpl } = fakeApi({ 'issue-triggers': ['it_1', 'it_2'] });
    vi.stubGlobal('fetch', fetchImpl);
    const snapshotPath = tempSnapshotPath();

    await new FixedProjectSource({ apiKey: 'k', snapshotPath }).acquire();

    const snapshot = JSON.parse(
      readFileSync(snapshotPath, 'utf8')
    ) as PristineSnapshot;
    expect(snapshot.ids['issue-triggers']).toEqual(['it_1', 'it_2']);
    expect(snapshot.capturedAt).toBeTruthy();
  });

  it('preserves what the project held when the snapshot was taken', async () => {
    // The whole reason reset is to pristine rather than to empty. Issue
    // triggers are declared rather than snapshotted; see the describe below.
    const { fetchImpl, deleted } = fakeApi({
      sources: ['src_1', 'src_2'],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const snapshotPath = tempSnapshotPath();
    const source = new FixedProjectSource({ apiKey: 'k', snapshotPath });

    await source.acquire();
    await source.acquire();

    expect(deleted).toEqual([]);
  });

  it('deletes what a previous run added, keeping what was there before', async () => {
    const { fetchImpl, deleted, state } = fakeApi({
      sources: ['src_before'],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const snapshotPath = tempSnapshotPath();
    const source = new FixedProjectSource({ apiKey: 'k', snapshotPath });

    await source.acquire();
    // a run leaves resources behind
    state.get('sources')!.add('src_leftover');
    state.set('destinations', new Set(['des_leftover']));

    await source.acquire();

    expect(deleted).toEqual([
      { kind: 'sources', id: 'src_leftover' },
      { kind: 'destinations', id: 'des_leftover' },
    ]);
    expect(state.get('sources')).toContain('src_before');
  });

  it('self-heals after a run that crashed without releasing', async () => {
    // Reset keys off the snapshot, not a per-run timestamp, so leftovers from a
    // crashed run are cleaned by the next acquire rather than accumulating.
    const { fetchImpl, state } = fakeApi();
    vi.stubGlobal('fetch', fetchImpl);
    const snapshotPath = tempSnapshotPath();
    const source = new FixedProjectSource({ apiKey: 'k', snapshotPath });

    await source.acquire();
    state.set('connections', new Set(['web_crashed']));
    // no release() - simulating a crash

    await source.acquire();
    expect(state.get('connections')?.size).toBe(0);
  });

  it('reuses an existing snapshot rather than re-capturing a dirty project', async () => {
    // Re-capturing after a run would bake that run's resources into "pristine".
    const snapshotPath = tempSnapshotPath();
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        capturedAt: '2026-08-07T00:00:00.000Z',
        ids: { sources: ['src_before'] },
      })
    );
    const { fetchImpl, deleted } = fakeApi({
      sources: ['src_before', 'src_added_later'],
    });
    vi.stubGlobal('fetch', fetchImpl);

    await new FixedProjectSource({ apiKey: 'k', snapshotPath }).acquire();

    expect(deleted).toEqual([{ kind: 'sources', id: 'src_added_later' }]);
  });

  it('returns a lease carrying acquiredAt, for scoping scorer queries', async () => {
    const { fetchImpl } = fakeApi();
    vi.stubGlobal('fetch', fetchImpl);
    const before = Date.now();

    const lease = await new FixedProjectSource({
      apiKey: 'k',
      projectId: 'evals-ci',
      snapshotPath: tempSnapshotPath(),
    }).acquire();

    expect(lease.projectId).toBe('evals-ci');
    expect(lease.acquiredAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not throw when release fails', async () => {
    // A failed release must not fail the run; the next acquire cleans up.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    );
    const source = new FixedProjectSource({
      apiKey: 'k',
      snapshotPath: tempSnapshotPath(),
    });
    await expect(
      source.release({
        projectId: 'p',
        apiKey: 'k',
        acquiredAt: new Date(),
        client: {} as never,
      })
    ).resolves.toBeUndefined();
  });
});

/**
 * Outpost is a separate API with separate state, and nothing else resets it.
 * The distinction that matters is between a tenant that was already there and
 * one this lease created: deleting the first would destroy someone else's data,
 * and keeping the second lets `outpost-001` score a previous run's work.
 */
describe('FixedProjectSource Outpost cleanup', () => {
  beforeEach(() => vi.restoreAllMocks());

  function fakeOutpost(tenants: string[]) {
    const state = new Set(tenants);
    const deleted: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname.includes('outpost')) {
        const method = init?.method ?? 'GET';
        // These tests are about tenants. The real API serves several unrelated
        // collections under the same host — operator event destinations and the
        // managed config among them — and answering the tenant list for every
        // path made this fake report tenants as operator event destinations,
        // which the cleanup then dutifully deleted.
        if (u.pathname.includes('/operator-events')) {
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        }
        if (u.pathname.endsWith('/config')) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (method === 'DELETE') {
          const id = u.pathname.split('/').pop() as string;
          state.delete(id);
          deleted.push(id);
          return new Response('', { status: 200 });
        }
        return new Response(
          JSON.stringify({ models: [...state].map((id) => ({ id })) }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });
    return { fetchImpl, deleted, state };
  }

  it('deletes tenants the lease created and keeps ones it inherited', async () => {
    const outpost = fakeOutpost(['pre-existing']);
    vi.stubGlobal('fetch', outpost.fetchImpl);
    const source = new FixedProjectSource({
      apiKey: 'k',
      outpostApiKey: 'o',
      snapshotPath: tempSnapshotPath(),
    });

    const lease = await source.acquire();
    outpost.state.add('acme'); // the scenario's tenant, created mid-run
    await source.release(lease);

    expect(outpost.deleted).toEqual(['acme']);
    expect(outpost.state.has('pre-existing')).toBe(true);
  });

  it('deletes nothing when no Outpost key is configured', async () => {
    const outpost = fakeOutpost(['acme']);
    vi.stubGlobal('fetch', outpost.fetchImpl);
    const source = new FixedProjectSource({
      apiKey: 'k',
      snapshotPath: tempSnapshotPath(),
    });
    // The env fallback exists so experiments need not pass the key; unset it
    // so this asserts the off case rather than the developer's environment.
    const prior = process.env.OUTPOST_API_KEY;
    delete process.env.OUTPOST_API_KEY;
    try {
      const lease = await source.acquire();
      await source.release(lease);
      expect(outpost.deleted).toEqual([]);
    } finally {
      if (prior !== undefined) process.env.OUTPOST_API_KEY = prior;
    }
  });

  /**
   * Operator event destinations are project-level and outlive a run, so a
   * scenario that clears them to start from "no alerting configured" has to put
   * them back. Both directions are load-bearing: a leftover makes the next run
   * pass before the agent acts, and a lost one silently turns off real alerting.
   */
  function fakeOperatorEvents(initial: { id: string; url: string }[]) {
    let rows = [...initial];
    const created: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.includes('/operator-events/destinations')) {
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') {
          const id = u.pathname.split('/').pop() as string;
          rows = rows.filter((r) => r.id !== id);
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
          });
        }
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          created.push(body);
          rows.push({ id: `des_new_${created.length}`, url: body.config?.url });
          return new Response(JSON.stringify(rows[rows.length - 1]), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify(
            rows.map((r) => ({ id: r.id, config: { url: r.url } }))
          ),
          { status: 200 }
        );
      }
      if (u.hostname.includes('outpost')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });
    return { fetchImpl, created, rows: () => rows };
  }

  it('restores operator event destinations a run cleared', async () => {
    const outpost = fakeOperatorEvents([
      { id: 'des_real', url: 'https://alerts.example.com' },
    ]);
    vi.stubGlobal('fetch', outpost.fetchImpl);
    const source = new FixedProjectSource({
      apiKey: 'k',
      outpostApiKey: 'o',
      snapshotPath: tempSnapshotPath(),
    });

    const lease = await source.acquire();
    // What `clearOperatorEventDestinations` does, then what an agent does.
    await outpost.fetchImpl(
      'https://api.outpost.hookdeck.com/2025-07-01/operator-events/destinations/des_real',
      { method: 'DELETE' }
    );
    await outpost.fetchImpl(
      'https://api.outpost.hookdeck.com/2025-07-01/operator-events/destinations',
      {
        method: 'POST',
        body: JSON.stringify({ config: { url: 'https://agent.example.com' } }),
      }
    );
    await source.release(lease);

    const urls = outpost.rows().map((r) => r.url);
    expect(urls).toContain('https://alerts.example.com');
    expect(urls).not.toContain('https://agent.example.com');
  });

  it('leaves operator event destinations alone when the baseline could not be read', async () => {
    // Not the same as "there were none": deleting on an unreadable baseline
    // would destroy alerting this run did not configure.
    let listed = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (u.pathname.includes('/operator-events/destinations')) {
        if (method === 'GET') {
          listed += 1;
          if (listed === 1) return new Response('boom', { status: 500 });
          return new Response(
            JSON.stringify([
              { id: 'des_real', config: { url: 'https://alerts.example.com' } },
            ]),
            { status: 200 }
          );
        }
        deletedOperatorIds.push(u.pathname.split('/').pop() as string);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });
    const deletedOperatorIds: string[] = [];
    vi.stubGlobal('fetch', fetchImpl);
    const source = new FixedProjectSource({
      apiKey: 'k',
      outpostApiKey: 'o',
      snapshotPath: tempSnapshotPath(),
    });

    const lease = await source.acquire();
    await source.release(lease);

    expect(deletedOperatorIds).toEqual([]);
  });

  it('deletes nothing when the baseline could not be read', async () => {
    // Without knowing what was there first, the only safe move is to delete
    // nothing: the alternative is destroying a tenant this run did not create.
    const outpost = fakeOutpost([]);
    let listed = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        if (
          u.hostname.includes('outpost') &&
          (init?.method ?? 'GET') === 'GET'
        ) {
          listed += 1;
          // Fail the acquire-time listing only.
          if (listed === 1) return new Response('boom', { status: 500 });
        }
        return outpost.fetchImpl(url, init);
      })
    );
    const source = new FixedProjectSource({
      apiKey: 'k',
      outpostApiKey: 'o',
      snapshotPath: tempSnapshotPath(),
    });

    const lease = await source.acquire();
    outpost.state.add('acme');
    await source.release(lease);

    expect(outpost.deleted).toEqual([]);
  });
});

/**
 * `OUTPOST_API_KEY` is a project API key, so it reaches `api.hookdeck.com` as
 * well as the Outpost subdomain, and an agent can build Event Gateway resources
 * in the Outpost project with it. One such connection, left from August, was
 * edited by an `outpost-005` attempt and the edit was still there two attempts
 * later. These tests model `api.hookdeck.com` as two projects told apart by the
 * bearer token, which is all that separates them on the real API.
 */
describe('FixedProjectSource Outpost project gateway reset', () => {
  beforeEach(() => vi.restoreAllMocks());

  const GATEWAY_KEY = 'gateway-key';
  const OUTPOST_KEY = 'outpost-key';

  function fakeTwoProjects(
    projects: Record<string, Record<string, string[]>>,
    /** Keys that reach another key's project: two keys, one project. */
    aliases: Record<string, string> = {}
  ) {
    let created = 0;
    const state = new Map<string, Map<string, Set<string>>>();
    for (const [key, kinds] of Object.entries(projects)) {
      const byKind = new Map<string, Set<string>>();
      for (const [kind, ids] of Object.entries(kinds)) {
        byKind.set(kind, new Set(ids));
      }
      state.set(key, byKind);
    }
    const deleted: Array<{ key: string; kind: string; id: string }> = [];

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname.includes('outpost')) {
        // Tenants, operator event destinations and config: none, for these
        // tests, which are about the gateway side.
        if (u.pathname.endsWith('/config')) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      const bearer = String(
        (init?.headers as Record<string, string> | undefined)?.Authorization
      ).replace(/^Bearer /, '');
      const key = aliases[bearer] ?? bearer;
      const project = state.get(key) ?? new Map<string, Set<string>>();
      state.set(key, project);
      const [, kind, id] = u.pathname.replace(/^\/[^/]+/, '').split('/');
      if (init?.method === 'POST') {
        const newId = `${kind}_created_${created++}`;
        const ids = project.get(kind) ?? new Set<string>();
        project.set(kind, ids);
        ids.add(newId);
        return new Response(JSON.stringify({ id: newId }), { status: 200 });
      }
      if ((init?.method ?? 'GET') === 'DELETE') {
        project.get(kind)?.delete(id);
        deleted.push({ key, kind, id });
        return new Response('', { status: 200 });
      }
      const models = [...(project.get(kind) ?? [])].map((rid) => ({
        id: rid,
      }));
      return new Response(JSON.stringify({ models }), { status: 200 });
    });

    const add = (key: string, kind: string, id: string) => {
      const project = state.get(key) ?? new Map<string, Set<string>>();
      state.set(key, project);
      const ids = project.get(kind) ?? new Set<string>();
      project.set(kind, ids);
      ids.add(id);
    };
    const ids = (key: string, kind: string) => [
      ...(state.get(key)?.get(kind) ?? []),
    ];
    return { fetchImpl, deleted, add, ids };
  }

  function source(snapshotPath = tempSnapshotPath()) {
    return new FixedProjectSource({
      apiKey: GATEWAY_KEY,
      outpostApiKey: OUTPOST_KEY,
      snapshotPath,
      outpostConfigPath: join(
        mkdtempSync(join(tmpdir(), 'hd-evals-')),
        'outpost-config.json'
      ),
    });
  }

  it('deletes gateway resources an earlier run left in the Outpost project, before the seed', async () => {
    // The state run 42044644850 found: a source, destination and connection
    // from August, plus issue triggers, which an Outpost project does not ship
    // with. A fresh snapshot path is a fresh CI checkout.
    const api = fakeTwoProjects({
      [GATEWAY_KEY]: { sources: ['src_gateway'] },
      [OUTPOST_KEY]: {
        connections: ['web_leftover'],
        sources: ['src_leftover'],
        destinations: ['des_leftover'],
        'issue-triggers': ['it_leftover'],
      },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(
      api.deleted.filter((d) => d.key === OUTPOST_KEY).map((d) => d.kind)
    ).toEqual(['connections', 'sources', 'destinations', 'issue-triggers']);
    // The gateway project keeps its resources: the Outpost baseline is empty,
    // the gateway one is not.
    expect(api.ids(GATEWAY_KEY, 'sources')).toEqual(['src_gateway']);
  });

  it('does not let a crashed attempt hand its edits to the next attempt', async () => {
    // Attempts 1 -> 2 -> 3 of one cell: each is a new acquire, and none of
    // them released. The reset has to happen on the way in.
    const api = fakeTwoProjects({ [GATEWAY_KEY]: {}, [OUTPOST_KEY]: {} });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshotPath = tempSnapshotPath();

    await source(snapshotPath).acquire();
    api.add(OUTPOST_KEY, 'connections', 'web_attempt_1');
    // no release

    await source(snapshotPath).acquire();
    expect(api.ids(OUTPOST_KEY, 'connections')).toEqual([]);
  });

  it('deletes what the lease created on release', async () => {
    const api = fakeTwoProjects({ [GATEWAY_KEY]: {}, [OUTPOST_KEY]: {} });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = source();

    const lease = await s.acquire();
    api.add(OUTPOST_KEY, 'sources', 'src_agent');
    await s.release(lease);

    expect(api.ids(OUTPOST_KEY, 'sources')).toEqual([]);
  });

  it('says what it deleted, so a leftover is visible in the log', async () => {
    const api = fakeTwoProjects({
      [GATEWAY_KEY]: {},
      [OUTPOST_KEY]: { connections: ['web_leftover'] },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(warn.mock.calls.flat().join('\n')).toContain(
      'connections web_leftover'
    );
  });

  it('keeps the record of what it deleted when the reset fails partway', async () => {
    const api = fakeTwoProjects({
      [GATEWAY_KEY]: {},
      [OUTPOST_KEY]: { connections: ['web_leftover'], sources: ['src_stuck'] },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (
          init?.method === 'DELETE' &&
          String(url).endsWith('/sources/src_stuck')
        ) {
          return new Response('boom', { status: 500 });
        }
        return api.fetchImpl(url, init);
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(source().acquire()).rejects.toThrow(/500/);
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'connections web_leftover'
    );
  });

  it('refuses to reset when the Outpost key reaches the gateway project', async () => {
    // Two keys, one project. The Outpost baseline is "delete everything", which
    // would take the gateway project's default issue triggers with it.
    const api = fakeTwoProjects({
      [GATEWAY_KEY]: { sources: ['src_shared'] },
      [OUTPOST_KEY]: { sources: ['src_shared', 'src_other'] },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(api.deleted.filter((d) => d.key === OUTPOST_KEY)).toEqual([]);
    expect(warn.mock.calls.flat().join('\n')).toContain('skipped');
  });

  it('still refuses when the only shared resources are triggers the reset just recreated', async () => {
    // Restored triggers get ids a persisted snapshot does not have, so a guard
    // reading the snapshot alone would see nothing shared and delete them.
    const snapshotPath = tempSnapshotPath();
    writeFileSync(
      snapshotPath,
      JSON.stringify({ capturedAt: '2026-08-07T00:00:00.000Z', ids: {} })
    );
    const api = fakeTwoProjects(
      { [GATEWAY_KEY]: {} },
      { [OUTPOST_KEY]: GATEWAY_KEY }
    );
    vi.stubGlobal('fetch', api.fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source(snapshotPath).acquire();

    expect(warn.mock.calls.flat().join('\n')).toContain('skipped');
    expect(api.ids(GATEWAY_KEY, 'issue-triggers')).toHaveLength(4);
  });

  it('does nothing extra when both keys are the same', async () => {
    const api = fakeTwoProjects({
      [GATEWAY_KEY]: { sources: ['src_gateway'] },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    const s = new FixedProjectSource({
      apiKey: GATEWAY_KEY,
      outpostApiKey: GATEWAY_KEY,
      snapshotPath: tempSnapshotPath(),
    });

    const lease = await s.acquire();
    await s.release(lease);

    // Issue triggers are reset to declared defaults on every lease, which this
    // fake cannot type; that has its own suite below.
    expect(api.deleted.filter((d) => d.kind !== 'issue-triggers')).toEqual([]);
    expect(api.ids(GATEWAY_KEY, 'sources')).toEqual(['src_gateway']);
  });

  it('touches no Outpost project when no Outpost key is configured', async () => {
    const api = fakeTwoProjects({
      [GATEWAY_KEY]: {},
      [OUTPOST_KEY]: { connections: ['web_leftover'] },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    const prior = process.env.OUTPOST_API_KEY;
    delete process.env.OUTPOST_API_KEY;
    try {
      const s = new FixedProjectSource({
        apiKey: GATEWAY_KEY,
        snapshotPath: tempSnapshotPath(),
      });
      await s.release(await s.acquire());
    } finally {
      if (prior !== undefined) process.env.OUTPOST_API_KEY = prior;
    }

    expect(api.ids(OUTPOST_KEY, 'connections')).toEqual(['web_leftover']);
  });

  it('does not throw when the release-time reset fails', async () => {
    const api = fakeTwoProjects({ [GATEWAY_KEY]: {}, [OUTPOST_KEY]: {} });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = source();
    const lease = await s.acquire();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)
          ?.Authorization;
        if (auth === `Bearer ${OUTPOST_KEY}`) {
          return new Response('boom', { status: 500 });
        }
        return api.fetchImpl(url, init);
      })
    );

    await expect(s.release(lease)).resolves.toBeUndefined();
  });

  it('fails the acquire when the Outpost project cannot be reset', async () => {
    // Before the agent runs, nothing has been paid for, and a scenario started
    // on top of a leftover scores as though it were valid.
    const api = fakeTwoProjects({ [GATEWAY_KEY]: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)
          ?.Authorization;
        if (
          auth === `Bearer ${OUTPOST_KEY}` &&
          !new URL(String(url)).hostname.includes('outpost')
        ) {
          return new Response('boom', { status: 500 });
        }
        return api.fetchImpl(url, init);
      })
    );

    await expect(source().acquire()).rejects.toThrow(/500/);
  });
});

/**
 * Issue triggers are reset to the four a new project ships with, by content,
 * and muted. A captured snapshot failed both ways round on these: it adopted a
 * rewritten default as pristine (#28) and never recreated a deleted one (#117).
 * And a new project's defaults email every member while scenarios fail
 * deliveries on purpose, so every run emailed the team.
 */
describe('FixedProjectSource issue triggers', () => {
  beforeEach(() => vi.restoreAllMocks());

  type Trigger = Record<string, unknown>;

  const declared = (type: string) =>
    DEFAULT_ISSUE_TRIGGERS.find((d) => d.type === type)!;

  /** A trigger exactly as the reset leaves it. */
  const pristine = (type: string, created_at = '2026-08-07T10:46:14.347Z') => ({
    type,
    configs: declared(type).configs,
    channels: {},
    disabled_at: null,
    name: null,
    created_at,
  });

  const allPristine = (): Record<string, Trigger> => ({
    it_delivery: pristine('delivery'),
    it_transformation: pristine('transformation'),
    it_backpressure: pristine('backpressure'),
    it_request: pristine('request'),
  });

  function fakeTriggers(triggers: Record<string, Trigger>) {
    const state = new Map(Object.entries(triggers));
    const writes: Array<{ method: string; id?: string; body?: unknown }> = [];
    let next = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace(/^\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const [, kind, id] = path.split('/');
      if (kind !== 'issue-triggers') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === 'POST') {
        const newId = `it_new_${next++}`;
        state.set(newId, { ...body, created_at: '2026-11-06T00:00:00.000Z' });
        writes.push({ method, body });
        return new Response(JSON.stringify({ id: newId, ...state.get(newId) }));
      }
      if (method === 'PUT') {
        state.set(id, { ...state.get(id), ...body });
        writes.push({ method, id, body });
        return new Response(JSON.stringify({ id, ...state.get(id) }));
      }
      if (method === 'DELETE') {
        state.delete(id);
        writes.push({ method, id });
        return new Response('', { status: 200 });
      }
      const models = [...state].map(([rid, t]) => ({ id: rid, ...t }));
      return new Response(JSON.stringify({ models }), { status: 200 });
    });
    const byType = (type: string) =>
      [...state.values()].filter((t) => t.type === type);
    return { fetchImpl, state, writes, byType };
  }

  function source(snapshotPath = tempSnapshotPath()) {
    return new FixedProjectSource({ apiKey: 'k', snapshotPath });
  }

  it('declares the four triggers project creation makes', () => {
    expect(DEFAULT_ISSUE_TRIGGERS.map((d) => d.type).sort()).toEqual([
      'backpressure',
      'delivery',
      'request',
      'transformation',
    ]);
    expect(declared('delivery').configs).toEqual({
      strategy: 'first_attempt',
      connections: '*',
    });
  });

  it('writes nothing when the triggers already match the defaults', async () => {
    const api = fakeTriggers(allPristine());
    vi.stubGlobal('fetch', api.fetchImpl);

    const s = source();
    await s.release(await s.acquire());

    expect(api.writes).toEqual([]);
  });

  it('recreates a default a run deleted, muted', async () => {
    // The state evals-ci was in from 19 August: no delivery trigger at all.
    const { it_delivery: _gone, ...rest } = allPristine();
    const api = fakeTriggers(rest);
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(api.writes).toEqual([
      {
        method: 'POST',
        body: {
          type: 'delivery',
          configs: declared('delivery').configs,
          channels: {},
        },
      },
    ]);
  });

  it('rewrites a default a run changed, in place', async () => {
    // The state evals-ci was in from 7 August: the delivery default renamed,
    // switched to final_attempt and scoped to one connection.
    const api = fakeTriggers({
      ...allPristine(),
      it_delivery: {
        ...pristine('delivery'),
        name: 'fulfilment-delivery-failures',
        configs: { strategy: 'final_attempt', connections: ['web_gone'] },
        channels: { email: {} },
      },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(api.writes).toEqual([
      {
        method: 'PUT',
        id: 'it_delivery',
        body: {
          configs: declared('delivery').configs,
          channels: {},
          disabled_at: null,
          name: null,
        },
      },
    ]);
  });

  it('re-enables a default a run disabled', async () => {
    const api = fakeTriggers({
      ...allPristine(),
      it_request: {
        ...pristine('request'),
        disabled_at: '2026-11-06T00:00:00Z',
      },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(api.state.get('it_request')?.disabled_at).toBeNull();
  });

  it('deletes a trigger a run added, keeping the oldest of its type', async () => {
    const api = fakeTriggers({
      ...allPristine(),
      it_agent: {
        ...pristine('delivery', '2026-11-06T09:00:00.000Z'),
        channels: { email: {} },
      },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(api.writes).toEqual([{ method: 'DELETE', id: 'it_agent' }]);
    expect(api.byType('delivery')).toHaveLength(1);
  });

  it('keeps the oldest when the API lists newest first, as it does', async () => {
    const { it_delivery, ...rest } = allPristine();
    const api = fakeTriggers({
      it_agent: {
        ...pristine('delivery', '2026-11-06T09:00:00.000Z'),
        channels: { email: {} },
      },
      it_delivery,
      ...rest,
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(api.state.has('it_delivery')).toBe(true);
    expect(api.state.has('it_agent')).toBe(false);
  });

  it('warns when it deletes a trigger type it does not declare', async () => {
    // Most likely a default Hookdeck has started shipping, which an id
    // snapshot would have kept.
    const api = fakeTriggers({
      ...allPristine(),
      it_future: { type: 'something_new', channels: {}, created_at: 'x' },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    expect(api.state.has('it_future')).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'of type something_new, which DEFAULT_ISSUE_TRIGGERS does not declare'
    );
  });

  it('deletes a leftover even when a fresh snapshot recorded it as pristine', async () => {
    // In CI every job captures its own snapshot, so a leftover is in it.
    const snapshotPath = tempSnapshotPath();
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        capturedAt: '2026-11-06T00:00:00.000Z',
        ids: {
          'issue-triggers': [...Object.keys(allPristine()), 'it_leaked'],
        },
      })
    );
    const api = fakeTriggers({
      ...allPristine(),
      it_leaked: {
        ...pristine('delivery', '2026-08-20T00:00:00.000Z'),
        channels: { email: {}, slack: { channel_name: '#ops' } },
      },
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source(snapshotPath).acquire();

    expect(api.state.has('it_leaked')).toBe(false);
  });

  it('mutes the defaults, including null or missing channels, which still email', async () => {
    const api = fakeTriggers({
      it_delivery: { ...pristine('delivery'), channels: { email: {} } },
      it_transformation: { ...pristine('transformation'), channels: null },
      it_backpressure: (({ channels: _c, ...t }) => t)(
        pristine('backpressure')
      ),
      it_request: pristine('request'),
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await source().acquire();

    for (const id of ['it_delivery', 'it_transformation', 'it_backpressure']) {
      expect(api.state.get(id)?.channels).toEqual({});
    }
    expect(api.writes.map((w) => w.id)).toEqual([
      'it_delivery',
      'it_transformation',
      'it_backpressure',
    ]);
  });

  it('restores on release what the agent did to a default, after it was scored', async () => {
    // alerting-001: the agent gives the muted delivery default a channel.
    const api = fakeTriggers(allPristine());
    vi.stubGlobal('fetch', api.fetchImpl);
    const s = source();
    const lease = await s.acquire();
    api.state.set('it_delivery', {
      ...pristine('delivery'),
      channels: { email: {} },
    });

    await s.release(lease);

    expect(api.state.get('it_delivery')?.channels).toEqual({});
  });

  it('still mutes on release when the reset throws', async () => {
    const api = fakeTriggers(allPristine());
    vi.stubGlobal('fetch', api.fetchImpl);
    const s = source();
    const lease = await s.acquire();
    api.state.set('it_delivery', {
      ...pristine('delivery'),
      channels: { email: {} },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) =>
        new URL(String(url)).pathname.includes('/connections')
          ? new Response('boom', { status: 500 })
          : api.fetchImpl(url, init)
      )
    );

    await s.release(lease);

    expect(api.state.get('it_delivery')?.channels).toEqual({});
  });

  it('fails the acquire when the triggers cannot be reset', async () => {
    // Before the agent runs nothing has been paid for, and alerting-001 started
    // without its default would score as though it were valid.
    const { it_delivery: _gone, ...rest } = allPristine();
    const api = fakeTriggers(rest);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? new Response('boom', { status: 500 })
          : api.fetchImpl(url, init)
      )
    );

    await expect(source().acquire()).rejects.toThrow(/500/);
  });

  it('muteIssueTriggerNotifications skips only an empty object', async () => {
    const api = fakeTriggers({
      it_quiet: pristine('delivery'),
      it_null: { ...pristine('request'), channels: null },
      it_loud: { ...pristine('backpressure'), channels: { email: {} } },
    });
    vi.stubGlobal('fetch', api.fetchImpl);

    const muted = await muteIssueTriggerNotifications(
      new HookdeckClient({ apiKey: 'k' })
    );

    expect(muted).toEqual(['it_null', 'it_loud']);
  });
});
