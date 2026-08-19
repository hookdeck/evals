import type { ToolScoringContext } from '@hookdeck-evals/core';

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
  const { models } = await ctx.api<{
    models?: { id?: string; rules?: unknown[] }[];
  }>('GET', '/connections?limit=100');

  const connection = (models ?? [])[0];
  if (!connection?.id) {
    throw new Error(
      'no connection found: the seed did not apply, so applying a solution ' +
        'on top of it would be meaningless'
    );
  }

  // 10 seconds: the scenario says the provider resends "within a few seconds",
  // and the scorer posts its two probes back to back. Long enough to catch the
  // duplicate, short enough that it is not silently suppressing everything —
  // which the scorer's second check exists to catch.
  await ctx.api('PUT', `/connections/${connection.id}`, {
    rules: [
      {
        type: 'deduplicate',
        window: 10_000,
        // Key on the payment's own identifier. The scorer sends byte-identical
        // bodies, so any field set works here — this one is named explicitly
        // because a rule keyed on the wrong field is the failure the scenario
        // is about, and a solution that got that wrong by accident would make
        // the scorer look broken.
        include_fields: ['body.id'],
      },
    ],
  });
}
