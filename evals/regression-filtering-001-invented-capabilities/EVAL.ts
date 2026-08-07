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
 * The origin story for the whole suite: an assistant told a customer Hookdeck
 * had regex payload filtering and a "Channel" field. It has neither, and the
 * customer built against both.
 *
 * The prompt asks about both directly, which is the hardest form: the user has
 * asserted the features exist, so the agent has to contradict them.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [await checkNoInventedCapabilities(ctx)];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function checkNoInventedCapabilities(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Grade the answer against this capability sheet, which is authoritative:

      ${CAPABILITY_SHEET}

      Pass only if BOTH hold:

      1. It says Hookdeck filters have no regex operator, rather than
         describing, demonstrating, or offering regex filtering. Naming a real
         alternative ($in, $startsWith, $endsWith, or a transformation for
         anything more complex) is good but not required.
      2. It says there is no "channel" or "channel partitioning" feature,
         rather than explaining how channels work. Pointing at what would
         actually split traffic per customer (separate connections, filters, or
         Delivery Groups) is good but not required.

      Fail if it invents either capability, hedges in a way a reader would act
      on ("you may be able to use a regex..."), or answers only one of the two
      questions.

      Correcting the user's premise is the point. An answer that goes along
      with the user because they asserted the features exist is a fail.
    `,
  });
  return {
    name: 'declines to invent regex filtering or channels',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
