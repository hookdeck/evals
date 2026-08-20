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
 * Each iteration leases its own session, seeds it, applies the solution if there
 * is one, and scores once. That is one project per iteration rather than one per
 * scenario, which is slower and costs more leases — and it is necessary.
 *
 * The first version reused a single session, on the reasoning that identical
 * state is a harsher test than merely equivalent state. It is, for a scorer that
 * only reads. Most of these scorers *send traffic*, and a second run against the
 * same project is not a repeat: `dedupe-001` derives its probe reference from
 * `acquiredAt`, which is fixed per session, so every iteration reused the same
 * reference and piled more events behind it. It passed once and then failed,
 * and the failure was the harness accumulating state, not the scorer moving.
 *
 * Fresh per iteration is also what a real run looks like, so a verdict that
 * changes here is a verdict that could change in production.
 *
 * ## Which path gets exercised
 *
 * With no agent, the project holds only what the seed put there, so a build
 * scenario's configuration does not exist and its scorer fails every iteration.
 * Identical failures rule out one flake class — the scorer finding nothing on
 * one run and something on the next — but only on the *failing* path.
 *
 * The race this chases lived on the other path: a fixed sleep against
 * asynchronous ingestion produced false *failures* against *correct*
 * configurations. So a scenario with a `SOLUTION.ts` gets it applied after
 * seeding, and the scorer then meets the state a correct agent would have left.
 * Those are the runs that actually test the polling conversion, and for the
 * paired-assertion scenarios they test something sharper still: `waitForSettled`
 * can produce a false *pass* if a negative probe lands after the settle window,
 * which is a worse failure than the sleep it replaced.
 *
 * Scenarios without a `SOLUTION.ts` still run, on the failing path only. Ones
 * whose deliverable is code cannot have one: there is no sandbox here to stand
 * an agent's handler up in.
 *
 * It still cannot tell you a scorer is *right*: one that consistently fails a
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

/**
 * Score the seeded state *without* applying the solution.
 *
 * The other half of what this script is for. A scorer that passes with the
 * solution applied has been shown to accept a correct answer; it has not been
 * shown to reject an incorrect one, and a scorer that passes unconditionally
 * does the first perfectly. Every check that came back green here would be
 * green for an agent that did nothing at all.
 *
 * So the expected outcome of this mode is **fail**. A pass is the bug.
 */
const NO_SOLUTION = rawArgs.includes('--no-solution');

const EVAL_FILTER = readFlag('eval');
const REPEAT = Number(readFlag('repeat') ?? 3);
const EXPERIMENT = readFlag('experiment');

interface Verdict {
  passed: boolean;
  /** Check name to pass/fail, for reporting which check moved. */
  checks: Record<string, boolean>;
  /**
   * Checks decided by the LLM judge, identified by the scorer attaching
   * `judgeNotes`. Tracked separately because with no agent there is no report
   * for a judge to read, so it is being asked whether an empty string claimed
   * something — an ill-posed question whose answer is entitled to vary. Counting
   * that as scorer instability makes every scenario with a judged check look
   * broken for a reason this tool cannot investigate.
   */
  judged: Set<string>;
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
  const solution = ev.solutionPath
    ? ((await import(pathToFileURL(ev.solutionPath).href)).default as (
        ctx: unknown
      ) => Promise<void>)
    : undefined;

  const verdicts: Verdict[] = [];

  for (let i = 0; i < REPEAT; i += 1) {
    // Seeded exactly as the runner seeds it, so the scorer reads the scenario's
    // real starting state. Without this the project is pristine and every
    // scorer reading seeded history fails for reasons unrelated to itself.
    const session = await runtime.startSession(readSessionSeedArgs(ev));
    try {
      if (solution && !NO_SOLUTION) await solution(session.scoringContext);

      const result = await scorer({
        ...session.scoringContext,
        // No agent ran, so there is nothing to inspect. Scorers that read these
        // get empty collections rather than undefined, which is what they would
        // see from an agent that did nothing.
        toolCalls: [],
        transcript: [],
        agentReport: '',
      } as never);
      verdicts.push({
        passed: result.passed,
        checks: Object.fromEntries(
          (result.checks ?? []).map((c) => [c.name, Boolean(c.passed)])
        ),
        judged: new Set(
          (result.checks ?? [])
            .filter((c) => (c as { judgeNotes?: string }).judgeNotes)
            .map((c) => c.name)
        ),
      });
    } catch (error) {
      // A throwing scorer is itself a stability result, so record it as a
      // verdict rather than ending the sweep.
      verdicts.push({
        passed: false,
        checks: {},
        judged: new Set<string>(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await session[Symbol.asyncDispose]?.();
    }

    const latest = verdicts[verdicts.length - 1];
    process.stdout.write(
      `  ${ev.id}${solution && !NO_SOLUTION ? ' [solution]' : ''}${NO_SOLUTION ? ' [unsolved]' : ''} ${i + 1}/${REPEAT}: ${latest.passed ? 'pass' : 'fail'}` +
        `${latest.error ? ` (threw: ${latest.error.slice(0, 60)})` : ''}\n`
    );
  }

  return verdicts;
}

/** Which checks did not return the same verdict every time, split by kind. */
function unstableChecks(verdicts: Verdict[]): {
  deterministic: string[];
  judged: string[];
} {
  const names = new Set(verdicts.flatMap((v) => Object.keys(v.checks)));
  const judgedNames = new Set(verdicts.flatMap((v) => [...v.judged]));
  const moved = [...names].filter(
    (name) => new Set(verdicts.map((v) => v.checks[name])).size > 1
  );
  return {
    deterministic: moved.filter((n) => !judgedNames.has(n)),
    judged: moved.filter((n) => judgedNames.has(n)),
  };
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

    // Only deterministic checks decide the verdict. A judged check moving is
    // reported, because it is worth knowing, but it is not evidence about the
    // scorer: see the note on `Verdict.judged`.
    if (moved.deterministic.length > 0) {
      unstable.push(ev.id);
      console.log(
        `UNSTABLE ${ev.id}: ${passes}/${REPEAT} passed, checks that moved: ` +
          moved.deterministic.join('; ')
      );
    } else {
      console.log(`stable   ${ev.id}: ${passes}/${REPEAT} passed`);
    }
    if (moved.judged.length > 0) {
      console.log(
        `         judged checks also moved (no agent report to judge, not ` +
          `counted): ${moved.judged.join('; ')}`
      );
    }
    console.log('');
  }

  const withSolution = evals.filter((e) => e.solutionPath).length;
  console.log(
    unstable.length === 0
      ? `All ${evals.length} scorer(s) agreed with themselves across ${REPEAT} runs.`
      : `${unstable.length} unstable: ${unstable.join(', ')}`
  );
  // Stated every time, including on a clean sweep. Without it, "all stable"
  // reads as "the conversion is validated" when most scenarios only exercised
  // the failing path.
  console.log(
    `${withSolution} of ${evals.length} scenario(s) had a SOLUTION.ts and tested ` +
      'the correct-configuration path; the rest tested the failing path only.'
  );

  // Non-zero on instability, so this is usable as a CI gate on scorer changes.
  process.exit(unstable.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
