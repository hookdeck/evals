import type { ToolEvalContext } from '@hookdeck-evals/core';

/**
 * What a correct agent leaves behind.
 *
 * One call. The difficulty in this scenario is not the doing, it is finding
 * that `/operator-events/destinations` exists at all — it is in neither
 * published spec nor the API reference (hookdeck/evals#34). That asymmetry is
 * the point: a solution this short, against a task we expect agents to fail, is
 * evidence about the documentation rather than about the models.
 */
export default async function solve(ctx: ToolEvalContext): Promise<void> {
  const outpost = ctx.outpost;
  if (!outpost) {
    throw new Error(
      'no Outpost client: this solution cannot be applied without OUTPOST_API_KEY'
    );
  }

  await outpost('POST', '/operator-events/destinations', {
    type: 'webhook',
    // Both topics the prompt asks about, named rather than `*`. The scorer
    // accepts either; naming them keeps the solution readable as an answer to
    // the question that was asked.
    topics: [
      'alert.destination.disabled',
      'alert.destination.consecutive_failure',
    ],
    config: { url: 'https://mock.hookdeck.com/operator-alerts' },
  });
}
