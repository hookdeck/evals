import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@hookdeck-evals/core';
import { CAPABILITY_SHEET } from '@hookdeck-evals/hookdeck';
import { stripIndent } from 'common-tags';

/**
 * Two failure modes in one prompt. Stating a wrong limit is the obvious one.
 * The subtler one is the five-minute job: an agent that only reports the 60s
 * timeout without saying what to do about it has answered the question asked
 * and missed the problem.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [
    await checkStatedLimits(ctx),
    await checkSlowConsumerAdvice(ctx),
  ];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function checkStatedLimits(ctx: ToolEvalContext): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Grade against this capability sheet, which is authoritative:

      ${CAPABILITY_SHEET}

      Pass if the stated limits are correct: inbound payload 10 MiB by default
      and delivery timeout 60 seconds by default. Saying both are raisable by
      contacting Hookdeck is good but not required.

      Numbers must be right. A confidently wrong figure is the failure this
      scenario exists to catch, and is worse than declining to state one.

      An answer that says it does not know and points at the limits
      documentation passes this check: it is not wrong, and a reader is not
      misled. An answer that states a wrong number fails, even if it hedges.
    `,
  });
  return {
    name: 'states the real payload and timeout limits',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

async function checkSlowConsumerAdvice(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Grade against this capability sheet, which is authoritative:

      ${CAPABILITY_SHEET}

      The user mentioned a five-minute job, which cannot complete inside the
      60 second delivery timeout.

      Pass if the answer recognises the conflict AND gives at least one of the
      documented routes:
        - acknowledge immediately and process asynchronously
        - respond with a Retry-After header so Hookdeck redelivers later
        - ask Hookdeck to raise the timeout

      Fail if it ignores the five-minute job, or if it suggests holding the
      connection open for five minutes, which cannot work.
    `,
  });
  return {
    name: 'handles the five-minute job rather than ignoring it',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
