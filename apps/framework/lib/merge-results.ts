import {
  evalResultSchema,
  type EvalResult,
} from '@hookdeck-evals/core/eval-metadata';

/**
 * The parts of `export-results --merge` that decide what gets published, kept
 * apart from the script so they can be tested without a filesystem.
 *
 * Three questions, each of which a merged snapshot used to answer silently:
 * which carried rows were measured under something else (`splitStale`), which
 * carried rows still have the shape the exporter whitelists
 * (`sanitizeCarried`), and which cells this run was meant to measure and did
 * not (`assessCoverage`).
 */

export interface Provenanced {
  experiment: string;
  eval: string;
  ranAt?: string;
  runId?: string;
  provenance?: { harness?: string; scenario?: string };
}

export function pairKey(row: { experiment: string; eval: string }): string {
  return `${row.experiment}::${row.eval}`;
}

/**
 * Which carried-forward rows were measured under something else.
 *
 * "Something else" is decided against the rows this run just produced rather
 * than against the working tree, so the comparison is between two measurements
 * rather than between a measurement and whatever happens to be checked out. A
 * scenario is compared only against a fresh row for that same scenario: the
 * harness moved under everything at once, but `outpost-002` being rewritten says
 * nothing about `filtering-001`.
 *
 * A row with no `provenance` at all predates this field. Those are reported
 * separately and never counted as current — not knowing what a row was measured
 * under is the condition this exists to surface, and treating it as fine would
 * mean every row published before today silently passes.
 */
export function splitStale<T extends Provenanced>(carried: T[], fresh: T[]) {
  const harness = fresh.find((r) => r.provenance?.harness)?.provenance?.harness;
  const scenarios = new Map<string, string>();
  for (const row of fresh) {
    if (row.provenance?.scenario)
      scenarios.set(row.eval, row.provenance.scenario);
  }

  const current: T[] = [];
  const stale: Array<{ row: T; why: string }> = [];
  for (const row of carried) {
    if (!row.provenance) {
      stale.push({ row, why: 'no provenance recorded' });
      continue;
    }
    if (harness && row.provenance.harness !== harness) {
      stale.push({ row, why: 'harness changed' });
      continue;
    }
    const expected = scenarios.get(row.eval);
    if (expected && row.provenance.scenario !== expected) {
      stale.push({ row, why: 'scenario changed' });
      continue;
    }
    current.push(row);
  }
  return { current, stale };
}

/**
 * Put carried rows back through the published row's whitelist.
 *
 * Fresh rows are built field by field in `readResultFile`, so anything a raw
 * result file carries that is not meant to be published — the transcript, tool
 * calls, cost, `priorAttempts` — never reaches the output. Carried rows were
 * read with `JSON.parse` and spread into the output verbatim, so the whitelist
 * held for them only because `export-results` happened to be the only writer
 * of that file (#96). Parsing them with the same schema the site uses makes it
 * hold by construction.
 *
 * A row that no longer parses is returned as rejected rather than published,
 * which is the same rule fresh rows follow: a value that has drifted from a
 * closed enum is dropped rather than rendered stale. The caller reports it.
 */
export function sanitizeCarried(rows: unknown[]): {
  rows: EvalResult[];
  rejected: Array<{ key: string; reason: string }>;
} {
  const kept: EvalResult[] = [];
  const rejected: Array<{ key: string; reason: string }> = [];
  for (const raw of rows) {
    const parsed = evalResultSchema.safeParse(raw);
    if (parsed.success) {
      kept.push(parsed.data);
      continue;
    }
    const r = (raw ?? {}) as Partial<Provenanced>;
    rejected.push({
      key: `${r.eval ?? '?'} x ${r.experiment ?? '?'}`,
      reason: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(row)'}: ${i.message}`)
        .join('; '),
    });
  }
  return { rows: kept, rejected };
}

export interface ExpectedPair {
  experiment: string;
  eval: string;
}

/**
 * The pairs the workflow's `prepare` job emitted, narrowed to what this export
 * is for. `prepare` writes `{ eval_id, experiment, experiment_suite,
 * eval_suite }`; anything else in the file is ignored.
 */
export function readExpectedPairs(
  raw: unknown,
  include: (pair: {
    experiment: string;
    eval: string;
    evalSuite?: string;
    experimentSuite?: string;
  }) => boolean
): ExpectedPair[] {
  if (!Array.isArray(raw)) {
    throw new Error('expected pairs must be a JSON array');
  }
  const seen = new Map<string, ExpectedPair>();
  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    const experiment = typeof e.experiment === 'string' ? e.experiment : '';
    const evalId = typeof e.eval_id === 'string' ? e.eval_id : '';
    if (!experiment || !evalId) {
      throw new Error(
        `expected pair without an experiment or eval_id: ${JSON.stringify(entry)}`
      );
    }
    const pair = {
      experiment,
      eval: evalId,
      evalSuite: typeof e.eval_suite === 'string' ? e.eval_suite : undefined,
      experimentSuite:
        typeof e.experiment_suite === 'string' ? e.experiment_suite : undefined,
    };
    if (!include(pair)) continue;
    seen.set(pairKey(pair), { experiment, eval: evalId });
  }
  return [...seen.values()];
}

export interface Coverage<T> {
  /** Cells the run was asked to measure. */
  expected: number;
  /** Of those, how many produced a result this run. */
  measured: number;
  /**
   * Cells with no fresh result. `carried` is the row being published in its
   * place, from an earlier run; absent means the cell is not in the output.
   */
  missing: Array<{ experiment: string; eval: string; carried?: T }>;
  /** The most missing cells the floor tolerates. */
  allowedMissing: number;
  /** True when more cells are missing than the floor allows. */
  refuse: boolean;
}

/**
 * Which cells this run was meant to measure and did not, and whether that is
 * too many to publish.
 *
 * A cell with no result is one of three things: a scenario whose `requires:`
 * the environment did not meet (skipped on purpose), a cell whose scorer or
 * container errored (no verdict, deliberately), or a matrix job that never ran.
 * None of them is a score, so none of them may be published as one — but one
 * of them should not stop the other hundred from being published either, which
 * is what happened on 21 September (#80).
 *
 * So the floor is a fraction of the run, not zero. Below it, the export
 * publishes and says exactly which cells are missing and what stands in for
 * each. Above it, something systematic happened — a whole experiment, a dead
 * provider that was not caught — and publishing would put more old or absent
 * cells on the page than new ones nobody had read.
 */
export function assessCoverage<T extends { experiment: string; eval: string }>(
  expected: ExpectedPair[],
  fresh: T[],
  published: T[],
  maxMissingFraction: number
): Coverage<T> {
  const freshKeys = new Set(fresh.map(pairKey));
  const publishedByKey = new Map(published.map((r) => [pairKey(r), r]));

  const missing: Coverage<T>['missing'] = [];
  for (const pair of expected) {
    const key = pairKey(pair);
    if (freshKeys.has(key)) continue;
    const carried = publishedByKey.get(key);
    missing.push(
      carried
        ? { experiment: pair.experiment, eval: pair.eval, carried }
        : { experiment: pair.experiment, eval: pair.eval }
    );
  }

  const allowedMissing = Math.floor(expected.length * maxMissingFraction);
  return {
    expected: expected.length,
    measured: expected.length - missing.length,
    missing: missing.sort(
      (a, b) =>
        a.eval.localeCompare(b.eval) || a.experiment.localeCompare(b.experiment)
    ),
    allowedMissing,
    refuse: missing.length > allowedMissing,
  };
}
