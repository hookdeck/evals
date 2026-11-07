import {
  DEFAULT_ISSUE_TRIGGERS,
  issueTriggerMatchesDeclared,
  type HookdeckResource,
  type PristineSnapshot,
} from '@hookdeck-evals/hookdeck';

/**
 * The judgements behind several checks, separated from the calls that gather
 * their inputs so they can be tested without a network.
 */

// Secrets ---------------------------------------------------------------------

export interface MissingSecrets {
  /** Missing and needed: fails the check. */
  fatal: string[];
  /** Missing, and only the key of an agent no experiment uses. */
  unneeded: string[];
}

/**
 * Which missing secrets matter. A missing key for an agent no experiment uses
 * is not a gap in a run: the workflow writes it into `.env` empty and nothing
 * reads it. Anything else the workflow reads and the repository lacks is.
 */
export function classifyMissingSecrets(
  wanted: string[],
  have: Set<string>,
  agents: Array<{ id: string; apiKeyEnvVar: string }>,
  usedAgents: Set<string>
): MissingSecrets {
  const missing = wanted.filter((s) => !have.has(s));
  const unneeded = missing.filter((name) => {
    const owners = agents.filter((a) => a.apiKeyEnvVar === name);
    return owners.length > 0 && owners.every((a) => !usedAgents.has(a.id));
  });
  return {
    fatal: missing.filter((m) => !unneeded.includes(m)),
    unneeded,
  };
}

// Main is green, from a pull request's Checks run -----------------------------

export interface ChecksRunEvidence {
  mainSha: string;
  prNumber: number;
  runId: number;
  runCreatedAt: string;
  conclusion: string;
  steps: Array<{ name: string; conclusion: string }>;
  /**
   * The committer time of main's first parent: the base the pull request was
   * merged onto. Undefined when it could not be read.
   */
  baseCommittedAt?: string;
}

const REQUIRED_STEPS = [/format/i, /typecheck/i, /test/i, /build/i];

/**
 * Whether a pull request's Checks run covers the main it produced.
 *
 * The run tested the pull request merged into its base *as of when the run
 * started*. If the base moved after that, main is a merge nobody tested: two
 * pull requests can each pass and still break each other. So a base commit
 * newer than the run fails the check rather than passing on a stale tree; the
 * remedy is to check out main and run the four commands, which this script
 * does itself when it is run from a clean checkout of main.
 */
export function evaluateChecksRun(e: ChecksRunEvidence): {
  status: 'pass' | 'fail';
  summary: string;
  details: string[];
} {
  const missing = REQUIRED_STEPS.filter(
    (re) => !e.steps.some((s) => re.test(s.name) && s.conclusion === 'success')
  );
  const details = [
    `read from the Checks run on #${e.prNumber} (run ${e.runId}, started ${e.runCreatedAt})`,
    ...e.steps
      .filter((s) => REQUIRED_STEPS.some((re) => re.test(s.name)))
      .map((s) => `${s.name}: ${s.conclusion}`),
  ];
  if (e.conclusion !== 'success' || missing.length > 0) {
    return {
      status: 'fail',
      summary: `#${e.prNumber}'s Checks did not pass every step (${e.conclusion || 'unfinished'})`,
      details,
    };
  }
  if (!e.baseCommittedAt) {
    return {
      status: 'fail',
      summary: `could not read the base main ${e.mainSha.slice(0, 7)} was merged onto, so cannot tell whether #${e.prNumber}'s Checks tested it`,
      details: [
        ...details,
        'check out main and re-run to run the checks locally',
      ],
    };
  }
  if (Date.parse(e.baseCommittedAt) > Date.parse(e.runCreatedAt)) {
    return {
      status: 'fail',
      summary: `main's base moved after #${e.prNumber}'s Checks started, so main ${e.mainSha.slice(0, 7)} is a merge nobody tested`,
      details: [
        ...details,
        `base committed ${e.baseCommittedAt}, after the run started`,
        'check out main and re-run to run the checks locally',
      ],
    };
  }
  return {
    status: 'pass',
    summary: `#${e.prNumber}'s Checks passed format, typecheck, tests and build on the base main was merged onto`,
    details: [
      ...details,
      `base committed ${e.baseCommittedAt}, before the run started`,
    ],
  };
}

// Projects are pristine --------------------------------------------------------

function describe(r: HookdeckResource): string {
  return `${r.id}${r.name ? ` (${r.name})` : ''}`;
}

/**
 * `evals-ci` at rest: the declared default issue triggers, exactly as the reset
 * leaves them, and nothing else. A new project ships with no sources,
 * connections, destinations or transformations.
 */
export function evaluateGatewayProject(
  resources: Record<string, HookdeckResource[]>
): string[] {
  const fails: string[] = [];
  for (const [kind, rows] of Object.entries(resources).sort()) {
    if (kind === 'issue-triggers' || rows.length === 0) continue;
    fails.push(
      `evals-ci holds ${rows.length} ${kind}: ${rows.map(describe).join(', ')}`
    );
  }
  const triggers = resources['issue-triggers'] ?? [];
  const declared = new Set(DEFAULT_ISSUE_TRIGGERS.map((d) => d.type));
  for (const d of DEFAULT_ISSUE_TRIGGERS) {
    const ofType = triggers.filter((t) => t.type === d.type);
    if (ofType.length === 0)
      fails.push(`evals-ci has no ${d.type} issue trigger`);
    if (ofType.length > 1) {
      fails.push(
        `evals-ci has ${ofType.length} ${d.type} issue triggers: ${ofType.map(describe).join(', ')}`
      );
    }
    for (const t of ofType) {
      if (!issueTriggerMatchesDeclared(t, d.configs)) {
        fails.push(
          `evals-ci ${d.type} trigger ${t.id} differs from DEFAULT_ISSUE_TRIGGERS (configs, channels, name or enabled)`
        );
      }
    }
  }
  for (const t of triggers.filter((t) => !declared.has(String(t.type)))) {
    fails.push(
      `evals-ci has an undeclared ${String(t.type)} issue trigger ${t.id}`
    );
  }
  return fails;
}

/**
 * The Outpost project's Event Gateway side against its declared baseline, by
 * id: anything the baseline does not list is a leftover.
 */
export function evaluateOutpostGateway(
  resources: Record<string, HookdeckResource[]>,
  baseline: PristineSnapshot
): string[] {
  const fails: string[] = [];
  for (const [kind, rows] of Object.entries(resources).sort()) {
    const allowed = new Set(baseline.ids[kind] ?? []);
    const extra = rows.filter((r) => !allowed.has(r.id));
    if (extra.length > 0) {
      fails.push(
        `the Outpost project's gateway side holds ${extra.length} ${kind} its baseline does not declare: ${extra.map(describe).join(', ')}`
      );
    }
  }
  return fails;
}
