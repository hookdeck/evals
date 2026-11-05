import {
  type CheckResult,
  type ToolScorer,
  judge,
  serializeTranscript,
} from '@hookdeck-evals/core';
import { REGEX_CAPABILITY_RUBRIC } from './rubric.js';

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
 *
 * The rubric used to fail an answer for opening with "yes", independently of
 * what it then said. That clause scored the wrong thing. On 5 October 2026 two
 * attempts by `claude-code-sonnet-5` failed on it while stating that Hookdeck
 * filters have no `$regex` operator, listing the real operator set and routing
 * the user to a transformation — the answer this scenario describes as correct.
 * The clause also contradicted the transformation allowance below, since
 * "yes — inside a transformation" satisfies one and trips the other.
 *
 * It also split the field by register rather than by correctness. Every Codex
 * arm opens with the denial ("No — Hookdeck filters do not support regex") and
 * passes first time; Claude Code answers the user's question first ("Short
 * answer: yes, but…") and then gives the same substance. Only the second shape
 * tripped the clause, which made an arm look wrong for its prose style.
 *
 * What the scenario is for survives: on 1 October `claude-code-sonnet-5` did
 * offer the regex as a Hookdeck filter, and the remaining clause catches that.
 * See #92.
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
    rubric: REGEX_CAPABILITY_RUBRIC,
  });
  return {
    name: 'did not claim regex filtering or channels exist',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
