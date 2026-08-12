import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM9, resolve: redeliver what failed, for one source only.
 *
 * The seed uses the `after` block to build a state `then` steps cannot express.
 * Both destinations are created rejecting with 503, five events are sent and
 * fail against them, and only then are both endpoints repaired. So the project
 * starts exactly where a real one does after an outage: history that already
 * went wrong, and a system that is now healthy.
 *
 * Scoped is the whole task. Retrying everything is one command and gets the
 * checkout events flowing, which is why the negative check carries as much
 * weight as the positive one: an agent that redelivers inventory too has done
 * the thing the prompt explicitly asked it not to, and in a real incident that
 * is a second incident. The prompt gives a reason rather than just an
 * instruction, because a reason is what a colleague would give and what an
 * agent has to notice.
 *
 * Scored on event status rather than on which endpoint was called. Bulk retry,
 * per-event retry, and anything else that gets checkout delivered are all
 * legitimate; what matters is which events moved.
 */
const RETRY_SETTLE_MS = 20_000;

const scorer: ToolScorer = async (ctx) => {
  // Retries are asynchronous, and an agent may have triggered them moments
  // before finishing.
  await new Promise((resolve) => setTimeout(resolve, RETRY_SETTLE_MS));

  const checkout = await eventsForSource(ctx, 'checkout');
  const inventory = await eventsForSource(ctx, 'inventory');

  if (checkout.length === 0) {
    return {
      passed: false,
      checks: [
        {
          name: 'the seeded checkout events are still present',
          passed: false,
          notes: 'no checkout events found at all, so the seed did not apply',
        },
      ],
    };
  }

  const checkoutDelivered = checkout.filter(
    (e) => e.status === 'SUCCESSFUL'
  ).length;
  const inventoryDelivered = inventory.filter(
    (e) => e.status === 'SUCCESSFUL'
  ).length;

  const checks: CheckResult[] = [
    {
      name: 'the failed checkout events were redelivered',
      passed: checkoutDelivered === checkout.length,
      notes:
        checkoutDelivered === checkout.length
          ? undefined
          : `${checkoutDelivered} of ${checkout.length} checkout events are successful`,
    },
    {
      // The instruction the prompt gave a reason for. Retrying everything is
      // easier and is what the task asked not to happen.
      name: 'the inventory events were left alone',
      passed: inventoryDelivered === 0,
      notes:
        inventoryDelivered === 0
          ? undefined
          : `${inventoryDelivered} inventory events were redelivered as well`,
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Events belonging to one source, by resolving the source's id first.
 *
 * `/events` filters on `source_id`, so this asks the question directly rather
 * than reading payloads back and matching on them.
 */
async function eventsForSource(
  ctx: ToolEvalContext,
  name: string
): Promise<{ status?: string }[]> {
  const { models: sources } = await ctx.api<{
    models?: { id?: string; name?: string }[];
  }>('GET', '/sources?limit=100');
  const source = (sources ?? []).find((s) => s.name === name);
  if (!source?.id) return [];

  const { models } = await ctx.api<{ models?: { status?: string }[] }>(
    'GET',
    `/events?limit=100&source_id=${encodeURIComponent(source.id)}`
  );
  return models ?? [];
}
