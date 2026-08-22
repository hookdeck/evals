import type { ToolEvalContext } from '@hookdeck-evals/core';

/**
 * What a correct agent leaves behind: acme's destination subscribed to the two
 * topics they still want, and nothing else touched.
 *
 * The single line worth reading is the topic list. Writing
 * `['order.created']` — the topic the ticket talks about — satisfies the
 * complaint and silently drops `order.shipped`, which is the failure this
 * scenario exists to catch. Getting it right means noticing what the customer
 * was receiving *before*, rather than what they wrote to you about.
 */

const TENANT = 'acme';
const OLD_ENDPOINT = 'https://mock.hookdeck.com/api/v1/acme/orders';

interface Destination {
  id?: string;
  config?: Record<string, unknown>;
}

export default async function solve(ctx: ToolEvalContext): Promise<void> {
  const outpost = ctx.outpost;
  if (!outpost) {
    throw new Error(
      'no Outpost client: this solution cannot be applied without OUTPOST_API_KEY'
    );
  }

  const rows = await outpost<Destination[] | { models?: Destination[] }>(
    'GET',
    `/tenants/${TENANT}/destinations`
  );
  const destinations = Array.isArray(rows) ? rows : (rows.models ?? []);

  for (const destination of destinations) {
    if (destination.config?.url !== OLD_ENDPOINT || !destination.id) continue;
    await outpost(
      'PATCH',
      `/tenants/${TENANT}/destinations/${destination.id}`,
      {
        // Everything they had, minus the one they asked to stop.
        topics: ['order.created', 'order.shipped'],
      }
    );
  }
}
