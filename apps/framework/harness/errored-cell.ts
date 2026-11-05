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
 *
 * Location is the first defence, not the only one. A downloaded artifact has
 * the same `<eval>.json` layout as a result, so an evidence file copied into
 * `.eval-runs/<experiment>/` by hand would otherwise parse: the raw row schema
 * needs only `experiment` and `eval`, and the exporter reads a missing `passed`
 * as a failure — the 13 August row again. `lib/raw-result.ts` makes the
 * exporter refuse it by content.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { AttemptRecord } from './attempts.js';
import { describeError } from './describe-error.js';
import { type SecretValue, secretValues, serializeRedacted } from './redact.js';
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
 * `current` is the attempt whose agent has run and which is not yet in
 * `priorAttempts`. It is cleared only by moving it there, so the attempt the
 * result reports — the final one, or a stop-on-pass — stays `current` until
 * the cell is done, including through the session and sandbox teardown that
 * runs after the loop body. A teardown that throws then still has it.
 *
 * Mutate it only through the functions below, which `runOne` calls and the
 * tests exercise directly.
 */
export interface AttemptLoopState {
  priorAttempts: AttemptRecord[];
  current?: ErroredAttemptRecord;
  /**
   * Credentials the sandboxes created that the harness did not inject, read
   * out of each attempt's container before it was torn down. Every artifact
   * this cell writes is redacted with them, the result and the errored-cell
   * evidence alike. See `sandbox-credentials.ts`.
   */
  discoveredSecrets?: SecretValue[];
}

export function newAttemptLoopState(): AttemptLoopState {
  return { priorAttempts: [], discoveredSecrets: [] };
}

/**
 * Add credentials found in an attempt's sandbox. Called before the attempt's
 * guards and scorer, so a cell that throws afterwards is still redacted with
 * them.
 *
 * Each distinct value gets its own numbered name, in the order the cell found
 * them, so two keys minted by two attempts (or two `hookdeck ci` runs) stay
 * distinguishable in the transcript: `<redacted:hookdeck-cli-config:api_key-1>`
 * and `…-2`. A value already found keeps the name it was given.
 */
export function credentialsDiscovered(
  loop: AttemptLoopState,
  secrets: SecretValue[]
): void {
  const known = loop.discoveredSecrets ?? [];
  const seen = new Set(known.map((s) => s.value));
  const added: SecretValue[] = [];
  for (const { name, value } of secrets) {
    if (seen.has(value)) continue;
    seen.add(value);
    added.push({ name: `${name}-${known.length + added.length + 1}`, value });
  }
  loop.discoveredSecrets = [...known, ...added];
}

/** The secrets an artifact from this cell is redacted with. */
export function cellSecrets(
  loop: AttemptLoopState,
  base: SecretValue[] = secretValues()
): SecretValue[] {
  return [...base, ...(loop.discoveredSecrets ?? [])];
}

/**
 * The agent for this attempt has run. Anything that throws from here on
 * belongs to it.
 *
 * Replaces `current` without checking it, which is safe because every
 * attempt before the last either returns (stop-on-pass) or is superseded and
 * moved by `settleAttempt`, so nothing unrecorded is ever overwritten.
 */
export function attemptRan(
  loop: AttemptLoopState,
  attempt: ErroredAttemptRecord
): void {
  loop.current = attempt;
}

/**
 * The attempt has been scored. Pass the record when it is superseded and
 * should be kept; pass `undefined` when it is the attempt the result reports,
 * which leaves it `current` for as long as the cell can still throw.
 */
export function settleAttempt(
  loop: AttemptLoopState,
  superseded: AttemptRecord | undefined
): void {
  if (!superseded) return;
  loop.priorAttempts.push(superseded);
  loop.current = undefined;
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
 * Deliberately no top-level `passed`, `checks` or `transcript`, and an
 * explicit `errored: true`. Absence alone is not enough: the raw row schema is
 * loose and accepts a file with only `experiment` and `eval`, so it is the
 * exporter's check in `lib/raw-result.ts` that refuses this, by `errored` and
 * by the missing `passed`. `replay-judge.ts` skips it because it has no
 * top-level `transcript`.
 */
export function buildErroredEvidence(input: ErroredCellInput): ErroredEvidence {
  const err = input.error;
  return {
    experiment: input.experiment,
    eval: input.evalId,
    errored: true,
    // The whole cause chain, not the top message: "fetch failed" alone does
    // not say what was unreachable. Redacted on the way to disk with the rest.
    error: describeError(err),
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
  writeFileSync(
    out,
    serializeRedacted(
      buildErroredEvidence(input),
      cellSecrets(input.state, secrets)
    )
  );
  return out;
}

/**
 * Every errored cell's evidence under `dir`, at any depth.
 *
 * Any depth because evidence arrives in three layouts: the harness writes
 * `<experiment>/<eval>.json`; `gh run download --name errored-attempts-X__Y
 * --dir <dir>` writes `<eval>.json` flat, since the artifact is rooted at the
 * experiment directory; and downloading several writes
 * `errored-attempts-X__Y/<eval>.json`. Each cell names its own experiment and
 * eval, so the path is only for telling the reader where to look.
 *
 * Files that do not parse, or are not evidence, are reported rather than
 * thrown, so one corrupt download does not hide every other errored cell.
 */
export function readErroredEvidenceTree(dir: string): {
  found: Array<{ path: string; evidence: ErroredEvidence }>;
  unreadable: Array<{ path: string; reason: string }>;
} {
  const found: Array<{ path: string; evidence: ErroredEvidence }> = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  if (!existsSync(dir)) return { found, unreadable };

  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      const path = relative(dir, full).split(sep).join('/');
      try {
        const parsed = JSON.parse(
          readFileSync(full, 'utf8')
        ) as Partial<ErroredEvidence> | null;
        if (parsed?.errored !== true) {
          unreadable.push({ path, reason: 'not errored-cell evidence' });
          continue;
        }
        found.push({ path, evidence: parsed as ErroredEvidence });
      } catch (error) {
        unreadable.push({
          path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  walk(dir);
  return { found, unreadable };
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
