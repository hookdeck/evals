import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rawEvalResultSchema } from '@hookdeck-evals/core/eval-metadata';
import { buildAttemptRecord } from '../harness/attempts.js';
import {
  attemptRan,
  newAttemptLoopState,
  settleAttempt,
  writeErroredEvidence,
} from '../harness/errored-cell.js';
import { whyNotAResultRow } from '../lib/raw-result.js';

const skills = { available: [], loaded: [] };
const docs = { calls: [] };

/**
 * What `export-results.ts` decides about a file before it builds a row:
 * `whyNotAResultRow`, then the loose schema. Replayed here because the script
 * runs `main()` at module scope and cannot be imported.
 */
function exporterAccepts(parsed: unknown): boolean {
  return (
    whyNotAResultRow(parsed) === undefined &&
    rawEvalResultSchema.safeParse(parsed).success
  );
}

describe('whyNotAResultRow', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'raw-result-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The case the review of #97 found. Evidence copied into `.eval-runs/` —
   * which rebuilding it from a `gh run download` tree can do, because both
   * artifacts use the `<eval>.json` layout — parses under the loose schema and
   * used to export as a failure with no checks.
   */
  it('refuses real errored-cell evidence that the loose schema accepts', () => {
    const loop = newAttemptLoopState();
    attemptRan(loop, {
      attempt: 1,
      stoppedReason: 'end_turn',
      agentReport: 'Added a regex filter.',
      transcript: [],
      skills,
      docs,
    });
    settleAttempt(
      loop,
      buildAttemptRecord({
        attempt: 1,
        result: { passed: false, checks: [] },
        stoppedReason: 'end_turn',
        agentReport: 'Added a regex filter.',
        transcript: [],
        skills,
        docs,
      })
    );
    attemptRan(loop, {
      attempt: 2,
      stoppedReason: 'error_exit_255',
      agentReport: '',
      transcript: [],
      skills,
      docs,
    });
    const out = writeErroredEvidence(root, {
      experiment: 'claude-code-sonnet-5',
      evalId: 'regression-filtering-001-regex-capability',
      error: new Error('the agent process did not exit cleanly'),
      state: loop,
    });
    const parsed: unknown = JSON.parse(readFileSync(out!, 'utf8'));

    // The hole: on schema alone this is a row.
    expect(rawEvalResultSchema.safeParse(parsed).success).toBe(true);
    // And it is closed.
    expect(whyNotAResultRow(parsed)).toMatch(/errored-cell evidence/);
    expect(exporterAccepts(parsed)).toBe(false);
  });

  it('refuses a file that names a cell but carries no boolean passed', () => {
    const parsed = { experiment: 'claude-code-sonnet-5', eval: 'x' };
    expect(rawEvalResultSchema.safeParse(parsed).success).toBe(true);
    expect(whyNotAResultRow(parsed)).toMatch(/no boolean `passed`/);
    expect(
      whyNotAResultRow({ ...parsed, passed: 'false' }) ?? 'accepted'
    ).toMatch(/no boolean `passed`/);
  });

  it('refuses something that is not an object', () => {
    expect(whyNotAResultRow(null)).toBe('not a JSON object');
    expect(whyNotAResultRow([])).toMatch(/no boolean `passed`/);
  });

  it('accepts what the harness writes for a failing cell', () => {
    const row = {
      experiment: 'claude-code-sonnet-5',
      eval: 'regression-filtering-001-regex-capability',
      passed: false,
      checks: [{ name: 'did not claim regex filtering exists', passed: false }],
      attempts: 2,
      priorAttempts: [],
    };
    expect(whyNotAResultRow(row)).toBeUndefined();
    expect(exporterAccepts(row)).toBe(true);
  });
});
