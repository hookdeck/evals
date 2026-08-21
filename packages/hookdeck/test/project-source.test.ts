import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedProjectSource, type PristineSnapshot } from '../src/index.js';

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

  it('preserves the default issue triggers a new project ships with', async () => {
    // The whole reason reset is to pristine rather than to empty: deleting the
    // defaults would change what BM4 tests and drift the project irreversibly.
    const { fetchImpl, deleted } = fakeApi({
      'issue-triggers': ['it_default_1', 'it_default_2'],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const snapshotPath = tempSnapshotPath();
    const source = new FixedProjectSource({ apiKey: 'k', snapshotPath });

    await source.acquire();
    await source.acquire();

    expect(deleted).toEqual([]);
  });

  it('deletes what a previous run added, keeping the defaults', async () => {
    const { fetchImpl, deleted, state } = fakeApi({
      'issue-triggers': ['it_default'],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const snapshotPath = tempSnapshotPath();
    const source = new FixedProjectSource({ apiKey: 'k', snapshotPath });

    await source.acquire();
    // a run leaves resources behind, including an extra trigger
    state.set('sources', new Set(['src_leftover']));
    state.get('issue-triggers')!.add('it_from_a_run');

    await source.acquire();

    expect(deleted).toEqual([
      { kind: 'sources', id: 'src_leftover' },
      { kind: 'issue-triggers', id: 'it_from_a_run' },
    ]);
    expect(state.get('issue-triggers')).toContain('it_default');
  });

  it('self-heals after a run that crashed without releasing', async () => {
    // Reset keys off the snapshot, not a per-run timestamp, so leftovers from a
    // crashed run are cleaned by the next acquire rather than accumulating.
    const { fetchImpl, state } = fakeApi({ 'issue-triggers': ['it_default'] });
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
        ids: { 'issue-triggers': ['it_default'] },
      })
    );
    const { fetchImpl, deleted } = fakeApi({
      'issue-triggers': ['it_default', 'it_added_later'],
    });
    vi.stubGlobal('fetch', fetchImpl);

    await new FixedProjectSource({ apiKey: 'k', snapshotPath }).acquire();

    expect(deleted).toEqual([{ kind: 'issue-triggers', id: 'it_added_later' }]);
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
