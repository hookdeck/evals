import { describe, expect, it } from 'vitest';
import {
  describeComposition,
  summarizeComposition,
} from '../lib/snapshot-composition.js';

describe('describeComposition', () => {
  it('describes a single-run snapshot as not mixed', () => {
    const rows = [
      { runId: '200', ranAt: '2026-11-05T09:00:00Z' },
      { runId: '200', ranAt: '2026-11-05T11:00:00Z' },
    ];
    expect(describeComposition(rows, '200')).toEqual({
      mixed: false,
      ranAt: {
        earliest: '2026-11-05T09:00:00Z',
        latest: '2026-11-05T11:00:00Z',
      },
      carried: 0,
      runs: [
        {
          runId: '200',
          rows: 2,
          earliest: '2026-11-05T09:00:00Z',
          latest: '2026-11-05T11:00:00Z',
        },
      ],
    });
  });

  it('says a merged snapshot mixes runs, and how many rows were carried', () => {
    // The shape of `results/latest.json` on 28 September: 76 rows from the run
    // that published it and 38 carried from 1 September, under one date.
    const rows = [
      ...Array.from({ length: 76 }, () => ({
        runId: '36386178039',
        ranAt: '2026-09-28T08:00:00Z',
      })),
      ...Array.from({ length: 38 }, () => ({
        runId: '33484972784',
        ranAt: '2026-09-01T12:00:00Z',
      })),
    ];
    const c = describeComposition(rows, '36386178039');
    expect(c.mixed).toBe(true);
    expect(c.carried).toBe(38);
    expect(c.ranAt).toEqual({
      earliest: '2026-09-01T12:00:00Z',
      latest: '2026-09-28T08:00:00Z',
    });
    expect(c.runs.map((r) => [r.runId, r.rows])).toEqual([
      ['36386178039', 76],
      ['33484972784', 38],
    ]);
    expect(summarizeComposition(c)).toContain('38 carried');
  });

  it('treats rows with no runId as mixed rather than as one run', () => {
    // Unknowable is not the same as single, and "one run" is a claim.
    const c = describeComposition([{ ranAt: '2026-08-13T00:00:00Z' }]);
    expect(c.mixed).toBe(true);
    expect(c.runs[0].runId).toBeNull();
    expect(c).not.toHaveProperty('carried');
  });

  it('counts every row as carried when the publishing run measured none', () => {
    const c = describeComposition([{ runId: '1' }, { runId: '1' }], '2');
    expect(c.carried).toBe(2);
    expect(c.mixed).toBe(false);
  });
});
