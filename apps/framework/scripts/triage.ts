import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverEvals, EVALS_ROOT } from '../lib/discovery.js';

/**
 * Which cells of a run you have to read, and why.
 *
 * AGENTS.md already says to read the agent's report first, and calls it the
 * cheapest answer every time — and it keeps getting skipped, including by
 * whoever wrote that line. An exhortation loses to a scoreboard, because the
 * scoreboard is right there and the transcripts are not.
 *
 * The case for reading them is stronger than "sometimes useful". Over two days
 * of Outpost runs, **every** product finding came out of a transcript and none
 * came out of the scoreboard: an API answering `404` where `401` was meant, a
 * skill that never names the credential, docs whose environment variables do
 * not exist, and — worst — a harness omission that made our own baseline fail
 * twelve cells and read as a skills result. A pass rate cannot express any of
 * those. It cannot even distinguish "the agent could not" from "we lied to it".
 *
 * So this turns the convention into a list. It reads what the harness already
 * records and flags the cells where the number on the board is not the whole
 * story. It does not judge the run; it tells you where to look.
 *
 * ```bash
 * pnpm --filter @hookdeck-evals/framework triage
 * pnpm --filter @hookdeck-evals/framework triage --require OUTPOST_API_KEY
 * ```
 */

const RUNS_DIR = join(EVALS_ROOT, '.eval-runs');

interface Check {
  name?: string;
  passed?: boolean;
}

interface Row {
  experiment: string;
  eval: string;
  passed?: boolean;
  checks?: Check[];
  stoppedReason?: string;
  agentReport?: string;
  toolCalls?: unknown[];
  skills?: {
    available?: string[];
    loaded?: string[];
    selfInstalled?: string[];
  };
}

interface Flag {
  label: string;
  detail: string;
}

/**
 * Capabilities a scenario declares, mapped to the variable that carries them.
 *
 * Derived from each scenario's `requires`, not from a flag on the command line.
 * A blanket `--require OUTPOST_API_KEY` flagged the ElevenLabs and Stripe
 * scenarios for not using an Outpost credential they have no business touching,
 * and a triage tool that cries wolf gets ignored — which returns us to nobody
 * reading transcripts, the thing this exists to fix.
 */
const CAPABILITY_ENV: Record<string, string> = { outpost: 'OUTPOST_API_KEY' };

/**
 * Skills whose self-installation invalidates a baseline.
 *
 * Only these. AGENTS.md draws the line deliberately: a *product* skill pulled
 * into a `-no-skills` run means that row is no longer a baseline, while a
 * *provider* skill like `stripe-webhooks` is legitimate — documenting a third
 * party's signature format was never Hookdeck's job, and we ship those skills
 * for exactly this. Flagging every self-install buried the real case in noise.
 */
const PRODUCT_SKILLS = new Set(['hookdeck', 'event-gateway', 'outpost']);

/** Phrases an agent uses when it believes it finished. */
const SUCCESS_CLAIM =
  /\b(everything (is )?(set up|working|verified)|successfully|all set|is now (set up|configured|working)|done!|completed successfully|verified end-to-end)\b/i;

/**
 * A clean stop. Anything else means the process died, and a dead run must not
 * be read as an agent's answer — the guard in `run-eval.ts` only rejects an
 * *empty* transcript, so a container killed mid-flight arrives here with 15
 * tool calls and a plausible partial score. One did, on 21 August, and was
 * written as a `2/6` agent failure.
 */
const CLEAN_STOP = new Set(['stop', 'end_turn', 'complete']);

function flagsFor(row: Row, requiredEnv: string[]): Flag[] {
  const flags: Flag[] = [];
  const blob = JSON.stringify(row);
  const checks = row.checks ?? [];
  const failed = checks.filter((c) => c.passed === false);

  if (row.stoppedReason && !CLEAN_STOP.has(row.stoppedReason)) {
    flags.push({
      label: 'UNCLEAN EXIT',
      detail: `stoppedReason=${row.stoppedReason} — the process did not finish, so this is not the agent's answer`,
    });
  }

  // The most valuable signal in the whole file. An agent that fails while
  // reporting success has done something coherent and wrong, which is where
  // findings come from — nine of twelve baselines did exactly this in one run,
  // having built the task on the wrong product.
  if (row.passed === false && SUCCESS_CLAIM.test(row.agentReport ?? '')) {
    flags.push({
      label: 'CLAIMED SUCCESS',
      detail: 'failed while reporting the task complete — read this one first',
    });
  }

  // A credential the scenario needs that the agent never referenced usually
  // means it never found the thing, and that is often our fault rather than
  // the model's: the variable may be injected and unannounced.
  for (const name of requiredEnv) {
    if (row.passed === false && !blob.includes(name)) {
      flags.push({
        label: 'CREDENTIAL UNUSED',
        detail: `${name} never appears — did the agent know it existed?`,
      });
    }
  }

  const available = row.skills?.available ?? [];
  const loaded = row.skills?.loaded ?? [];
  if (row.passed === false && available.length > 0 && loaded.length === 0) {
    flags.push({
      label: 'SKILL NOT OPENED',
      detail: `offered ${available.join(', ')} and loaded none — this measures selection, not content`,
    });
  }

  const smuggled = (row.skills?.selfInstalled ?? []).filter((n) =>
    PRODUCT_SKILLS.has(n)
  );
  if (smuggled.length > 0 && row.experiment.endsWith('-no-skills')) {
    flags.push({
      label: 'BASELINE COMPROMISED',
      detail: `fetched product skill ${smuggled.join(', ')} at run time — exclude this row from any skills delta`,
    });
  }

  // Passing only negative checks is a do-nothing run wearing a partial score.
  if (
    row.passed === false &&
    failed.length > 0 &&
    failed.length < checks.length
  ) {
    // *Every* green check must be a negative one, not merely some of them.
    // Matching on any was wrong: a cell where the agent re-enabled a
    // destination but never recovered the held events has one real positive
    // green and one negative, and flagging it as idle misdescribes an agent
    // that did half the job. The signal being hunted here is the run that did
    // nothing and still scored.
    const passedNames = checks.filter((c) => c.passed).map((c) => c.name ?? '');
    const isNegative = (n: string) =>
      /left alone|unchanged|untouched|no longer|not .*(disabled|removed)|was not/i.test(
        n
      );
    if (passedNames.length > 0 && passedNames.every(isNegative)) {
      flags.push({
        label: 'ONLY NEGATIVES PASSED',
        detail: `${checks.length - failed.length}/${checks.length} green, and they are the checks an idle agent satisfies`,
      });
    }
  }

  if (row.passed === false && (row.toolCalls?.length ?? 0) === 0) {
    flags.push({ label: 'NO TOOL CALLS', detail: 'scored without acting' });
  }

  return flags;
}

function main() {
  const args = process.argv.slice(2);
  void args;

  // What each scenario declares it needs, by eval id.
  const needs = new Map<string, string[]>();
  for (const ev of discoverEvals()) {
    const requires =
      (ev.metadata as { requires?: string[] } | undefined)?.requires ?? [];
    const env = requires
      .map((r) => CAPABILITY_ENV[r])
      .filter((v): v is string => Boolean(v));
    if (env.length > 0) needs.set(ev.id, env);
  }

  if (!existsSync(RUNS_DIR)) throw new Error(`no ${RUNS_DIR}`);

  const rows: Array<{ row: Row; flags: Flag[] }> = [];
  for (const dir of readdirSync(RUNS_DIR)) {
    const experimentDir = join(RUNS_DIR, dir);
    let files: string[] = [];
    try {
      files = readdirSync(experimentDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const row = JSON.parse(
        readFileSync(join(experimentDir, file), 'utf8')
      ) as Row;
      const flags = flagsFor(row, needs.get(row.eval) ?? []);
      if (flags.length > 0) rows.push({ row, flags });
    }
  }

  const total = readdirSync(RUNS_DIR).reduce((n, d) => {
    try {
      return (
        n +
        readdirSync(join(RUNS_DIR, d)).filter((f) => f.endsWith('.json')).length
      );
    } catch {
      return n;
    }
  }, 0);

  console.log(`${total} cell(s) on disk; ${rows.length} worth reading.\n`);
  if (rows.length === 0) {
    console.log(
      '  Nothing flagged. That is not the same as nothing to learn —'
    );
    console.log('  it means no cell tripped a signal this script knows about.');
    return;
  }

  // Claimed-success first: it is the one that has produced findings.
  rows.sort((a, b) => {
    const rank = (f: Flag[]) =>
      f.some((x) => x.label === 'CLAIMED SUCCESS')
        ? 0
        : f.some((x) => x.label === 'UNCLEAN EXIT')
          ? 1
          : 2;
    return rank(a.flags) - rank(b.flags);
  });

  for (const { row, flags } of rows) {
    console.log(`  ${row.eval} x ${row.experiment}`);
    for (const flag of flags) {
      console.log(`      ${flag.label}: ${flag.detail}`);
    }
    console.log(
      `      → .eval-runs/${row.experiment}/${row.eval}.json (agentReport, toolCalls)\n`
    );
  }
}

main();
