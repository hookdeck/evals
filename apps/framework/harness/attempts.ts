/**
 * What we keep from an attempt that was superseded by a later one.
 *
 * A scenario with `--runs 3` stops at the first pass, and until this file
 * existed the harness kept only the attempt it stopped on. Every earlier
 * attempt — the failing ones — was overwritten in `lastTranscript` and lost.
 *
 * That is exactly backwards for the regression suite, whose scenarios exist to
 * record a specific wrong answer. On 5 October 2026
 * `regression-filtering-001-regex-capability` failed, was re-run, passed on
 * attempt two, and the artifact we kept was the *correct* answer. The wrong one
 * — the only thing that scenario is there to capture — was gone, so nobody
 * could read what the agent actually claimed. See #92.
 *
 * Two things make this safe to write to disk:
 *
 * 1. **Redaction is on the whole artifact.** `serializeRedacted` runs over the
 *    serialized file, not a list of fields, so a transcript added here is
 *    redacted by construction rather than by remembering to.
 * 2. **The exporter whitelists.** `scripts/export-results.ts` builds each
 *    published row field by field and no transcript is among them, so nothing
 *    here reaches `results/`. These stay in the run artifact, which is where
 *    the evidence belongs.
 */
import type {
  CheckResult,
  DocsResult,
  ScoreResult,
  SkillResult,
  TranscriptPart,
} from './types.js';

export interface AttemptRecord {
  /** 1-based, matching the `attempts` count on the result. */
  attempt: number;
  /**
   * Whether this attempt passed. Normally false — an attempt is only
   * superseded because it failed. True is reachable under
   * `--run-all-attempts`, where every attempt runs and the last one is
   * reported regardless, so an earlier pass can be superseded by a later fail.
   */
  passed: boolean;
  checks: CheckResult[];
  stoppedReason: string;
  agentReport: string;
  transcript: TranscriptPart[];
  skills: SkillResult;
  docs: DocsResult;
}

/**
 * Build the record for a superseded attempt.
 *
 * `toolCalls` is deliberately omitted, and a human reading a superseded attempt
 * loses nothing by it: `TranscriptPart` already carries `tool_call` entries with
 * their name, input, output and error. What `ToolCallRecord` adds on top is the
 * normalized projection — canonical name, `path`, `command`, `url`,
 * `loadedSkills` — which is what *scorers* consume. So the accurate statement is
 * that a superseded attempt can be read but not re-scored, and the two derived
 * answers anyone actually asks (did it open the skill, what docs did it read)
 * are already preserved in `skills` and `docs`.
 *
 * It is also the larger half of the artifact. Across the 114 benchmark runs on
 * disk, transcript and toolCalls together are 99% of all bytes, and each is
 * around 70 KB at the median, 790 KB at p90 and 5.7 MB at the worst — so the
 * saving is proportional rather than the flat ~76 KB an earlier version of this
 * comment quoted from a single file. Regression scenarios, which are what this
 * mostly serves, sit well below those figures.
 *
 * Nothing today re-scores a stored attempt. `score-only.ts` does not read run
 * artifacts at all — it leases a fresh session, applies `SOLUTION.ts` and calls
 * the scorer with empty `toolCalls` and `transcript` to measure scorer
 * self-agreement. `replay-judge.ts` does read them, and needs only `transcript`
 * and `checks[].judgeNotes`, both of which a record carries; it simply does not
 * descend into `priorAttempts` yet.
 */
export function buildAttemptRecord(input: {
  attempt: number;
  result: ScoreResult;
  stoppedReason: string;
  agentReport: string;
  transcript: TranscriptPart[];
  skills: SkillResult;
  docs: DocsResult;
}): AttemptRecord {
  return {
    attempt: input.attempt,
    passed: input.result.passed,
    checks: input.result.checks ?? [],
    stoppedReason: input.stoppedReason,
    agentReport: input.agentReport,
    transcript: input.transcript,
    skills: input.skills,
    docs: input.docs,
  };
}

/**
 * Whether an attempt that has just been scored should be kept in
 * `priorAttempts`.
 *
 * Extracted from the loop so the rule can be tested without an agent. Two
 * attempts are never recorded here: the one stop-on-pass returns, and the last
 * one, because both are reported by the result itself and recording them would
 * duplicate the largest field in the artifact. The invariant that falls out is
 * `priorAttempts.length === attempts - 1`.
 */
export function shouldRecordSupersededAttempt(input: {
  attempt: number;
  runs: number;
  passed: boolean;
  stopOnPass: boolean;
}): boolean {
  // Stop-on-pass reports this attempt, so it is not superseded by anything.
  if (input.stopOnPass && input.passed) return false;
  // The final attempt is the one the result reports.
  return input.attempt < input.runs;
}
