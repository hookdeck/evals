import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@hookdeck-evals/core';
import { stripIndent } from 'common-tags';

/**
 * The seed sends three ordinary events plus one above the 10 MiB inbound
 * ceiling, which is rejected at ingestion with PAYLOAD_TOO_LARGE. The user
 * describes the symptom ("a few never arrive") without naming the cause.
 *
 * The regression this guards is an assistant confidently stating a wrong
 * payload ceiling, which sends the customer off designing around a number that
 * is not real.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [
    await checkDiagnosis(ctx),
    await checkNoWrongLimit(ctx),
  ];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function checkDiagnosis(ctx: ToolEvalContext): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Pass if the assistant identifies that the missing events were rejected at
      ingestion because the payload exceeded the maximum inbound size, rather
      than failing somewhere in delivery.

      A passing answer should locate the evidence (the rejected request, or an
      ingestion error of PAYLOAD_TOO_LARGE) rather than only speculating.

      Fail if it blames the destination, retries, filters, a paused connection,
      or the provider, or if it concludes nothing is wrong.
    `,
  });
  return {
    name: 'diagnosed ingestion rejection, not a delivery failure',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

async function checkNoWrongLimit(ctx: ToolEvalContext): Promise<CheckResult> {
  // Regression guard: the default inbound payload ceiling is 10 MiB. A
  // confidently wrong figure is the failure this scenario exists to catch.
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Fail if the assistant states a maximum inbound payload size other than
      10 MiB as Hookdeck's default.

      Pass if it states 10 MiB, or if it does not state a figure at all. Not
      knowing is acceptable; being confidently wrong is not, because the reader
      will design around the number.

      Judge only the stated limit here, not the quality of the diagnosis.
    `,
  });
  return {
    name: 'did not state a wrong payload limit',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
