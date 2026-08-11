import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { evalResultSchema } from './eval-metadata.js';

/**
 * The published format is documented in `reference/results-format.md` with a
 * sample beside it. Design work and any external consumer mock against that
 * sample, so it has to parse against the same schema the site does; a sample
 * that drifts is worse than none.
 */
describe('the documented results sample', () => {
  it('parses against the exported result schema', () => {
    const url = new URL(
      '../../../reference/results-sample.json',
      import.meta.url
    );
    const rows: unknown = JSON.parse(readFileSync(url, 'utf8'));
    expect(() => z.array(evalResultSchema).parse(rows)).not.toThrow();
  });

  it('covers the states the UI has to render', () => {
    const url = new URL(
      '../../../reference/results-sample.json',
      import.meta.url
    );
    const rows = z
      .array(evalResultSchema)
      .parse(JSON.parse(readFileSync(url, 'utf8')));

    expect(rows.some((r) => r.passed)).toBe(true);
    expect(rows.some((r) => !r.passed)).toBe(true);
    expect(rows.some((r) => r.experimentSuite === 'benchmark')).toBe(true);
    expect(rows.some((r) => r.experimentSuite === 'no-skills')).toBe(true);
    // A judged check reads differently from a deterministic one: it carries
    // judgeNotes rather than notes, and the UI needs both.
    expect(
      rows.some((r) => r.checks?.some((c) => c.judgeNotes !== undefined))
    ).toBe(true);
    expect(rows.some((r) => r.checks?.some((c) => c.notes !== undefined))).toBe(
      true
    );
    // A contaminated baseline: skills the agent fetched for itself.
    expect(rows.some((r) => (r.skills?.selfInstalled?.length ?? 0) > 0)).toBe(
      true
    );
    expect(rows.some((r) => (r.docs?.calls.length ?? 0) > 0)).toBe(true);
    expect(rows.some((r) => (r.attempts ?? 1) > 1)).toBe(true);
  });
});
