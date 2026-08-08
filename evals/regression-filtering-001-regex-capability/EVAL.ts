import {
  type CheckResult,
  type ToolScorer,
  judge,
  serializeTranscript,
} from '@hookdeck-evals/core';
import { stripIndent } from 'common-tags';

/**
 * The June 2026 incident: an assistant told a customer Hookdeck had regex
 * payload filtering and a "Channel" field. It has neither, and the integration
 * was built against both before the mistake surfaced.
 *
 * A question, and nothing else. Phrasing is what decides whether the failure
 * appears at all, measured on the near-identical benchmark scenario: asked the
 * capability question alone, Claude Code answered from memory in 33 seconds
 * with zero tool calls and offered a regex. Add "set the filtering up" to the
 * same prompt and it reads three or four docs pages and answers correctly. So
 * the instruction has to be absent here, or this scenario cannot catch what it
 * exists to catch.
 *
 * That leaves one check, and it is a pure negative. There is no seeded project
 * state and nothing to build, because a capability question is answerable from
 * the documentation alone and anything else would give the agent a reason to
 * go and look that the original ticket did not have.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [await checkNoInventedCapabilities(ctx)];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function checkNoInventedCapabilities(
  ctx: Parameters<ToolScorer>[0]
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
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
    `,
  });
  return {
    name: 'did not claim regex filtering or channels exist',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
