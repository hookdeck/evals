import { describe, expect, it } from 'vitest';
import { buildAttemptRecord, type AttemptRecord } from '../harness/attempts.js';
import { serializeRedacted } from '../harness/redact.js';
import type { TranscriptPart } from '../harness/types.js';

const transcript = [
  {
    type: 'text' as const,
    text: 'Hookdeck filters support a regex operator on the payload.',
  },
] as unknown as TranscriptPart[];

const input = {
  attempt: 1,
  result: {
    passed: false,
    checks: [{ name: 'did not claim regex filtering exists', passed: false }],
  },
  stoppedReason: 'end_turn',
  agentReport: 'Added a regex filter.',
  transcript,
  skills: { available: ['event-gateway'], used: ['event-gateway'] },
  docs: { fetched: [] },
} as unknown as Parameters<typeof buildAttemptRecord>[0];

describe('buildAttemptRecord', () => {
  it('keeps what the agent said on the attempt that was thrown away', () => {
    const record = buildAttemptRecord(input);
    expect(record.attempt).toBe(1);
    expect(record.passed).toBe(false);
    expect(record.transcript).toEqual(transcript);
    expect(record.agentReport).toBe('Added a regex filter.');
    expect(record.checks[0].name).toBe('did not claim regex filtering exists');
  });

  /**
   * The omission is the design, not an oversight: `toolCalls` is a parsed
   * projection of the transcript's own events and the two are the largest
   * fields in the artifact. If this starts carrying them, the reason should be
   * that something consumes them (`score-only` would).
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
    const record = buildAttemptRecord({
      ...input,
      result: { passed: false },
    });
    expect(record.checks).toEqual([]);
  });

  /**
   * Redaction runs over the serialized artifact rather than a list of fields,
   * so a transcript nested inside a prior attempt is covered by construction.
   * This asserts that, because the whole point of keeping these is that they
   * are written to a public artifact.
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
    const parsed = JSON.parse(serialized) as {
      priorAttempts: AttemptRecord[];
    };
    expect(parsed.priorAttempts[0].attempt).toBe(1);
  });
});
