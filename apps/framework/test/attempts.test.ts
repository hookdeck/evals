import { describe, expect, it } from 'vitest';
import {
  buildAttemptRecord,
  shouldRecordSupersededAttempt,
  type AttemptRecord,
} from '../harness/attempts.js';
import { serializeRedacted } from '../harness/redact.js';
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

/** The real shapes, so the record is pinned against what gets serialized. */
const skills: SkillResult = {
  available: ['event-gateway'],
  loaded: ['event-gateway'],
};
const docs: DocsResult = { calls: [] };

const input = {
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
};

describe('buildAttemptRecord', () => {
  it('keeps what the agent said on the attempt that was thrown away', () => {
    const record = buildAttemptRecord(input);
    expect(record.attempt).toBe(1);
    expect(record.passed).toBe(false);
    expect(record.transcript).toEqual(transcript);
    expect(record.agentReport).toBe('Added a regex filter.');
    expect(record.checks[0].name).toBe('did not claim regex filtering exists');
    expect(record.skills).toEqual(skills);
    expect(record.docs).toEqual(docs);
  });

  /**
   * The omission is the design, not an oversight: the transcript already holds
   * the same tool-call events, and `ToolCallRecord` is the normalized projection
   * that scorers consume. If this starts carrying them, the reason should be
   * that something re-scores a stored attempt — nothing does today.
   */
  it('does not carry toolCalls', () => {
    expect(Object.keys(buildAttemptRecord(input))).not.toContain('toolCalls');
  });

  it('records a pass, which --run-all-attempts can supersede', () => {
    const record = buildAttemptRecord({
      ...input,
      result: { passed: true, checks: [] },
    });
    expect(record.passed).toBe(true);
  });

  it('tolerates a result with no checks', () => {
    expect(
      buildAttemptRecord({ ...input, result: { passed: false } }).checks
    ).toEqual([]);
  });

  /**
   * Redaction runs over the serialized artifact rather than a list of fields, so
   * a transcript nested inside a prior attempt is covered by construction. This
   * asserts it, because the whole point of keeping these is that they are
   * written to an artifact anyone can download.
   */
  it('is redacted along with the rest of the artifact', () => {
    const leaky = buildAttemptRecord({
      ...input,
      agentReport: 'I used HOOKDECK_API_KEY=supersecretvalue1234 to connect.',
    });
    const serialized = serializeRedacted({ priorAttempts: [leaky] }, [
      { name: 'HOOKDECK_API_KEY', value: 'supersecretvalue1234' },
    ]);
    expect(serialized).not.toContain('supersecretvalue1234');
    expect(serialized).toContain('<redacted:HOOKDECK_API_KEY>');
    const parsed = JSON.parse(serialized) as { priorAttempts: AttemptRecord[] };
    expect(parsed.priorAttempts[0].attempt).toBe(1);
  });
});

/**
 * The rule the loop applies. Asserted here rather than in `run-eval.ts`, which
 * calls `main()` at module scope and so cannot be imported by a test.
 *
 * Each case walks one real path and checks the invariant that falls out:
 * `priorAttempts.length === attempts - 1`.
 */
describe('shouldRecordSupersededAttempt', () => {
  /** Replays the loop's decision for every attempt, returning what it kept. */
  function recorded(
    outcomes: boolean[],
    runs: number,
    stopOnPass = true
  ): { kept: number[]; reported: number } {
    const kept: number[] = [];
    for (let attempt = 1; attempt <= runs; attempt += 1) {
      const passed = outcomes[attempt - 1] ?? false;
      if (stopOnPass && passed) return { kept, reported: attempt };
      if (shouldRecordSupersededAttempt({ attempt, runs, passed, stopOnPass }))
        kept.push(attempt);
    }
    return { kept, reported: runs };
  }

  it.each([
    { name: 'runs=1, pass', outcomes: [true], runs: 1, kept: [], reported: 1 },
    { name: 'runs=1, fail', outcomes: [false], runs: 1, kept: [], reported: 1 },
    {
      name: 'pass on 1 of 3',
      outcomes: [true],
      runs: 3,
      kept: [],
      reported: 1,
    },
    {
      name: 'pass on 2 of 3',
      outcomes: [false, true],
      runs: 3,
      kept: [1],
      reported: 2,
    },
    {
      name: 'all 3 fail',
      outcomes: [false, false, false],
      runs: 3,
      kept: [1, 2],
      reported: 3,
    },
    {
      name: 'min_attempts floor of 3, pass on 2',
      outcomes: [false, true],
      runs: 3,
      kept: [1],
      reported: 2,
    },
  ])('$name', ({ outcomes, runs, kept, reported }) => {
    const result = recorded(outcomes, runs);
    expect(result.kept).toEqual(kept);
    expect(result.reported).toBe(reported);
    // The invariant: one record per attempt that ran, minus the reported one.
    expect(result.kept.length).toBe(result.reported - 1);
  });

  /**
   * `--run-all-attempts` reports the last attempt regardless, so an earlier
   * pass is superseded by a later failure and must still be recorded.
   */
  it('records an early pass under --run-all-attempts', () => {
    const result = recorded([true, false, false], 3, false);
    expect(result.kept).toEqual([1, 2]);
    expect(result.reported).toBe(3);
  });
});
