import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';
import { waitForSettled } from '@hookdeck-evals/hookdeck';

/**
 * BM2, filtering plus retries: only high-value orders reach manual review, and
 * failed deliveries keep trying.
 *
 * Written so the agent can finish confidently and be wrong, which is the only
 * shape that has produced signal. A filter is a single expression and every
 * plausible version of it looks correct in the dashboard. The one that matters
 * is the boundary: "above £500" excludes 500 and includes 501, and a rule built
 * with the wrong comparison silently drops or admits one class of order. Nothing
 * about the resulting configuration reads as broken.
 *
 * Scored by sending orders either side of the boundary and seeing which arrive,
 * so an agent that reaches a working filter by an operator we did not anticipate
 * passes, and a rule that looks right and routes wrongly fails. 500 itself is
 * deliberately not asserted: "above" is unambiguous at 499 and 501 and arguable
 * at exactly 500, and a scenario should not turn on a reading of its own prompt.
 *
 * The retry rule is checked structurally rather than by observing retries. A
 * real retry cycle takes longer than a run, and the failure this guards against
 * is forgetting the second half of the request entirely.
 */
/** Polling ceiling, not a sleep. */
const INGEST_WAIT_MS = 45_000;
/** Time the below-boundary order is given to arrive before its absence counts
 *  as the filter working. Both are posted back to back. */
const FILTER_SETTLE_MS = 10_000;

const scorer: ToolScorer = async (ctx) => {
  const source = await findSource(ctx);
  if (!source?.url) {
    return {
      passed: false,
      checks: [{ name: 'the orders source still exists', passed: false }],
    };
  }

  const routed = await probeBoundary(ctx, String(source.url));
  const connection = await findConnection(ctx);
  const rules = (connection?.rules ?? []) as { type?: string }[];

  const checks: CheckResult[] = [
    {
      name: 'an order above the threshold reaches manual review',
      passed: routed.high,
      notes: routed.high
        ? undefined
        : 'a £501 order did not arrive: the filter excludes orders it should admit',
    },
    {
      name: 'an order below the threshold does not reach manual review',
      passed: !routed.low,
      notes: routed.low
        ? 'a £499 order arrived: the filter admits orders it should exclude'
        : undefined,
    },
    {
      name: 'failed deliveries are retried',
      passed: rules.some((r) => r.type === 'retry'),
      notes: rules.some((r) => r.type === 'retry')
        ? undefined
        : 'no retry rule on the connection, so a failed delivery is given up on',
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Send one order either side of the threshold and report which routed.
 *
 * Both carry a reference unique to this run, because the project is shared and
 * an earlier run's orders would otherwise answer for this one.
 */
async function probeBoundary(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<{ high: boolean; low: boolean }> {
  const stamp = ctx.acquiredAt.getTime();
  const high = `ORD-HIGH-${stamp}`;
  const low = `ORD-LOW-${stamp}`;

  await post(sourceUrl, { reference: high, total: 501 });
  await post(sourceUrl, { reference: low, total: 499 });

  // The boundary is the measurement, and the two orders fail in opposite
  // directions: reading early makes a working filter look like it dropped the
  // high-value order, and makes a filter that does nothing look correct
  // because the low-value one has not landed yet. Wait for the order that is
  // supposed to arrive, then hold long enough for the other to disprove it.
  return waitForSettled(
    async () => ({
      high: await arrived(ctx, high),
      low: await arrived(ctx, low),
    }),
    (seen) => seen.high,
    {
      timeoutMs: INGEST_WAIT_MS,
      settleMs: FILTER_SETTLE_MS,
      description: 'the above-boundary order to route',
    }
  );
}

async function arrived(
  ctx: ToolEvalContext,
  reference: string
): Promise<boolean> {
  // `include=data` is required: without it the list response omits the payload
  // and a search on the reference silently finds nothing.
  const { models } = await ctx.api<{ models?: unknown[] }>(
    'GET',
    `/events?limit=20&include=data&search_term=${encodeURIComponent(reference)}`
  );
  return (models ?? []).length > 0;
}

async function post(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function findConnection(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/connections?limit=100'
  );
  return (models ?? [])[0];
}

async function findSource(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/sources?limit=100'
  );
  return (models ?? [])[0];
}
