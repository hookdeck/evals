import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM11, agentic delivery: respect a published requests-per-minute ceiling.
 *
 * The mirror of BM10 and the reason both exist. Here the constraint really is
 * per unit of time, so `rate_limit_period` should be a time period and the
 * number should reflect sixty a minute. An agent that reaches for `concurrent`
 * here has made the opposite mistake to the one BM10 catches: concurrency says
 * nothing about requests per minute, so a fast endpoint with a low concurrency
 * cap still sails past its quota.
 *
 * Either period is accepted as long as the arithmetic holds, because sixty a
 * minute and one a second are the same ceiling and an agent may express it
 * either way. Asserting the unit rather than the rate would fail a correct
 * answer for choosing a different but equivalent form.
 */
const scorer: ToolScorer = async (ctx) => {
  const destination = await findDestination(ctx);
  const config = (destination?.config ?? {}) as {
    rate_limit?: number;
    rate_limit_period?: string;
  };

  const limit = config.rate_limit;
  const period = config.rate_limit_period;
  const perMinute =
    typeof limit !== 'number'
      ? undefined
      : period === 'minute'
        ? limit
        : period === 'second'
          ? limit * 60
          : period === 'hour'
            ? limit / 60
            : undefined;

  const checks: CheckResult[] = [
    {
      name: 'delivery to the endpoint is limited',
      passed: typeof limit === 'number',
      notes:
        typeof limit === 'number'
          ? undefined
          : 'no rate limit on the destination',
    },
    {
      name: 'the limit is over time rather than concurrency',
      passed: perMinute !== undefined,
      notes:
        perMinute !== undefined
          ? undefined
          : `rate_limit_period is ${String(period ?? 'unset')}: a concurrency cap does not bound requests per minute`,
    },
    {
      // 60/min expressed as 1/second is the same ceiling and passes.
      name: 'the limit works out at the endpoint quota',
      passed: perMinute !== undefined && perMinute <= 60 && perMinute >= 30,
      notes:
        perMinute === undefined
          ? undefined
          : `works out at ${perMinute} per minute against a quota of 60`,
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function findDestination(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/destinations?limit=100'
  );
  return (models ?? [])[0];
}
