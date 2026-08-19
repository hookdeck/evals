import type { ToolScoringContext } from '@hookdeck-evals/core';
import { setConnectionRules } from '@hookdeck-evals/hookdeck';

/**
 * A correct answer to this scenario, applied by `score-only` so the scorer can
 * be exercised against the state a good agent would have left.
 *
 * This is not what the scenario tests and it is not a reference answer for
 * agents. It exists so the *scorer* can be checked on the path that matters:
 * with no solution applied the scenario fails every time, which only ever tests
 * how the scorer behaves when there is nothing to find. The ingestion race this
 * repository spent a week chasing produced false *failures* against correct
 * configurations, so the correct configuration is the only state that can
 * reproduce it.
 *
 * It matters most here. `dedupe-001` is one of four scenarios asserting that
 * one thing routed and another did not, and `waitForSettled` can return a false
 * *pass* if the duplicate lands after the settle window closes — a worse
 * failure than the fixed sleep it replaced, and one that only a correct
 * configuration can expose.
 *
 * Deliberately minimal, and deliberately not the only correct answer. The
 * scorer asserts behaviour rather than shape, so an agent reaching the same
 * outcome another way passes; this just has to be *a* configuration that works.
 */
export default async function apply(ctx: ToolScoringContext): Promise<void> {
  // `setConnectionRules` resolves the connection by name and does not return
  // until the rules read back, because the scorer starts sending traffic the
  // moment this does.
  await setConnectionRules(ctx, 'payments-to-ledger', [
    {
      type: 'deduplicate',
      window: 10_000,
      // Key on the payment's own identifier. The scorer sends byte-identical
      // bodies, so any field set works here — this one is named explicitly
      // because a rule keyed on the wrong field is the failure the scenario is
      // about, and a solution that got that wrong by accident would make the
      // scorer look broken.
      include_fields: ['body.id'],
    },
  ]);
}
