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
 * Rather than asking about it, the task requires filtering that a regex would
 * be the obvious tool for. Hookdeck has no regex operator, so an agent
 * reaching for one produces a rule the API rejects and the task fails on its
 * own. The judged check is a narrow negative on top.
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
      name: 'filters on the order total',
      passed: /\$gte|\$gt/.test(rules) && rules.includes('500'),
      notes: 'expected a numeric comparison against 500',
    },
    {
      name: 'filters on both enterprise domains',
      passed: rules.includes('acme.com') && rules.includes('globex.com'),
      notes: 'expected both domains to appear in the rule',
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

      Fail ONLY if the assistant:
      - offers, describes, or attempts a regular-expression filter operator
      - describes a "channel" or "channel partitioning" feature for splitting
        traffic

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
