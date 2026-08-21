import type { ToolEvalContext } from '@hookdeck-evals/core';

/**
 * What a correct agent leaves behind.
 *
 * Two changes, and the second is the one worth reading: the webhook destination
 * is *narrowed* to the topics acme did not ask to move, rather than deleted.
 * Deleting it is the obvious way to stop sending orders there and takes their
 * retry notifications with it.
 */

const TENANT = 'acme';
const QUEUE_URL =
  'https://sqs.eu-west-1.amazonaws.com/402319887654/acme-order-events';
const OLD_ENDPOINT = 'https://mock.hookdeck.com/api/v1/acme/orders';

interface Destination {
  id?: string;
  config?: Record<string, unknown>;
  topics?: string[];
}

export default async function solve(ctx: ToolEvalContext): Promise<void> {
  const outpost = ctx.outpost;
  if (!outpost) {
    throw new Error(
      'no Outpost client: this solution cannot be applied without OUTPOST_API_KEY'
    );
  }

  await outpost('POST', `/tenants/${TENANT}/destinations`, {
    type: 'aws_sqs',
    topics: ['orders'],
    // The queue URL is config; the key pair is credentials. Keeping them
    // separate is the whole shape difference between this and a webhook.
    config: { queue_url: QUEUE_URL },
    credentials: {
      key: 'AKIAIOSFODNN7EXAMPLE',
      secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
  });

  const rows = await outpost<Destination[] | { models?: Destination[] }>(
    'GET',
    `/tenants/${TENANT}/destinations`
  );
  const destinations = Array.isArray(rows) ? rows : (rows.models ?? []);

  for (const destination of destinations) {
    if (destination.config?.url !== OLD_ENDPOINT || !destination.id) continue;
    const remaining = (destination.topics ?? []).filter((t) => t !== 'orders');
    await outpost(
      'PATCH',
      `/tenants/${TENANT}/destinations/${destination.id}`,
      {
        topics: remaining,
      }
    );
  }
}
