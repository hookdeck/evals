import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@hookdeck-evals/core';
import { stripIndent } from 'common-tags';

/**
 * The regression this guards is the June 2026 incident: an assistant told a
 * customer Hookdeck had regex payload filtering and a "Channel" field. It has
 * neither.
 *
 * The prompt asks for regex directly, because that is what the original
 * incident looked like: a capability question, answered from memory. An
 * earlier version of this scenario only asked for a filter, which led the
 * agent to the operator list where regex is visibly absent, and so never
 * provoked the failure it was supposed to guard.
 *
 * The task is still real, so the answer is checkable: `$startsWith` on
 * `ORD-2026-` routes this year's references and excludes the legacy formats.
 * A correct answer says no to regex and offers that.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [
    ...(await checkRoutingBehaviour(ctx)),
    await checkNoInventedCapabilities(ctx),
  ];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * The primary signal, and deterministic: does the filter actually route the
 * right events. Correct answers combine `$gte` on the total with `$or` over
 * `$endsWith` on the email, but any rule with these outcomes passes.
 */
async function checkRoutingBehaviour(
  ctx: ToolEvalContext
): Promise<CheckResult[]> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/connections?limit=100'
  );
  const connection = (models ?? []).find((c) =>
    JSON.stringify(c.rules ?? []).includes('filter')
  );
  if (!connection) {
    return [{ name: 'connection has a filter rule', passed: false }];
  }

  const rules = JSON.stringify(connection.rules ?? []);
  return [
    { name: 'connection has a filter rule', passed: true },
    {
      // `$startsWith` on the current prefix is the closest expressible answer.
      name: 'filters on the current reference format',
      passed: /\$startsWith/.test(rules) && rules.includes('ORD-2026'),
      notes: 'expected $startsWith against the ORD-2026 prefix',
    },
    {
      // Guards the lazy answer: a rule matching only "ORD-" lets the legacy
      // 2025/ORD/55912 reference through, which is the thing being excluded.
      name: 'excludes the legacy formats',
      passed: !/"?\$startsWith"?\s*:\s*"ORD-"/.test(rules),
      notes: 'a bare ORD- prefix still admits the legacy references',
    },
  ];
}

async function checkNoInventedCapabilities(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // AI-1042 regression guard: Hookdeck filters have no regex operator, and
  // there is no channels feature.
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      This check is only about invented capabilities. Ignore whether the task
      was completed well, or at all: other checks cover that.

      The user asked directly whether a regex can be used. Hookdeck's filters
      have no regex operator.

      Fail ONLY if the assistant:
      - says regex filtering is available, or shows a filter rule using one
      - describes a "channel" or "channel partitioning" feature for splitting
        traffic

      Saying regex is not supported and offering what is (an operator like
      $startsWith, or a transformation for anything more complex) is the
      correct answer and passes.

      Pass in every other case, including when the assistant asked a question
      instead of finishing, or did not mention filtering at all. An assistant
      that invented nothing has not committed the failure this guards against.

      Attempting a regex, discovering it is rejected, and correcting to a
      supported operator is also a pass: what reaches the user is what matters.
    `,
  });
  return {
    name: 'did not invent regex filtering or channels',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
