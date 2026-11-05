import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAttemptRecord,
  shouldRecordSupersededAttempt,
  type AttemptRecord,
} from '../harness/attempts.js';
import {
  attemptRan,
  clearErroredEvidence,
  describeErroredEvidence,
  ERRORED_RUNS_DIRNAME,
  erroredEvidencePath,
  newAttemptLoopState,
  readErroredEvidenceTree,
  settleAttempt,
  writeErroredEvidence,
  type AttemptLoopState,
  type ErroredEvidence,
} from '../harness/errored-cell.js';
import type {
  DocsResult,
  SkillResult,
  TranscriptPart,
} from '../harness/types.js';

const transcript: TranscriptPart[] = [
  {
    type: 'assistant_message',
    text: 'Hookdeck filters support a regex operator on the payload.',
  } as unknown as TranscriptPart,
];
const skills: SkillResult = { available: [], loaded: [] };
const docs: DocsResult = { calls: [] };

function attemptOne(): AttemptRecord {
  return buildAttemptRecord({
    attempt: 1,
    result: {
      passed: false,
      checks: [{ name: 'did not claim regex filtering exists', passed: false }],
    },
    stoppedReason: 'end_turn',
    agentReport: 'Added a regex filter.',
    transcript,
    skills,
    docs,
  });
}

function inFlight(attempt: number, stoppedReason = 'end_turn') {
  return { attempt, stoppedReason, agentReport: '', transcript, skills, docs };
}

/**
 * The transitions `runOne` makes, tested directly. Reverting either the shared
 * array or the rule for clearing `current` breaks one of these.
 */
describe('attempt state transitions', () => {
  it('records into the array the caller holds', () => {
    const loop = newAttemptLoopState();
    const held = loop.priorAttempts;
    attemptRan(loop, inFlight(1));
    settleAttempt(loop, attemptOne());
    expect(held.map((a) => a.attempt)).toEqual([1]);
    expect(loop.current).toBeUndefined();
  });

  it('marks the attempt whose agent has run as in flight', () => {
    const loop = newAttemptLoopState();
    attemptRan(loop, inFlight(1, 'error_exit_255'));
    expect(loop.current?.stoppedReason).toBe('error_exit_255');
  });

  /**
   * The final attempt is reported by the result, not superseded. It must stay
   * in flight, because the session and sandbox teardown runs after the loop
   * body, and a teardown that throws would otherwise lose it from both
   * `priorAttempts` and `erroredAttempt`.
   */
  it('keeps the reported attempt in flight through teardown', () => {
    const loop = newAttemptLoopState();
    attemptRan(loop, inFlight(1));
    settleAttempt(loop, attemptOne());
    attemptRan(loop, inFlight(2));
    settleAttempt(loop, undefined);
    expect(loop.current?.attempt).toBe(2);
    expect(loop.priorAttempts.map((a) => a.attempt)).toEqual([1]);
  });
});

/**
 * The loop in `runOne`, reduced to its decisions, making the same calls. `run-eval.ts` calls `main()` at module scope and so
 * cannot be imported here, the same reason `attempts.test.ts` replays the rule
 * rather than the file.
 *
 * Each attempt either scores (`true`/`false`) or throws the way one of the two
 * guards does (`'dead'`).
 */
async function replayLoop(
  outcomes: Array<boolean | 'dead'>,
  runs: number,
  loop: AttemptLoopState
): Promise<{ passed: boolean; priorAttempts: AttemptRecord[] }> {
  for (let attempt = 1; attempt <= runs; attempt += 1) {
    const outcome = outcomes[attempt - 1] ?? false;
    attemptRan(
      loop,
      inFlight(attempt, outcome === 'dead' ? 'error_exit_255' : 'end_turn')
    );
    if (outcome === 'dead') {
      throw new Error(
        'the agent process did not exit cleanly (stoppedReason: error_exit_255)'
      );
    }
    if (outcome) return { passed: true, priorAttempts: loop.priorAttempts };
    settleAttempt(
      loop,
      shouldRecordSupersededAttempt({
        attempt,
        runs,
        passed: outcome,
        stopOnPass: true,
      })
        ? { ...attemptOne(), attempt }
        : undefined
    );
  }
  return { passed: false, priorAttempts: loop.priorAttempts };
}

/** Runs the loop to a throw, returning the state the caller is left with. */
async function erroredState(
  outcomes: Array<boolean | 'dead'>,
  runs: number
): Promise<{ state: AttemptLoopState; error: unknown }> {
  const state = newAttemptLoopState();
  const error = await replayLoop(outcomes, runs, state).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(Error);
  return { state, error };
}

describe('caller-owned attempt state', () => {
  /** The scenario #97 was filed for, on CI's default `--runs 2`. */
  it('keeps attempt 1 when attempt 2 dies', async () => {
    const { state } = await erroredState([false, 'dead'], 2);
    expect(state.priorAttempts.map((a) => a.attempt)).toEqual([1]);
    expect(state.priorAttempts[0].agentReport).toBe('Added a regex filter.');
    expect(state.current?.attempt).toBe(2);
    expect(state.current?.stoppedReason).toBe('error_exit_255');
  });

  it('keeps both earlier attempts when the third of three dies', async () => {
    const { state } = await erroredState([false, false, 'dead'], 3);
    expect(state.priorAttempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(state.current?.attempt).toBe(3);
  });

  it('has nothing earlier to keep when the first attempt dies', async () => {
    const { state } = await erroredState(['dead'], 3);
    expect(state.priorAttempts).toEqual([]);
    expect(state.current?.attempt).toBe(1);
  });

  it('leaves only the reported attempt in flight after a loop that finishes', async () => {
    const state = newAttemptLoopState();
    await expect(replayLoop([false, false], 2, state)).resolves.toMatchObject({
      passed: false,
    });
    expect(state.current?.attempt).toBe(2);
    expect(state.priorAttempts.map((a) => a.attempt)).toEqual([1]);
  });
});

describe('writeErroredEvidence', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'errored-cell-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The invariant the guards exist for: an errored cell writes no result
   * file. Everything it writes is under its own top-level directory, never
   * under `.eval-runs/`, which is what the exporter reads.
   */
  it('writes only outside .eval-runs', async () => {
    const { state, error } = await erroredState([false, 'dead'], 2);
    const out = writeErroredEvidence(root, {
      experiment: 'codex-gpt-5.4-mini',
      evalId: 'regression-filtering-001-regex-capability',
      error,
      state,
    });
    expect(out).toBe(
      erroredEvidencePath(
        root,
        'codex-gpt-5.4-mini',
        'regression-filtering-001-regex-capability'
      )
    );
    expect(relative(root, out!).split(sep)[0]).toBe(ERRORED_RUNS_DIRNAME);
    expect(ERRORED_RUNS_DIRNAME).not.toBe('.eval-runs');
    expect(existsSync(join(root, '.eval-runs'))).toBe(false);
  });

  /**
   * Nothing that reads result files can mistake this for one: no top-level
   * `passed`, `checks` or `transcript`. `replay-judge.ts` walks recursively and
   * skips any JSON without a top-level `transcript`.
   */
  it('cannot be read as a result', async () => {
    const { state, error } = await erroredState([false, 'dead'], 2);
    const out = writeErroredEvidence(root, {
      experiment: 'claude-code-sonnet-5',
      evalId: 'benchmark-x',
      error,
      state,
      runId: '123',
    });
    const parsed = JSON.parse(readFileSync(out!, 'utf8')) as ErroredEvidence &
      Record<string, unknown>;
    expect(parsed.errored).toBe(true);
    expect(parsed).not.toHaveProperty('passed');
    expect(parsed).not.toHaveProperty('checks');
    expect(parsed).not.toHaveProperty('transcript');
    expect(parsed.runId).toBe('123');
    expect(parsed.error).toContain('did not exit cleanly');
    expect(parsed.priorAttempts[0].transcript).toEqual(transcript);
    expect(parsed.erroredAttempt?.stoppedReason).toBe('error_exit_255');
  });

  it('is redacted like every other artifact', () => {
    const state: AttemptLoopState = {
      priorAttempts: [
        {
          ...attemptOne(),
          agentReport: 'HOOKDECK_API_KEY=supersecretvalue1234',
        },
      ],
    };
    const out = writeErroredEvidence(
      root,
      { experiment: 'e', evalId: 'v', error: new Error('boom'), state },
      [{ name: 'HOOKDECK_API_KEY', value: 'supersecretvalue1234' }]
    );
    const text = readFileSync(out!, 'utf8');
    expect(text).not.toContain('supersecretvalue1234');
    expect(text).toContain('<redacted:HOOKDECK_API_KEY>');
  });

  /**
   * An error before any agent ran — importing the scorer, starting the first
   * session — has nothing to keep, and should not leave a file that reads as
   * though it did.
   */
  it('writes nothing when no agent ran', () => {
    const out = writeErroredEvidence(root, {
      experiment: 'e',
      evalId: 'v',
      error: new Error('could not import the scorer'),
      state: newAttemptLoopState(),
    });
    expect(out).toBeUndefined();
    expect(existsSync(join(root, ERRORED_RUNS_DIRNAME))).toBe(false);
  });

  /** A session that will not start on attempt 2 still loses nothing. */
  it('keeps earlier attempts for an error between attempts', () => {
    const out = writeErroredEvidence(root, {
      experiment: 'e',
      evalId: 'v',
      error: new Error('could not lease a project'),
      state: { priorAttempts: [attemptOne()] },
    });
    const parsed = JSON.parse(readFileSync(out!, 'utf8')) as ErroredEvidence;
    expect(parsed.priorAttempts).toHaveLength(1);
    expect(parsed).not.toHaveProperty('erroredAttempt');
  });

  it('is cleared before the cell runs again', async () => {
    const { state, error } = await erroredState(['dead'], 1);
    const out = writeErroredEvidence(root, {
      experiment: 'e',
      evalId: 'v',
      error,
      state,
    });
    expect(existsSync(out!)).toBe(true);
    clearErroredEvidence(root, 'e', 'v');
    expect(existsSync(out!)).toBe(false);
    // And clearing what is not there is not an error.
    expect(() => clearErroredEvidence(root, 'e', 'v')).not.toThrow();
  });
});

describe('describeErroredEvidence', () => {
  it('leads with the missing row and names what was kept', () => {
    const line = describeErroredEvidence({
      error: 'the agent process did not exit cleanly\nmore detail',
      priorAttempts: [attemptOne()],
      erroredAttempt: {
        attempt: 2,
        stoppedReason: 'error_exit_255',
        agentReport: '',
        transcript,
        skills,
        docs,
      },
    });
    expect(line).toBe(
      'no result written; 1 earlier attempt(s) kept (#1 failed, end_turn), ' +
        'attempt 2 errored with 1 transcript event(s). ' +
        'the agent process did not exit cleanly'
    );
  });

  it('says so when there was nothing earlier', () => {
    expect(describeErroredEvidence({ error: 'boom', priorAttempts: [] })).toBe(
      'no result written; no earlier attempts. boom'
    );
  });
});

describe('readErroredEvidenceTree', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'errored-tree-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The three layouts evidence arrives in. See the function's comment. */
  it('reads the harness layout, a flat download and a nested one', async () => {
    const { state, error } = await erroredState([false, 'dead'], 2);
    // Harness layout: .eval-errored/<experiment>/<eval>.json
    writeErroredEvidence(root, {
      experiment: 'a',
      evalId: 'one',
      error,
      state,
    });
    const harnessFile = erroredEvidencePath(root, 'a', 'one');
    const body = readFileSync(harnessFile, 'utf8');
    const dir = join(root, ERRORED_RUNS_DIRNAME);
    // Flat: gh run download --name errored-attempts-a__two --dir .eval-errored
    writeFileSync(join(dir, 'two.json'), body);
    // Nested: gh run download of several artifacts
    mkdirSync(join(dir, 'errored-attempts-a__three'));
    writeFileSync(join(dir, 'errored-attempts-a__three', 'three.json'), body);

    const { found, unreadable } = readErroredEvidenceTree(dir);
    expect(found.map((f) => f.path).sort()).toEqual([
      'a/one.json',
      'errored-attempts-a__three/three.json',
      'two.json',
    ]);
    expect(unreadable).toEqual([]);
  });

  it('reports a corrupt file instead of throwing', async () => {
    const { state, error } = await erroredState(['dead'], 1);
    writeErroredEvidence(root, { experiment: 'a', evalId: 'ok', error, state });
    const dir = join(root, ERRORED_RUNS_DIRNAME);
    writeFileSync(join(dir, 'a', 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'a', 'row.json'), '{"experiment":"a","eval":"x"}');

    const { found, unreadable } = readErroredEvidenceTree(dir);
    expect(found.map((f) => f.path)).toEqual(['a/ok.json']);
    expect(unreadable.map((u) => u.path).sort()).toEqual([
      'a/broken.json',
      'a/row.json',
    ]);
  });

  it('is empty when the directory does not exist', () => {
    expect(readErroredEvidenceTree(join(root, 'nope'))).toEqual({
      found: [],
      unreadable: [],
    });
  });
});
