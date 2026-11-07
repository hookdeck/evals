import { readRepeatedFlag } from '../cli-args.js';
import { DISPATCH_DEFAULTS, type DispatchInputs } from './matrix.js';

/**
 * Every check, by the id `--skip` takes and its number in #131. The canary is
 * the requirement #131 attaches to checks 1, 2 and 4, numbered after them. The
 * skills CLI pin is a sixteenth decision #131 did not list: it is a build arg
 * of the same image as the Hookdeck CLI, and nothing compared it either.
 */
export const CHECKS = [
  { number: 1, id: 'hookdeck-cli-pin', title: 'Hookdeck CLI pin' },
  { number: 2, id: 'agent-cli-pins', title: 'Agent CLI pins' },
  { number: 3, id: 'skills-pin', title: 'Skills pin' },
  { number: 4, id: 'model-ids', title: 'Model IDs' },
  { number: 5, id: 'base-prompt', title: 'Base prompt' },
  { number: 6, id: 'provider-keys', title: 'Provider keys work' },
  { number: 7, id: 'spend', title: 'Spend' },
  { number: 8, id: 'secrets', title: 'Secrets' },
  { number: 9, id: 'main-green', title: 'Main is green' },
  { number: 10, id: 'nothing-running', title: 'Nothing else is running' },
  { number: 11, id: 'repo-variables', title: 'Repository variables' },
  { number: 12, id: 'projects-pristine', title: 'Projects are pristine' },
  { number: 13, id: 'skill-links', title: 'Skill links resolve' },
  { number: 14, id: 'harness-issues', title: 'Open harness issues' },
  { number: 15, id: 'canary', title: 'Canary' },
  { number: 16, id: 'skills-cli-pin', title: 'Skills CLI pin' },
] as const;

export type CheckId = (typeof CHECKS)[number]['id'];

export interface PreflightArgs {
  json: boolean;
  help: boolean;
  skip: CheckId[];
  confirmBalance: boolean;
  dispatch: DispatchInputs;
  /** What `EVALS_PUBLISH` should be for this run: publish unless held. */
  holdPublish: boolean;
  /** What `EVALS_MAX_MISSING_FRACTION` should resolve to. */
  maxMissingFraction: string;
  acceptHarness: number[];
  canaryRun?: string;
  canaryEval: string;
}

export const DEFAULT_MAX_MISSING_FRACTION = '0.1';
export const DEFAULT_CANARY_EVAL = 'benchmark-localdev-001-listen-locally';

function single(raw: string[], name: string): string | undefined {
  const values = readRepeatedFlag(raw, name);
  if (values.length > 1) throw new Error(`--${name} takes one value`);
  return values[0];
}

const KNOWN_FLAGS = new Set([
  'json',
  'help',
  'skip',
  'confirm-balance',
  'experiments',
  'eval',
  'suite',
  'experiment-suite',
  'runs',
  'timeout-sec',
  'merge',
  'hold-publish',
  'max-missing-fraction',
  'accept-harness',
  'canary-run',
  'canary-eval',
]);

/**
 * Flags mirror the `workflow_dispatch` inputs, so the command that checks a
 * matrix reads like the command that dispatches it. `--timeout-sec` and
 * `--merge` are accepted and do not change any check.
 */
export function parsePreflightArgs(argv: string[]): PreflightArgs {
  const raw = argv.filter((a) => a !== '--');
  for (const arg of raw) {
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2).split('=')[0] as string;
    if (!KNOWN_FLAGS.has(name)) throw new Error(`unknown flag ${arg}`);
  }

  const known = new Set<string>(CHECKS.map((c) => c.id));
  const skip = readRepeatedFlag(raw, 'skip');
  const unknown = skip.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    throw new Error(
      `--skip: no check named ${unknown.join(', ')}. Checks: ${[...known].join(', ')}`
    );
  }

  const runsRaw = single(raw, 'runs');
  const runs = runsRaw === undefined ? DISPATCH_DEFAULTS.runs : Number(runsRaw);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs must be a positive integer, got ${runsRaw}`);
  }

  const listOr = (name: string, fallback: string[]) => {
    const v = readRepeatedFlag(raw, name);
    return v.length > 0 ? v : fallback;
  };

  const accept = readRepeatedFlag(raw, 'accept-harness').map((v) => {
    const n = Number(v.replace(/^#/, ''));
    if (!Number.isInteger(n)) throw new Error(`--accept-harness: ${v}`);
    return n;
  });

  const maxMissing = single(raw, 'max-missing-fraction');
  if (maxMissing !== undefined && !/^\d*\.?\d+$/.test(maxMissing)) {
    throw new Error(
      `--max-missing-fraction must be a number, got ${maxMissing}`
    );
  }

  return {
    json: raw.includes('--json'),
    help: raw.includes('--help') || raw.includes('-h'),
    skip: skip as CheckId[],
    confirmBalance: raw.includes('--confirm-balance'),
    dispatch: {
      suites: listOr('suite', DISPATCH_DEFAULTS.suites),
      experimentSuites: listOr(
        'experiment-suite',
        DISPATCH_DEFAULTS.experimentSuites
      ),
      experiments: readRepeatedFlag(raw, 'experiments'),
      evalIds: readRepeatedFlag(raw, 'eval'),
      runs,
    },
    holdPublish: raw.includes('--hold-publish'),
    maxMissingFraction: maxMissing ?? DEFAULT_MAX_MISSING_FRACTION,
    acceptHarness: accept,
    canaryRun: single(raw, 'canary-run'),
    canaryEval: single(raw, 'canary-eval') ?? DEFAULT_CANARY_EVAL,
  };
}

export const USAGE = `pnpm preflight [options]

Checks a matrix before it is dispatched. Read-only, except one real completion
per provider (pennies). Exits non-zero when an assertion fails.

What the dispatch will run (mirrors the workflow_dispatch inputs; defaults are
the workflow's, which is the regression suite):
  --suite <list>             eval suites (default regression)
  --experiment-suite <list>  experiment suites (default regression)
  --experiments <list>       experiment names (default: all in the suites)
  --eval <list>              eval ids (overrides --suite, as in the workflow)
  --runs <n>                 attempts per cell (default 2)
  --timeout-sec, --merge     accepted; change nothing here

What the run intends:
  --hold-publish             expect EVALS_PUBLISH=false (default: expect publishing)
  --max-missing-fraction <n> expect this EVALS_MAX_MISSING_FRACTION (default 0.1)
  --accept-harness <list>    open harness issues accepted for this run, by number
  --confirm-balance          confirm both provider balances cover the estimate
                             (asked interactively instead when on a TTY)
  --canary-run <id>          verify a finished two-cell canary run
  --canary-eval <id>         scenario the canary command uses
                             (default ${DEFAULT_CANARY_EVAL})

Output:
  --json                     machine-readable report; run as \`pnpm -s preflight --json\`
                             so pnpm's banner stays out of the JSON
  --skip <list>              skip checks by id; printed loudly. Ids:
                             ${CHECKS.map((c) => c.id).join(', ')}

A full benchmark matrix:
  pnpm preflight --suite benchmark --experiment-suite benchmark,no-skills --runs 3
`;
