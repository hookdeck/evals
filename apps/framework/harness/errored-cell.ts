/**
 * What we keep from a cell that errored instead of producing a result.
 *
 * `attempts.ts` keeps every superseded attempt in `priorAttempts`, but only on
 * the paths where `runOne` returns. Two guards inside the attempt loop throw
 * instead — an agent that errored before emitting any transcript event, and a
 * process that did not exit cleanly — and a throw used to take `priorAttempts`
 * with it. Attempt 1 fails for a real reason, attempt 2's container is killed,
 * and the attempt 1 transcript, exactly what #94 exists to keep, was gone. See
 * #97.
 *
 * The throws are right and stay. An errored cell must not produce a file at the
 * result path: the exporter reads that path, and a wrong row published against
 * a named vendor is worse than a missing one (13 August). So the evidence goes
 * somewhere the exporter cannot reach:
 *
 * - **Not beside the result file.** The exporter globs `<experiment>/*.json`,
 *   so a sidecar there becomes a row with a mangled eval id.
 * - **Not under `.eval-runs/` at all.** The exporter also reads
 *   `<experiment>/<eval>/summary.json`, and `replay-judge.ts` walks the whole
 *   tree. Anything below `.eval-runs/` is one reader change away from being
 *   published.
 * - **Its own top-level directory, uploaded as its own artifact.** Adding this
 *   directory to the `raw-results-*` upload would move that artifact's root:
 *   `upload-artifact` roots a multi-path artifact at the least common ancestor
 *   of its paths, which here is the repository root. Every `raw-results-*`
 *   artifact would then nest its files under `.eval-runs/<experiment>/`, and
 *   the publish job — which copies an artifact's contents straight into
 *   `.eval-runs/<experiment>/` — would publish nothing. So the workflow uploads
 *   this directory as `errored-attempts-<experiment>__<eval>`, which the publish
 *   job never downloads.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AttemptRecord } from './attempts.js';
import { serializeRedacted, type SecretValue } from './redact.js';
import type { DocsResult, SkillResult, TranscriptPart } from './types.js';

/**
 * Top-level, dot-prefixed and gitignored, like `.eval-runs/`. Deliberately a
 * sibling of it rather than a child: see the file comment.
 */
export const ERRORED_RUNS_DIRNAME = '.eval-errored';

export function erroredEvidencePath(
  root: string,
  experiment: string,
  evalId: string
): string {
  return join(root, ERRORED_RUNS_DIRNAME, experiment, `${evalId}.json`);
}

/**
 * The attempt that was running when the cell errored.
 *
 * Kept because it is evidence too: the 21 August `error_exit_255` left fifteen
 * tool calls of transcript, and why a container died is read from what it was
 * doing. It carries no `passed` or `checks` on purpose. Usually it was never
 * scored, because a guard threw first; in the rare case it was (a scorer or a
 * teardown that threw afterwards), the score was never reported. Either way it
 * is not a result and must not be read as one.
 */
export interface ErroredAttemptRecord {
  attempt: number;
  stoppedReason: string;
  agentReport: string;
  transcript: TranscriptPart[];
  skills: SkillResult;
  docs: DocsResult;
}

/**
 * What the attempt loop has gathered so far, owned by the caller.
 *
 * `runOne` writes into this as it goes rather than holding it in locals, so a
 * throw from anywhere inside the loop leaves it readable in the caller's
 * `catch`. That covers more than the two guards: a session that fails to start
 * on attempt 2, or a scorer that throws, would otherwise lose attempt 1 in
 * exactly the same way.
 *
 * `current` is set once an agent run has returned and cleared once that
 * attempt has been recorded or reported, so it is present exactly when the
 * error belongs to an attempt whose agent ran — a guard, the scorer, a
 * rehydrate — and absent when the error came from setting up the next one.
 */
export interface AttemptLoopState {
  priorAttempts: AttemptRecord[];
  current?: ErroredAttemptRecord;
}

export function newAttemptLoopState(): AttemptLoopState {
  return { priorAttempts: [] };
}

export interface ErroredEvidence {
  experiment: string;
  eval: string;
  /**
   * Always true. Present so a file that is copied somewhere it does not belong
   * says what it is on its first line rather than looking like a result.
   */
  errored: true;
  /** Why the cell errored: the message the harness logged. */
  error: string;
  ranAt: string;
  runId?: string;
  /** Attempts that ran to a score before the error, oldest first. */
  priorAttempts: AttemptRecord[];
  erroredAttempt?: ErroredAttemptRecord;
}

interface ErroredCellInput {
  experiment: string;
  evalId: string;
  error: unknown;
  state: AttemptLoopState;
  ranAt?: string;
  runId?: string;
}

/**
 * Deliberately no top-level `passed`, `checks` or `transcript`. A file with
 * none of them cannot be mistaken for a result by anything that reads result
 * files, including `replay-judge.ts`, which skips any JSON without a top-level
 * `transcript`.
 */
export function buildErroredEvidence(input: ErroredCellInput): ErroredEvidence {
  const err = input.error;
  return {
    experiment: input.experiment,
    eval: input.evalId,
    errored: true,
    error: err instanceof Error ? err.message : String(err),
    ranAt: input.ranAt ?? new Date().toISOString(),
    runId: input.runId,
    priorAttempts: [...input.state.priorAttempts],
    erroredAttempt: input.state.current,
  };
}

/**
 * Write what an errored cell left behind, redacted, and return where.
 *
 * Writes nothing when no agent ran — an error importing the scorer, or
 * starting the first session — because then there is nothing to keep. Never
 * touches the result path: the caller owns that, and an errored cell must
 * leave it absent.
 */
export function writeErroredEvidence(
  root: string,
  input: ErroredCellInput,
  secrets?: SecretValue[]
): string | undefined {
  if (input.state.priorAttempts.length === 0 && !input.state.current) {
    return undefined;
  }
  const out = erroredEvidencePath(root, input.experiment, input.evalId);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeRedacted(buildErroredEvidence(input), secrets));
  return out;
}

/**
 * One line saying what an errored cell left, for `triage`.
 *
 * Leads with the absence of a row, because that is what the scoreboard will
 * show and what a reader will otherwise mistake for a cell that never ran.
 */
export function describeErroredEvidence(
  evidence: Pick<ErroredEvidence, 'error' | 'priorAttempts' | 'erroredAttempt'>
): string {
  const prior = evidence.priorAttempts ?? [];
  const kept =
    prior.length === 0
      ? 'no earlier attempts'
      : `${prior.length} earlier attempt(s) kept (` +
        prior
          .map(
            (a) =>
              `#${a.attempt} ${a.passed ? 'passed' : 'failed'}, ${a.stoppedReason}`
          )
          .join('; ') +
        ')';
  const current = evidence.erroredAttempt
    ? `, attempt ${evidence.erroredAttempt.attempt} errored with ` +
      `${evidence.erroredAttempt.transcript.length} transcript event(s)`
    : '';
  const reason = (evidence.error ?? '').split('\n')[0];
  return `no result written; ${kept}${current}. ${reason}`;
}

/**
 * Remove a previous run's evidence for this cell.
 *
 * Called before a cell runs, so a cell that errored locally and then succeeded
 * does not leave evidence of an error that no longer describes it.
 */
export function clearErroredEvidence(
  root: string,
  experiment: string,
  evalId: string
): void {
  rmSync(erroredEvidencePath(root, experiment, evalId), { force: true });
}
