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
 * This one earns its place twice over. It is a paired assertion — one reference
 * must route and the other must not — so `waitForSettled` can return a false
 * *pass* here if the legacy reference lands after the settle window closes.
 * That failure is invisible without a working filter to test against, and it is
 * worse than the fixed sleep it replaced, because a rule that does nothing would
 * score green.
 *
 * Only the filter is configured. The scenario's other check is a judged
 * negative about invented capabilities, which has no configuration to set and is
 * unaffected by anything here.
 */
export default async function apply(ctx: ToolScoringContext): Promise<void> {
  // `setConnectionRules` resolves the connection by name and does not return
  // until the rules read back, because the scorer starts sending traffic the
  // moment this does.
  await setConnectionRules(ctx, 'orders-to-fulfilment', [
    {
      type: 'filter',
      // `$startsWith` on the current prefix. The scenario exists partly because
      // Hookdeck has no regex operator and an agent reaching for one is wrong;
      // this is the supported operator that does the job.
      body: { reference: { $startsWith: 'ORD-2026-' } },
    },
  ]);
}
