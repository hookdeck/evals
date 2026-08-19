import type { ToolScoringContext } from '@hookdeck-evals/core';
import { setConnectionRules } from '@hookdeck-evals/hookdeck';

/**
 * A correct answer to this scenario, applied by `score-only` so the scorer can
 * be exercised against the state a good agent would have left.
 *
 * Not a reference answer for agents, and not what the scenario measures. It
 * exists so the *scorer* can be checked on the path that matters: with nothing
 * applied the scenario fails every iteration, which only tests how the scorer
 * behaves when there is nothing to find.
 *
 * A paired assertion, so it carries the false-*pass* risk `waitForSettled`
 * introduces: reading before the below-boundary order has had a chance to arrive
 * makes a filter that does nothing look correct. Only a working filter can
 * expose that, which is what this is for.
 */
export default async function apply(ctx: ToolScoringContext): Promise<void> {
  // `setConnectionRules` resolves the connection by name and does not return
  // until the rules read back, because the scorer starts sending traffic the
  // moment this does.
  // The canary the rule must reject, sent repeatedly until it is rejected
  // consistently. A filter is readable before it is enforced and enforcement
  // alternates while it propagates, so neither the write nor a read-back nor a
  // single rejection means the scorer can safely start probing. See #25.
  const { models: sources } = await ctx.api<{ models?: { url?: string }[] }>(
    'GET',
    '/sources?limit=100'
  );
  const sourceUrl = String((sources ?? [])[0]?.url ?? '');
  let tag = '';

  await setConnectionRules(
    ctx,
    'orders-to-review',
    [
      {
        type: 'filter',
        // `$gt`, not `$gte`. The boundary is the whole point of the scenario:
        // "above £500" excludes 500 and includes 501, and the scorer probes at
        // 499 and 501. A solution built with the wrong comparison would look
        // correct in the dashboard and make the scorer appear broken.
        body: { total: { $gt: 500 } },
      },
      {
        // The prompt's second half. The scorer checks this structurally rather
        // than by observing retries, because a real retry cycle outlasts a run.
        type: 'retry',
        strategy: 'exponential',
        count: 5,
        interval: 60_000,
      },
    ],
    {
      send: async () => {
        // Unique per attempt, so a later lookup cannot match an earlier canary.
        tag = `ORD-LOW-CANARY-${Date.now()}`;
        await fetch(sourceUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference: tag, total: 1 }),
        });
        // Ingestion is asynchronous; give the canary time to appear if it is
        // going to. Absence checked too early would read as enforcement.
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      },
      rejected: async () => {
        const { models } = await ctx.api<{ models?: unknown[] }>(
          'GET',
          `/events?limit=10&include=data&search_term=${encodeURIComponent(tag)}`
        );
        return (models ?? []).length === 0;
      },
    }
  );
}
