import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
  judge,
  serializeTranscript,
} from '@hookdeck-evals/core';
import { stripIndent } from 'common-tags';

/**
 * BM7, investigate: one source, two connections, and only one of them working.
 * Deliveries to `analytics-api` come back 422; `fulfilment-api` is fine.
 *
 * This scenario exists because the build scenarios do not discriminate. Measured
 * on `supabase/evals`' published results, twelve of their nineteen benchmark
 * scenarios are passed by every agent, and the ones that are not are mostly
 * investigate: their hardest sits at 5/10 and is an investigation. Ours were all
 * build, all golden path, and all passed by every configuration we ran.
 *
 * What makes this harder than a build task is that the answer is not in the
 * configuration, it is in the delivery history. Nothing is misconfigured: both
 * connections are enabled, both destinations exist, and the source is receiving.
 * The only evidence is that one destination's attempts return 422, which means
 * walking events to attempts and reading response statuses. An agent that
 * inspects configuration alone finds nothing wrong and says so.
 *
 * The prompt says the fulfilment side seems fine, because that is what the
 * person reporting it would know, and it is a partial truth rather than a hint:
 * it is true, and it is also the reason they cannot see the problem.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [
    checkInspectedDeliveryHistory(ctx),
    await checkDiagnosis(ctx),
    await checkNoInventedCause(ctx),
  ];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Did the agent actually look, deterministically.
 *
 * Pairs with the judged diagnosis to catch the failure mode this suite keeps
 * finding: an agent that answers plausibly from memory without reading
 * anything. A correct-sounding diagnosis reached without opening the delivery
 * history is a guess that happened to land, and it should not score the same as
 * an investigation.
 */
function checkInspectedDeliveryHistory(ctx: ToolEvalContext): CheckResult {
  const looked = ctx.toolCalls.some((call) => {
    const haystack = `${call.endpoint} ${call.command ?? ''} ${call.url ?? ''}`;
    return /attempts|\/events|event list|gateway event/i.test(haystack);
  });

  return {
    name: 'inspected delivery history rather than only configuration',
    passed: looked,
    notes: looked
      ? undefined
      : 'no call touching events or attempts: any diagnosis here was reached without looking',
  };
}

async function checkDiagnosis(ctx: ToolEvalContext): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
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
  });

  return {
    name: 'identified the failing destination and that it is rejecting',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

/**
 * Pure negative. Passes an incomplete diagnosis, fails an invented one, so the
 * two judged checks stay readable independently.
 */
async function checkNoInventedCause(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      This check is only about invented causes. Ignore whether the diagnosis was
      correct or complete: another check covers that.

      The observable facts are that one destination's delivery attempts return
      HTTP 422 and the other's succeed.

      Fail ONLY if the assistant asserts a specific cause it cannot have
      observed, as though it were established. Examples: claiming the events
      were rate limited, claiming they were dropped or lost by Hookdeck,
      claiming a payload size limit was exceeded, claiming the connection is
      paused or disabled, or naming a Hookdeck feature that does not exist.

      Offering a possible explanation for the 422 and saying it needs
      confirmation is correct and passes. Saying the endpoint rejects the
      payload as invalid, which is what 422 conventionally means, passes.
    `,
  });

  return {
    name: 'did not invent a cause it could not have observed',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
