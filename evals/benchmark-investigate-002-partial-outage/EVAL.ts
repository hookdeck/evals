import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
  judge,
  serializeTranscript,
} from '@hookdeck-evals/core';
import { stripIndent } from 'common-tags';

/**
 * A partial outage with no failures in it.
 *
 * Twelve orders arrive across three channels. The connection carries a filter
 * for `channel: "web"`, so five route and deliver successfully and seven are
 * ignored at ingestion. Nothing errors. Every event that exists is
 * `SUCCESSFUL`, the destination is healthy, the connection is enabled, and the
 * source is accepting everything it is sent.
 *
 * Written to test a design note the earlier scenarios failed. BM7 and BM8 both
 * pass on every configuration including the weak model, because each is a
 * single lookup: one destination returns 422, or one boolean field is set.
 * Nothing about them rewards holding two facts at once. The scenarios that have
 * discriminated all failed *silently*, so this one has no failure in it at all.
 *
 * The correlation is the task. Requests show twelve arrivals; events show five.
 * Neither number means anything alone, and the gap is only explicable by
 * reading the connection's filter and matching it against what was sent. An
 * agent that opens the events list sees an unbroken run of successes, which is
 * the plausible wrong answer this scenario deliberately makes available: the
 * prompt even says every delivery it can see went through fine, which is true.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [
    checkLookedBeyondEvents(ctx),
    await checkFoundTheFilter(ctx),
    await checkDidNotReportHealthy(ctx),
  ];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Did the agent look past the events list.
 *
 * Deliberately broad about *what* it read. The filter can be found from the
 * connection, and the shortfall from requests or from ingestion counts, and all
 * of those are legitimate routes. What is not legitimate is answering from the
 * events list alone, because every row in it succeeded.
 */
function checkLookedBeyondEvents(ctx: ToolEvalContext): CheckResult {
  const looked = ctx.toolCalls.some((call) => {
    const haystack = `${call.endpoint} ${call.command ?? ''} ${call.url ?? ''}`;
    return /requests|connections|ignored/i.test(haystack);
  });

  return {
    name: 'looked past the events list',
    passed: looked,
    notes: looked
      ? undefined
      : 'only the events list was read, and every event in it succeeded',
  };
}

async function checkFoundTheFilter(ctx: ToolEvalContext): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
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
  });

  return {
    name: 'identified the filter as the cause and what it excludes',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

/**
 * The specific wrong answer this scenario is built to catch, as a pure
 * negative: everything visible is healthy, and saying so is the failure.
 */
async function checkDidNotReportHealthy(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
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
  });

  return {
    name: 'did not report the system as healthy',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
