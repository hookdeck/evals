import type { ToolScoringContext } from '@hookdeck-evals/core';

/**
 * A correct answer to this scenario, applied by `score-only` so the scorer can
 * be exercised against the state a good agent would have left.
 *
 * Not a reference answer for agents, and not what the scenario measures.
 *
 * The most valuable of the four paired assertions to test. Here the negative —
 * inventory must be left alone — is the point of the task rather than a guard on
 * it, and `waitForSettled` returning before a redelivered inventory event has
 * landed would score an over-broad redelivery as correctly scoped. That is the
 * exact failure the scenario exists to catch, so a scorer that can miss it is
 * worse than no scenario.
 *
 * The seed's `after` block repairs both destinations, and Hookdeck's own retry
 * rule then redelivers everything with no agent involved — which is how a first
 * run passed while the agent asked a clarifying question and did nothing. This
 * solution therefore has to do something the automatic retry does not: redeliver
 * checkout *specifically*, and leave inventory where it is.
 */
export default async function apply(ctx: ToolScoringContext): Promise<void> {
  const { models: sources } = await ctx.api<{
    models?: { id?: string; name?: string }[];
  }>('GET', '/sources?limit=100');

  const checkout = (sources ?? []).find((s) => s.name === 'checkout');
  if (!checkout?.id) {
    throw new Error(
      'no checkout source: the seed did not apply, so applying a solution on ' +
        'top of it would be meaningless'
    );
  }

  const { models: events } = await ctx.api<{
    models?: { id?: string; status?: string }[];
  }>(
    'GET',
    `/events?limit=100&source_id=${encodeURIComponent(checkout.id)}&status=FAILED`
  );

  const failed = (events ?? []).filter((e) => e.id);
  if (failed.length === 0) return;

  // One at a time, scoped by id, rather than a bulk retry filtered by source.
  // Both are legitimate answers and the scorer accepts either — it reads
  // delivery outcomes rather than how they were reached. Per-event is used here
  // because it cannot accidentally widen: a bulk filter that was wrong would
  // redeliver inventory too, and this file would then be manufacturing the
  // failure it is meant to detect.
  for (const event of failed) {
    await ctx.api('POST', `/events/${event.id}/retry`, {});
  }
}
