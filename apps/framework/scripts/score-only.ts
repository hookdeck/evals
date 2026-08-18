import { pathToFileURL } from 'node:url';
import type { ToolScorer } from '@hookdeck-evals/core';
import {
  discoverEvals,
  loadExperiments,
  readSessionSeedArgs,
} from '../lib/discovery.js';
import type { EvalManifest } from '../harness/types.js';

/**
 * Run a scorer repeatedly against one unchanging project, and report whether it
 * agrees with itself.
 *
 * **This is how a scorer change gets validated without paying for agents.** A
 * full matrix is about $64 and a targeted re-run about $50, and neither
 * actually answers the question a scorer change raises. An agent run measures
 * agent variance and scorer variance together, and cannot separate them: Loop 1
 * attributed four failures to a CLI defect that a control run later showed were
 * variance, and every conclusion drawn from those failures was wrong. This
 * measures the scorer alone, costs API calls, and can be run as often as it
 * takes.
 *
 * The measurement is deliberately harsher than a real run. One session is
 * leased and the scorer runs against it N times *without re-provisioning*, so
 * the project is not merely equivalent between iterations, it is identical.
 * Anything but N identical verdicts is the scorer disagreeing with itself, and
 * there is nowhere else for the disagreement to have come from.
 *
 * ## What this does not cover, which matters
 *
 * No agent runs, so the project holds only what the seed put there. For a build
 * scenario that means the configuration under test does not exist and the
 * scorer fails every iteration. Identical failures are still a real result —
 * they rule out the "scorer finds nothing on one run and something on the next"
 * class — but they exercise the *failing* path only.
 *
 * The race this was built to chase lived on the other path. A fixed sleep
 * against asynchronous ingestion produced false *failures* against *correct*
 * configurations, and nothing here ever builds one. So a clean sweep is
 * evidence the scorers are self-consistent, not proof the polling conversion
 * worked.
 *
 * Closing that gap needs a known-good configuration per scenario — a
 * `SOLUTION.ts` the harness applies before scoring, so the scorer meets the
 * state a correct agent would have left. That is the next step and it is
 * tracked in #14.
 *
 * It also cannot tell you a scorer is *right*: one that consistently fails a
 * correct configuration is stable and wrong, and this calls it stable.
 *
 * ```
 * pnpm --filter @hookdeck-evals/framework score-only \
 *   --eval benchmark-verification-001-stripe-express --repeat 5
 * ```
 *
 * With no `--eval` it sweeps every benchmark scenario, which is the form that
 * answers "did the polling conversion hold" across the ten converted scorers.
 */

const rawArgs = process.argv.slice(2);

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = rawArgs.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = rawArgs.indexOf(`--${name}`);
  if (idx !== -1) {
    const value = rawArgs[idx + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    return value;
  }
  return undefined;
}

const EVAL_FILTER = readFlag('eval');
const REPEAT = Number(readFlag('repeat') ?? 3);
const EXPERIMENT = readFlag('experiment');

interface Verdict {
  passed: boolean;
  /** Check name to pass/fail, for reporting which check moved. */
  checks: Record<string, boolean>;
  error?: string;
}

/**
 * Score one scenario `REPEAT` times against a single leased project.
 *
 * The session is created once and disposed at the end. No agent runs, so the
 * project holds exactly what the scenario's seed put there — which means a
 * scorer whose scenario expects agent work will fail every iteration. That is
 * the expected and useful result: what matters is that it fails the *same way*
 * every time. A scorer that fails four times and passes once against unchanged
 * state has found nothing; it has flaked.
 */
async function scoreRepeatedly(
  ev: EvalManifest,
  runtime: { startSession: (args?: unknown) => Promise<any> }
): Promise<Verdict[]> {
  const scorer = (await import(pathToFileURL(ev.evalPath).href))
    .default as ToolScorer;

  // Seeded exactly as the runner seeds it, so the scorer reads the scenario's
  // real starting state. Without this the project is pristine and every scorer
  // that reads seeded delivery history fails for reasons unrelated to itself.
  const session = await runtime.startSession(readSessionSeedArgs(ev));

  const verdicts: Verdict[] = [];
  try {
    for (let i = 0; i < REPEAT; i += 1) {
      try {
        const result = await scorer({
          ...session.scoringContext,
          // No agent ran, so there is nothing to inspect. Scorers that read
          // these get empty collections rather than undefined, which is what
          // they would see from an agent that did nothing.
          toolCalls: [],
          transcript: [],
          agentReport: '',
        } as never);
        verdicts.push({
          passed: result.passed,
          checks: Object.fromEntries(
            (result.checks ?? []).map((c) => [c.name, Boolean(c.passed)])
          ),
        });
      } catch (error) {
        // A throwing scorer is itself a stability result, so record it as a
        // verdict rather than ending the sweep.
        verdicts.push({
          passed: false,
          checks: {},
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const latest = verdicts[verdicts.length - 1];
      process.stdout.write(
        `  ${ev.id} ${i + 1}/${REPEAT}: ${latest.passed ? 'pass' : 'fail'}` +
          `${latest.error ? ` (threw: ${latest.error.slice(0, 60)})` : ''}\n`
      );
    }
  } finally {
    await session[Symbol.asyncDispose]?.();
  }

  return verdicts;
}

/** Which checks did not return the same verdict every time. */
function unstableChecks(verdicts: Verdict[]): string[] {
  const names = new Set(verdicts.flatMap((v) => Object.keys(v.checks)));
  return [...names].filter((name) => {
    const values = verdicts.map((v) => v.checks[name]);
    return new Set(values).size > 1;
  });
}

async function main() {
  const experiments = await loadExperiments();
  // Any experiment will do: the runtime provisions the project and the agent is
  // never invoked, so the choice affects nothing being measured here.
  const chosen = EXPERIMENT
    ? experiments.find((e) => e.name === EXPERIMENT)
    : experiments[0];
  if (!chosen) {
    throw new Error(
      `no experiment${EXPERIMENT ? ` named ${EXPERIMENT}` : 's found'}`
    );
  }

  const evals = discoverEvals()
    .filter((e) => e.suite === 'benchmark')
    .filter((e) => !EVAL_FILTER || e.id === EVAL_FILTER);

  if (evals.length === 0) {
    throw new Error(
      `no benchmark eval matched${EVAL_FILTER ? ` ${EVAL_FILTER}` : ''}`
    );
  }

  console.log(
    `Scoring ${evals.length} scenario(s) x ${REPEAT} against unchanging project state\n` +
      `runtime from experiment: ${chosen.name}\n`
  );

  const unstable: string[] = [];
  for (const ev of evals) {
    const verdicts = await scoreRepeatedly(ev, chosen.config.runtime as never);
    const passes = verdicts.filter((v) => v.passed).length;
    const moved = unstableChecks(verdicts);
    const stable = passes === 0 || passes === REPEAT;

    if (!stable || moved.length > 0) {
      unstable.push(ev.id);
      console.log(
        `UNSTABLE ${ev.id}: ${passes}/${REPEAT} passed` +
          (moved.length > 0 ? `, checks that moved: ${moved.join('; ')}` : '')
      );
    } else {
      console.log(`stable   ${ev.id}: ${passes}/${REPEAT} passed`);
    }
    console.log('');
  }

  console.log(
    unstable.length === 0
      ? `All ${evals.length} scorer(s) agreed with themselves across ${REPEAT} runs.`
      : `${unstable.length} unstable: ${unstable.join(', ')}`
  );

  // Non-zero on instability, so this is usable as a CI gate on scorer changes.
  process.exit(unstable.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
