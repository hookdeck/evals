import type { PlannedCell } from './spend.js';

/**
 * The cells a dispatch would run, worked out the way `eval-refresh.yml`'s
 * "Discover eval pairs" step works them out.
 *
 * Mirrored rather than shared, because that step is shell; the tests pin the
 * rules it follows. The two that matter for cost: a benchmark scenario runs
 * under both the `benchmark` and `no-skills` experiment suites, and naming
 * scenarios with `eval` overrides the suite filter entirely.
 */

export interface DispatchInputs {
  suites: string[];
  experimentSuites: string[];
  /** Blank means every experiment in the requested experiment suites. */
  experiments: string[];
  /** Blank means every scenario in the requested suites. */
  evalIds: string[];
  runs: number;
}

/** The workflow_dispatch defaults, which are the regression suite. */
export const DISPATCH_DEFAULTS: DispatchInputs = {
  suites: ['regression'],
  experimentSuites: ['regression'],
  experiments: [],
  evalIds: [],
  runs: 2,
};

export interface PlannableEval {
  id: string;
  suite: string;
  metadata: { minAttempts?: number; requires?: string[] } & Record<
    string,
    unknown
  >;
}

export interface PlannableExperiment {
  name: string;
  suites: string[];
  skipEval?: (ev: { id: string; metadata: never }) => boolean;
}

/** `min_attempts` is a floor on `--runs`, capped at five. */
export function attemptsFor(runs: number, minAttempts?: number): number {
  return Math.min(5, Math.max(runs, minAttempts ?? 0));
}

export function experimentSuitesForEval(evalSuite: string): string[] {
  switch (evalSuite) {
    case 'benchmark':
      return ['benchmark', 'no-skills'];
    case 'regression':
      return ['regression'];
    default:
      return [];
  }
}

export interface PlannedPair extends PlannedCell {
  experimentSuite: string;
}

export function planCells(
  evals: PlannableEval[],
  experiments: PlannableExperiment[],
  inputs: DispatchInputs
): PlannedPair[] {
  const chosen =
    inputs.evalIds.length > 0
      ? evals.filter((e) => inputs.evalIds.includes(e.id))
      : evals.filter((e) => inputs.suites.includes(e.suite));

  const cells: PlannedPair[] = [];
  for (const ev of chosen) {
    for (const experimentSuite of experimentSuitesForEval(ev.suite)) {
      if (!inputs.experimentSuites.includes(experimentSuite)) continue;
      for (const experiment of experiments) {
        if (!experiment.suites.includes(experimentSuite)) continue;
        if (
          inputs.experiments.length > 0 &&
          !inputs.experiments.includes(experiment.name)
        ) {
          continue;
        }
        if (
          experiment.skipEval?.({
            id: ev.id,
            metadata: ev.metadata as never,
          })
        ) {
          continue;
        }
        cells.push({
          experiment: experiment.name,
          eval: ev.id,
          experimentSuite,
          runs: attemptsFor(inputs.runs, ev.metadata.minAttempts),
        });
      }
    }
  }
  return cells;
}
