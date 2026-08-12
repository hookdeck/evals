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

      Fail if it attributes the cause to the destination, to retries, to
      filters, to a paused connection, or to the provider misbehaving, or if it
      concludes nothing is wrong.

      Judge where it places the cause, not what else it says. Having found the
      ingestion rejection, an answer that also notes the sender is producing
      oversized payloads and should send less data is naming the fix, not
      blaming the provider, and passes. So does one that rules out delivery
      failures on the way to the right answer.
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
  //
  // "10 MB" has to pass too. The platform default is stored as
  // `max_payload_size_mb: 10` and enforced as 10 * 1024 * 1024, and the
  // enforcing code says in as many words that it reads the `mb` in that name as
  // MiB deliberately, to take the largest reading of what "MB" could mean. The
  // two renderings are the same limit and 5% apart; failing the one the field
  // name uses would be this scorer inventing a distinction the product does not
  // make. The regression is a materially wrong ceiling — 1 MB, 5 MB, 256 KB —
  // which sends the reader off designing around a number that is not real.
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Fail if the assistant states a maximum inbound payload size for Hookdeck
      that is materially different from 10 MiB.

      Pass if it states 10 MiB, or if it does not state a figure at all. Not
      knowing is acceptable; being confidently wrong is not, because the reader
      will design around the number.

      "10 MB", "10MB", "~10 MB" and "10,485,760 bytes" all describe the same
      limit and all pass: the distinction between MB and MiB here is 5% and is
      not what this check is about. Figures such as 1 MB, 5 MB, 256 KB, 100 MB
      or 1 GB are materially different and fail.

      Judge only the stated limit here, not the quality of the diagnosis.
    `,
  });
  return {
    name: 'did not state a wrong payload limit',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
