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
 * `toolCalls` is deliberately omitted. It is a parsed projection of the same
 * events the transcript already holds, and the two are the largest fields in
 * the artifact by an order of magnitude — around 76 KB each on a typical
 * investigate scenario, so carrying both would roughly double a three-attempt
 * cell for no new information. The scorer's reading of those calls survives in
 * `checks`, and the derived `skills`/`docs` summaries answer the question a
 * reader usually has (did it open the skill?) in a few hundred bytes.
 *
 * The consequence to know about: a superseded attempt cannot be re-scored by
 * `score-only`, which consumes `toolCalls`. If that becomes something we want,
 * it is an argument for keeping them, not for keeping them speculatively.
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
