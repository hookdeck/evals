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
  await setConnectionRules(ctx, 'orders-to-review', [
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
  ]);
}
