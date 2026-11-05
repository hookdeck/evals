import { rawEvalResultSchema } from '@hookdeck-evals/core/eval-metadata';
import { describe, expect, it } from 'vitest';
import {
  assessCoverage,
  readExpectedPairs,
  sanitizeCarried,
  splitStale,
} from '../lib/merge-results.js';

const row = (
  experiment: string,
  evalId: string,
  extra: Record<string, unknown> = {}
) => ({
  experiment,
  eval: evalId,
  passed: true,
  sourcePath: `${experiment}/${evalId}.json`,
  ...extra,
});

describe('splitStale', () => {
  const fresh = [
    row('a', 'e1', { provenance: { harness: 'H2', scenario: 'S1-new' } }),
  ];

  it('flags rows with no provenance, which every published row was until #96', () => {
    const { current, stale } = splitStale([row('b', 'e2')], fresh);
    expect(current).toHaveLength(0);
    expect(stale.map((s) => s.why)).toEqual(['no provenance recorded']);
  });

  it('flags a harness change against every carried row', () => {
    const carried = [
      row('b', 'e2', { provenance: { harness: 'H1', scenario: 'S2' } }),
    ];
    expect(splitStale(carried, fresh).stale.map((s) => s.why)).toEqual([
      'harness changed',
    ]);
  });

  it('flags a scenario change only for that scenario', () => {
    const carried = [
      row('b', 'e1', { provenance: { harness: 'H2', scenario: 'S1-old' } }),
      row('b', 'e2', { provenance: { harness: 'H2', scenario: 'S2' } }),
    ];
    const { current, stale } = splitStale(carried, fresh);
    expect(stale.map((s) => [s.row.eval, s.why])).toEqual([
      ['e1', 'scenario changed'],
    ]);
    expect(current.map((r) => r.eval)).toEqual(['e2']);
  });
});

describe('sanitizeCarried', () => {
  it('strips fields the published row does not whitelist', () => {
    // The carried path used to spread rows verbatim, so a transcript that
    // reached the file by any route other than this exporter would have been
    // republished on every merge.
    const { rows, rejected } = sanitizeCarried([
      row('a', 'e1', {
        transcript: [{ type: 'assistant_message', text: 'secret' }],
        provenance: { harness: 'H', scenario: 'S' },
      }),
    ]);
    expect(rejected).toEqual([]);
    expect(rows[0]).not.toHaveProperty('transcript');
    expect(rows[0].provenance).toEqual({ harness: 'H', scenario: 'S' });
  });

  it('keeps every provenance field the harness records, on both paths', () => {
    // `provenance` is a plain `z.object`, which strips keys it does not name.
    // A field the harness adds without a schema change vanishes silently, as
    // `provenance` itself did until #96. `skillsPin` is the one #102 adds.
    const provenance = {
      harness: 'H',
      scenario: 'S',
      skillsPin: '6ea10a4baf8114d54bdfed8a31c85b9b4d4f91db',
    };
    // Fresh: `readResultFile` copies `provenance` from this parse.
    const fresh = rawEvalResultSchema.parse(row('a', 'e1', { provenance }));
    expect(fresh.provenance).toEqual(provenance);
    // Carried: re-parsed with the published row's schema.
    const { rows } = sanitizeCarried([row('a', 'e1', { provenance })]);
    expect(rows[0].provenance).toEqual(provenance);
  });

  it("keeps a docs call's httpError in all three states, so a carried row is classified as it was published", () => {
    // `null` is the marker that a fetch was checked: if this path dropped it,
    // a carried row would fall back to length inference and a real page of the
    // stub's size would be republished as an error.
    const calls = [
      {
        source: 'web_fetch',
        query: 'ok',
        hasContent: true,
        pages: [{ url: 'https://hookdeck.com/docs/a' }],
        resultChars: 215,
        httpError: null,
      },
      {
        source: 'web_fetch',
        query: 'missing',
        hasContent: true,
        pages: [{ url: 'https://hookdeck.com/docs/b' }],
        resultChars: 215,
        httpError: 404,
      },
      {
        source: 'web_fetch',
        query: 'legacy',
        hasContent: true,
        pages: [{ url: 'https://hookdeck.com/docs/c' }],
        resultChars: 215,
      },
    ];
    const { rows, rejected } = sanitizeCarried([
      row('a', 'e1', { docs: { calls } }),
    ]);
    expect(rejected).toEqual([]);
    const kept = rows[0].docs?.calls ?? [];
    expect(kept[0].httpError).toBeNull();
    expect(kept[1].httpError).toBe(404);
    expect('httpError' in kept[2]).toBe(false);
  });

  it('rejects, and names, a row that no longer parses', () => {
    const { rows, rejected } = sanitizeCarried([
      row('a', 'e1', { stage: 'deploy' }),
    ]);
    expect(rows).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].key).toBe('e1 x a');
    expect(rejected[0].reason).toContain('stage');
  });
});

describe('readExpectedPairs', () => {
  const pairs = [
    {
      eval_id: 'b-1',
      experiment: 'x',
      experiment_suite: 'benchmark',
      eval_suite: 'benchmark',
    },
    {
      eval_id: 'b-1',
      experiment: 'x-no-skills',
      experiment_suite: 'no-skills',
      eval_suite: 'benchmark',
    },
    {
      eval_id: 'r-1',
      experiment: 'x',
      experiment_suite: 'regression',
      eval_suite: 'regression',
    },
  ];

  it('narrows to the suite being exported', () => {
    expect(
      readExpectedPairs(pairs, (p) => p.evalSuite === 'benchmark')
    ).toEqual([
      { experiment: 'x', eval: 'b-1' },
      { experiment: 'x-no-skills', eval: 'b-1' },
    ]);
  });

  it('refuses a pair it cannot identify rather than guessing', () => {
    expect(() => readExpectedPairs([{ experiment: 'x' }], () => true)).toThrow(
      /eval_id/
    );
  });
});

describe('assessCoverage', () => {
  const expected = Array.from({ length: 20 }, (_, i) => ({
    experiment: 'x',
    eval: `e${String(i).padStart(2, '0')}`,
  }));
  const freshAllBut = (n: number) =>
    expected.slice(n).map((p) => row(p.experiment, p.eval));

  it('publishes a full run with nothing to report', () => {
    const fresh = freshAllBut(0);
    const c = assessCoverage(expected, fresh, fresh, 0.1);
    expect(c).toMatchObject({ expected: 20, measured: 20, refuse: false });
    expect(c.missing).toEqual([]);
  });

  it('publishes one errored cell, and says what stands in for it (#80)', () => {
    const fresh = freshAllBut(1);
    const old = row('x', 'e00', { ranAt: '2026-09-28T10:00:00Z' });
    const c = assessCoverage(expected, fresh, [old, ...fresh], 0.1);
    expect(c.refuse).toBe(false);
    expect(c.missing).toEqual([{ experiment: 'x', eval: 'e00', carried: old }]);
  });

  it('reports a missing cell with nothing carried as absent', () => {
    const fresh = freshAllBut(1);
    const c = assessCoverage(expected, fresh, fresh, 0.1);
    expect(c.missing).toEqual([{ experiment: 'x', eval: 'e00' }]);
  });

  it('refuses past the floor, rounding the allowance down', () => {
    // 10% of 20 is 2: two missing is publishable, three is not.
    expect(
      assessCoverage(expected, freshAllBut(2), freshAllBut(2), 0.1).refuse
    ).toBe(false);
    const c = assessCoverage(expected, freshAllBut(3), freshAllBut(3), 0.1);
    expect(c.allowedMissing).toBe(2);
    expect(c.refuse).toBe(true);
  });

  it('allows nothing missing from a small run', () => {
    // A one-cell dispatch whose cell errored has nothing new to publish.
    const one = expected.slice(0, 1);
    expect(assessCoverage(one, [], [], 0.1).refuse).toBe(true);
  });

  it('does not count a carried row as measured', () => {
    // The carried row is in the output, but this run did not produce it.
    const old = row('x', 'e00');
    const c = assessCoverage(expected.slice(0, 1), [], [old], 0.5);
    expect(c.measured).toBe(0);
    expect(c.missing[0].carried).toBe(old);
  });
});
