/**
 * Whether the instrument has moved since the last published rows, and the
 * two-cell canary that has to pass before a matrix runs under a moved one.
 *
 * #114 is the case: a Dockerfile change meant to put the pinned CLI on PATH for
 * Codex's login shells shipped straight into a matrix, and the matrix is where
 * it was found not to have worked. Two cells, one per agent CLI, with publishing
 * held, would have found it for the price of two cells.
 */

export interface Instrument {
  /** `sandboxImageDefinition()`: a hash of the Dockerfile's bytes. */
  imageDefinition?: string;
  hookdeckCli?: string;
  /** Agent id to pinned CLI version, for agents an experiment uses. */
  agentClis: Record<string, string | undefined>;
  /** Experiment name to model id. */
  models: Record<string, string | undefined>;
}

export interface InstrumentChange {
  what: string;
  published: string;
  current: string;
}

const UNKNOWN = 'unknown';

/**
 * Every part of the instrument that differs from what the published rows were
 * measured under. An unknown published value counts as a change: a canary is
 * cheap and a matrix under an instrument nobody could compare is not.
 */
export function diffInstrument(
  published: Instrument,
  current: Instrument
): InstrumentChange[] {
  const changes: InstrumentChange[] = [];
  const compare = (what: string, p?: string, c?: string) => {
    if (c === undefined) return;
    if (p === c) return;
    changes.push({ what, published: p ?? UNKNOWN, current: c });
  };
  compare(
    'sandbox image definition',
    published.imageDefinition,
    current.imageDefinition
  );
  compare('Hookdeck CLI pin', published.hookdeckCli, current.hookdeckCli);
  for (const [agent, version] of Object.entries(current.agentClis).sort()) {
    compare(`${agent} CLI pin`, published.agentClis[agent], version);
  }
  for (const [experiment, model] of Object.entries(current.models).sort()) {
    // An experiment with no published rows is new, and a new experiment is a
    // model nobody has run here, so it is a change too.
    compare(`${experiment} model`, published.models[experiment], model);
  }
  return changes;
}

/**
 * A pinned string in a source file at some commit: `NAME = '1.2.3'` or
 * `name: '1.2.3'`. For reading pins at the commit that produced a published
 * run, where importing the module is not an option.
 */
export function readPin(source: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*[:=]\\s*['"]([^'"]+)['"]`);
  return re.exec(source)?.[1];
}

export interface CanaryPlan {
  experiments: string[];
  evalId: string;
  commands: string[];
}

/**
 * The exact commands for a two-cell canary with publishing held.
 *
 * `EVALS_PUBLISH=false` is a repository variable, so it is set before the
 * dispatch and deleted after; check 11 fails a later matrix if it is left set.
 */
export function canaryPlan(
  experiments: string[],
  evalId: string,
  evalSuite: string,
  experimentSuites: string[]
): CanaryPlan {
  return {
    experiments,
    evalId,
    commands: [
      'gh variable set EVALS_PUBLISH --body false',
      'gh workflow run eval-refresh.yml' +
        ` -f suite=${evalSuite}` +
        ` -f experiment_suite=${[...new Set(experimentSuites)].join(',')}` +
        ` -f experiments=${experiments.join(',')}` +
        ` -f eval=${evalId}` +
        ' -f runs=1',
      '# when it finishes:',
      'pnpm preflight --canary-run <run-id>',
      'gh variable delete EVALS_PUBLISH',
    ],
  };
}

export const CANARY_CRITERIA = [
  'the run concluded success, with one cell per agent',
  'no cell failed the sandbox self-check',
  'no cell shows PINNED CLI NOT ON PATH',
  'every cell passed the credential check on its artifacts',
  'the publish job did not run',
];
