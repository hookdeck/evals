import type { ToolEvalContext } from '@hookdeck-evals/core';

/**
 * What a correct agent leaves behind: a tenant for the customer, a destination
 * subscribed to order events, and a delivery that actually arrives.
 *
 * Added late, and for a specific reason. This scenario had no solution, so
 * `score-only` could only ever exercise its failing path — which is how it kept
 * a check that passed on a *leftover* tenant and another that counted a
 * delivery *attempt* rather than a delivery. Both were repaired on 24 August,
 * and the repair for the first compares the tenant's `created_at` against the
 * lease. That comparison is worth testing before trusting: clock skew between
 * this machine and Outpost would reject a tenant an agent had just made.
 */

const TENANT = 'acme';

export default async function solve(ctx: ToolEvalContext): Promise<void> {
  const outpost = ctx.outpost;
  if (!outpost) {
    throw new Error(
      'no Outpost client: this solution cannot be applied without OUTPOST_API_KEY'
    );
  }

  await outpost('PUT', `/tenants/${TENANT}`, {});

  await outpost('POST', `/tenants/${TENANT}/destinations`, {
    type: 'webhook',
    topics: ['order.created'],
    // A reachable endpoint, because the check requires the event to arrive
    // rather than merely to be attempted.
    config: { url: 'https://mock.hookdeck.com/api/v1/acme/orders' },
  });
}
