/**
 * Whether the instrument has moved since the last published rows, and the
 * two-cell canary that has to pass before a matrix runs under a moved one.
 *
 * #114 is the case: a Dockerfile change meant to put the pinned CLI on PATH for
 * Codex's login shells shipped straight into a matrix, and the matrix is where
 * it was found not to have worked. Two cells, one per agent CLI, with publishing
 * held, would have found it for the price of two cells.
 */

/**
 * What an agent's cells were measured under. Per agent, because a published
 * snapshot is a merge of runs: the newest run may have had no cells for one of
 * the agents, and comparing that agent against it would clear a change no cell
 * of that agent ever ran under. That is #114 again, for the price of a partial
 * publish.
 */
export interface AgentInstrument {
  /** `sandboxImageDefinition()`: a hash of the Dockerfile's bytes. */
  imageDefinition?: string;
  hookdeckCli?: string;
  /** Vercel's `skills` CLI, a build arg of the same image. */
  skillsCli?: string;
  agentCli?: string;
  /** Where the published values were read from, for the report. */
  source?: string;
}

export interface Instrument {
  /** Agent id to what its cells ran under, for agents an experiment uses. */
  byAgent: Record<string, AgentInstrument>;
  /** Experiment name to model id. */
  models: Record<string, string | undefined>;
}

export interface InstrumentChange {
  what: string;
  published: string;
  current: string;
  /** The agent whose cells would run under the change, when it is per agent. */
  agent?: string;
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
  const compare = (
    what: string,
    p: string | undefined,
    c: string | undefined,
    agent?: string
  ) => {
    if (c === undefined) return;
    if (p === c) return;
    changes.push({
      what,
      published: p ?? UNKNOWN,
      current: c,
      ...(agent ? { agent } : {}),
    });
  };
  for (const [agent, now] of Object.entries(current.byAgent).sort()) {
    const then = published.byAgent[agent] ?? {};
    const cells = `${agent} cells, ${then.source ?? 'no published run'}`;
    compare(
      `sandbox image definition (${cells})`,
      then.imageDefinition,
      now.imageDefinition,
      agent
    );
    compare(
      `Hookdeck CLI pin (${cells})`,
      then.hookdeckCli,
      now.hookdeckCli,
      agent
    );
    compare(`skills CLI pin (${cells})`, then.skillsCli, now.skillsCli, agent);
    compare(`${agent} CLI pin (${cells})`, then.agentCli, now.agentCli, agent);
  }
  for (const [experiment, model] of Object.entries(current.models).sort()) {
    // An experiment with no published rows is new, and a new experiment is a
    // model nobody has run here, so it is a change too.
    compare(`${experiment} model`, published.models[experiment], model);
  }
  return changes;
}

export interface PublishedRowLike {
  experiment?: string;
  runId?: string;
  ranAt?: string;
  experimentDisplay?: { agent?: string; modelId?: string };
}

/**
 * For each agent, the newest published run that has rows for an experiment
 * using it, by the latest `ranAt` of that agent's rows. Not the newest run
 * overall: a Claude-only partial publish says nothing about the image Codex
 * cells last ran on.
 */
export function newestRunPerAgent(
  rows: PublishedRowLike[],
  agentOf: (experiment: string) => string | undefined
): Record<string, string> {
  const best = new Map<string, { runId: string; ranAt: string }>();
  for (const row of rows) {
    if (!row.experiment || !row.runId) continue;
    const agent = agentOf(row.experiment) ?? row.experimentDisplay?.agent;
    if (!agent) continue;
    const ranAt = row.ranAt ?? '';
    const held = best.get(agent);
    if (!held || ranAt > held.ranAt)
      best.set(agent, { runId: row.runId, ranAt });
  }
  return Object.fromEntries([...best].map(([agent, v]) => [agent, v.runId]));
}

/** Each experiment's model, from its newest published row. */
export function modelsFromRows(
  rows: PublishedRowLike[]
): Record<string, string> {
  const best = new Map<string, { model: string; ranAt: string }>();
  for (const row of rows) {
    const model = row.experimentDisplay?.modelId;
    if (!row.experiment || !model) continue;
    const ranAt = row.ranAt ?? '';
    const held = best.get(row.experiment);
    if (!held || ranAt > held.ranAt) {
      best.set(row.experiment, { model, ranAt });
    }
  }
  return Object.fromEntries([...best].map(([e, v]) => [e, v.model]));
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
