import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM10, agentic delivery: a consumer that is slow rather than broken.
 *
 * Ninety seconds a job and two at a time is the shape of most AI workloads, and
 * it breaks assumptions written for endpoints that answer in milliseconds. The
 * answer is a concurrency ceiling on the destination: `rate_limit` with
 * `rate_limit_period: "concurrent"` caps deliveries in flight rather than
 * deliveries per unit of time, so a slow consumer is never handed more than it
 * can hold.
 *
 * The plausible wrong answer is a time-based limit. "Two at a time" translated
 * into some number per minute looks equivalent and is not: it says nothing
 * about how many are in flight, so a burst still buries a consumer that takes
 * a minute and a half to answer. That distinction is the entire scenario, and
 * it is why this is scored on the period rather than only on a limit existing.
 *
 * Scored as configuration. Observing pacing would mean holding a run open for
 * several minutes of real deliveries against a consumer we would have to build,
 * and the config is unambiguous about which behaviour was chosen.
 */
const scorer: ToolScorer = async (ctx) => {
  const destination = await findDestination(ctx);
  const config = (destination?.config ?? {}) as {
    rate_limit?: number;
    rate_limit_period?: string;
  };

  const hasLimit = typeof config.rate_limit === 'number';
  const isConcurrent = config.rate_limit_period === 'concurrent';

  const checks: CheckResult[] = [
    {
      name: 'delivery to the worker is limited',
      passed: hasLimit,
      notes: hasLimit
        ? undefined
        : 'no rate limit on the destination, so a spike is delivered as fast as it arrives',
    },
    {
      name: 'the limit caps concurrent deliveries rather than a rate over time',
      passed: isConcurrent,
      notes: isConcurrent
        ? undefined
        : `rate_limit_period is ${String(config.rate_limit_period ?? 'unset')}: a per-unit-time limit does not bound how many jobs are in flight at once`,
    },
    {
      name: 'the concurrency ceiling matches what the worker can hold',
      passed: isConcurrent && config.rate_limit === 2,
      notes:
        config.rate_limit === 2
          ? undefined
          : `expected 2 concurrent, got ${String(config.rate_limit ?? 'none')}`,
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
