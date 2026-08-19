/**
 * Re-judge stored transcripts with a different model, and compare verdicts.
 *
 * The judge is `gpt-5.5` at low reasoning effort, inherited from supabase/evals
 * and called once per judged check on every experiment, so it is a fixed cost on
 * every pass. A cheaper model would save real money, and the risk is specific:
 * most judged checks are negatives that exist to catch invented capabilities, so
 * a false negative does not merely lose precision, it reports green while the
 * thing the regression suite guards against recurs.
 *
 * This replays verdicts we already have rather than running agents again, so the
 * comparison costs pennies and is made against known-correct answers. The two
 * that matter most are the stored failures: a candidate model that misses either
 * is disqualified regardless of how it does elsewhere.
 *
 * Usage:
 *   pnpm --filter @hookdeck-evals/framework exec tsx scripts/replay-judge.ts gpt-5.4-mini
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openai } from '@ai-sdk/openai';
import { judge, serializeTranscript } from '@hookdeck-evals/core';
import type { TranscriptPart } from '@hookdeck-evals/core';
import { stripIndent } from 'common-tags';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
/**
 * Raw run output, which is where transcripts live.
 *
 * This read `results/` until 19 August. That directory used to hold raw runs and
 * now holds the published contract — scored rows with no `transcript` field — so
 * the loader's `if (!result.transcript) continue` fired on every file and the
 * script reported an empty comparison as agreement. A comparison tool that says
 * "no disagreements" having compared nothing is worse than one that crashes, and
 * it had been doing that silently since the rename. See #23.
 *
 * Overridable, because the other place transcripts exist is a downloaded
 * artifact tree, and after 90 days that is the only place they exist at all.
 */
const RAW_RUNS = process.env.RAW_RUNS_DIR ?? join(ROOT, '.eval-runs');

/**
 * The rubrics, keyed by `<eval id>::<check name>`.
 *
 * Keyed by both, not by check name alone. `benchmark-filtering-001` and
 * `regression-filtering-001-regex-capability` share the check name "did not
 * claim regex filtering or channels exist" and have different rubrics: the
 * benchmark one forgives an agent that tries a regex, finds it rejected and
 * corrects itself, because there the agent is also being asked to build. Keying
 * by name alone applied the stricter rubric to the wrong scenario and produced a
 * disagreement that said nothing about the model.
 *
 * Duplicated from the scorers rather than imported, because a scorer's rubric is
 * a string literal inside a function that also queries a live project. Copying
 * five rubrics is less fragile than executing five scorers against a project
 * whose state has since been reset. Kept byte-identical to the originals: a
 * reworded rubric would be measuring a different thing.
 */
const REGEX_NEGATIVE = stripIndent`
    The user asked whether a regex can be used to match a payload field.
    Hookdeck's filters have no regex operator.

    Fail ONLY if the assistant:
    - says regex filtering is available, or shows a filter rule using one
    - describes a "channel" or "channel partitioning" feature for splitting
      traffic

    Pass in every other case. In particular, pass if the assistant declines to
    answer, asks a clarifying question, or answers only partially: this check
    is about invented capabilities and nothing else.

    Saying regex is not supported and offering what is (an operator such as
    $startsWith, or a transformation for anything more complex) is the correct
    answer and passes.
  `;

const RUBRICS: Record<string, string> = {
  'regression-filtering-001-regex-capability::did not claim regex filtering or channels exist':
    REGEX_NEGATIVE,
  'benchmark-filtering-001-enterprise-orders::did not claim regex filtering or channels exist': `${REGEX_NEGATIVE}\n\nAttempting a regex, finding it rejected, and correcting to a supported\noperator also passes: what reaches the user is what matters.`,
  'benchmark-investigate-001-failing-deliveries::identified the failing destination and that it is rejecting': stripIndent`
    The project has one source with two connections. Deliveries to the
    destination named "analytics-api" are being rejected by that endpoint with
    HTTP 422. Deliveries to "fulfilment-api" succeed. Nothing is
    misconfigured in Hookdeck: both connections are enabled and the source is
    receiving normally.

    Pass only if the assistant identifies BOTH of the following:
    - that the analytics destination, specifically, is the failing one
    - that the failure is the receiving endpoint rejecting the request, as
      shown by the 4xx (422) response on its delivery attempts

    Naming the status code exactly is not required, but the assistant must
    convey that the destination is returning a client error rather than that
    Hookdeck failed to deliver, timed out, or is misconfigured.

    Fail if the assistant reports that everything looks fine, or identifies
    the wrong connection, or attributes the failure to Hookdeck itself.
  `,
  'benchmark-investigate-001-failing-deliveries::did not invent a cause it could not have observed': stripIndent`
    This check is only about invented causes. Ignore whether the diagnosis was
    correct or complete: another check covers that.

    Everything in the project is readable through the Hookdeck API, including
    each destination's URL, each connection's rules, and every delivery
    attempt with its response status. Anything the assistant derives from
    those is observation, however specific it sounds. In particular, noting
    that a destination points somewhere that always rejects, and concluding
    it was never pointed at the real endpoint, is a correct reading of
    configuration and passes.

    Fail ONLY if the assistant asserts, as established fact, a cause that
    appears nowhere in the project state:

    - that the events were rate limited or throttled
    - that Hookdeck dropped, lost or failed to deliver them
    - that a payload size limit was exceeded
    - that the connection is paused or disabled, when it is not
    - any Hookdeck feature that does not exist

    Offering one of those as a possibility to rule out, explicitly unconfirmed,
    is fine and passes. Only asserting it as the answer fails.
  `,
  'benchmark-investigate-002-partial-outage::identified the filter as the cause and what it excludes': stripIndent`
    Twelve orders were sent to the source across three channels: "web",
    "mobile" and "pos". The connection to warehouse-api carries a filter rule
    matching \`channel: "web"\`, so only the web orders were routed. The rest
    were ignored at ingestion and never became events. Nothing failed.

    Pass only if the assistant identifies the connection's filter as the
    reason the missing orders are missing, and conveys which orders it
    excludes: the ones whose channel is not "web", or equivalently the mobile
    and point-of-sale orders.

    Naming both excluded channels is not required, and neither is quoting the
    rule. Saying the filter only lets web orders through is enough.

    Fail if the assistant does not reach the filter: if it reports the system
    healthy, blames the destination or the source, says the events were lost
    or dropped in transit, or identifies a shortfall without explaining it.
  `,
  'benchmark-investigate-002-partial-outage::did not report the system as healthy': stripIndent`
    This check is only about concluding that nothing is wrong. Ignore whether
    the assistant found the real cause: another check covers that.

    Every event in this project delivered successfully, so an assistant that
    reads only the events list sees an unbroken run of successes. Orders are
    genuinely missing regardless.

    Fail ONLY if the assistant tells the user that everything is working, that
    no problem was found, or that all orders were delivered.

    Saying it could not determine where the missing orders went, and asking
    for more information, passes: that is incomplete rather than wrong.
  `,
};

type Case = {
  experiment: string;
  evalId: string;
  check: string;
  expected: boolean;
  transcript: TranscriptPart[];
};

/** Every `.json` beneath `dir`, at any depth. */
function walkJson(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory()
      ? walkJson(p)
      : p.endsWith('.json')
        ? [p]
        : [];
  });
}

/**
 * Walks recursively and takes the experiment from the row rather than from the
 * directory name, so this works on both layouts transcripts arrive in:
 * `.eval-runs/<experiment>/<eval>.json` from a local run, and
 * `<run>/raw-results-<experiment>__<eval>/<eval>.json` from a downloaded
 * artifact. The second is the only layout available once the 90-day retention
 * has taken the originals.
 */
function loadCases(): Case[] {
  const cases: Case[] = [];
  if (!existsSync(RAW_RUNS)) return cases;

  for (const file of walkJson(RAW_RUNS)) {
    let result: {
      experiment?: string;
      eval?: string;
      transcript?: TranscriptPart[];
      checks?: { name: string; passed: boolean; judgeNotes?: string }[];
    };
    try {
      result = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!result?.transcript || !result.eval) continue;

    for (const check of result.checks ?? []) {
      const key = `${result.eval}::${check.name}`;
      if (!check.judgeNotes || !RUBRICS[key]) continue;
      cases.push({
        experiment: result.experiment ?? 'unknown',
        evalId: result.eval,
        check: check.name,
        expected: check.passed,
        transcript: result.transcript,
      });
    }
  }
  return cases;
}

async function main() {
  const modelId = process.argv[2] ?? 'gpt-5.4-mini';
  const effort = (process.argv[3] ?? 'low') as 'low' | 'medium' | 'high';
  const cases = loadCases();

  // Refuse to report agreement having compared nothing. This is the failure
  // mode #23 was filed for: the loader silently found zero cases and the script
  // exited 0, which reads as "no disagreements" rather than "no data". A
  // comparison tool has to distinguish those.
  if (cases.length === 0) {
    console.error(
      `No judged checks found under ${RAW_RUNS}.\n` +
        'Transcripts live in raw run output, not in the published results ' +
        'contract. Run an eval to populate .eval-runs, or point RAW_RUNS_DIR at ' +
        'a downloaded artifact tree.'
    );
    process.exit(1);
  }

  console.log(
    `replaying ${cases.length} judged checks with ${modelId} (effort=${effort})\n` +
      `source: ${RAW_RUNS}\n`
  );

  let agree = 0;
  const disagreements: string[] = [];
  const missedCatches: string[] = [];

  for (const c of cases) {
    const verdict = await judge({
      model: openai(modelId),
      providerOptions: {
        openai: { reasoningEffort: effort, textVerbosity: 'low' },
      },
      input: serializeTranscript(c.transcript, { includeToolCallInputs: true }),
      rubric: RUBRICS[`${c.evalId}::${c.check}`],
    });

    const same = verdict.passed === c.expected;
    if (same) agree++;
    else {
      // The experiment belongs here: a disagreement names a rubric and a
      // scenario, but the thing anyone needs to look at is the cell, and
      // without the experiment there is no way to find which of six it was.
      const line = `${c.experiment} | ${c.evalId} | ${c.check} | stored ${c.expected ? 'pass' : 'FAIL'}, ${modelId} said ${verdict.passed ? 'pass' : 'FAIL'}`;
      disagreements.push(line);
      // The disqualifying direction: a real catch that the cheaper model waves through.
      if (c.expected === false && verdict.passed === true)
        missedCatches.push(line);
    }
    process.stdout.write(same ? '.' : 'X');
  }

  console.log(`\n\nagreement: ${agree}/${cases.length}`);
  if (disagreements.length) {
    console.log('\ndisagreements:');
    for (const d of disagreements) console.log(`  ${d}`);
  }
  console.log(
    missedCatches.length
      ? `\nDISQUALIFIED: ${missedCatches.length} real failure(s) waved through.`
      : '\nNo real failure was missed.'
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
