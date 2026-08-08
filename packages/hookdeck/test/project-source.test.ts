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
