import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM12, Outpost: outbound webhooks so a customer can subscribe to your events.
 *
 * The first scenario against the other product, and the first to score a
 * different API. `ctx.outpost` is present only when `OUTPOST_API_KEY` is
 * configured, so on a machine without one this reports a skip rather than
 * failing inside a check.
 *
 * The model is the thing being tested. Outpost inverts the gateway: a tenant is
 * the customer, the tenant owns destinations, and events are published to
 * topics rather than routed from sources. An agent that carries Event Gateway
 * habits across builds a source and a connection and gets nowhere, which is a
 * plausible and specific wrong answer rather than a general failure to
 * understand.
 *
 * Scored on delivery rather than on the objects created. A tenant with a
 * destination that never receives anything is a configuration that looks
 * complete and does nothing, and that shape has been where every signal in this
 * suite has come from. The scorer publishes an order event itself, so an agent
 * that built the subscription correctly but demonstrated it badly still passes.
 */
const DELIVERY_WAIT_MS = 15_000;

const scorer: ToolScorer = async (ctx) => {
  if (!ctx.outpost) {
    return {
      passed: false,
      checks: [
        {
          name: 'an Outpost project is configured for this run',
          passed: false,
          notes:
            'OUTPOST_API_KEY is not set, so this scenario cannot be scored here',
        },
      ],
    };
  }

  const tenants = await listTenants(ctx);
  const tenant = tenants.find((t) => /acme/i.test(String(t.id ?? '')));

  if (!tenant?.id) {
    return {
      passed: false,
      checks: [
        {
          name: 'created a tenant for the customer',
          passed: false,
          notes: tenants.length
            ? `tenants exist (${tenants.map((t) => t.id).join(', ')}) but none is acme`
            : 'no tenants: nothing was set up for the customer to subscribe with',
        },
      ],
    };
  }

  const tenantId = String(tenant.id);
  const destinations = await listDestinations(ctx, tenantId);

  const checks: CheckResult[] = [
    { name: 'created a tenant for the customer', passed: true },
    {
      name: 'the customer has a destination to receive at',
      passed: destinations.length > 0,
      notes: destinations.length
        ? undefined
        : 'the tenant exists but has nowhere to deliver to',
    },
  ];

  if (destinations.length > 0) {
    checks.push(await checkOrderEventDelivered(ctx, tenantId, destinations));
  }

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Publish an order event and see whether it reaches the customer.
 *
 * The topic is read from what the agent built rather than assumed. "Order
 * events" is the requirement; `orders.created`, `order.placed` and `orders` are
 * all reasonable spellings, and asserting one would fail a correct setup for
 * choosing a different word.
 */
async function checkOrderEventDelivered(
  ctx: ToolEvalContext,
  tenantId: string,
  destinations: Record<string, unknown>[]
): Promise<CheckResult> {
  const name = 'an order event reaches the customer';
  const topic = orderTopic(destinations);
  if (!topic) {
    return {
      name,
      passed: false,
      notes:
        'no destination subscribes to anything resembling an order topic, so an order event has nowhere to go',
    };
  }

  const before = await attemptCount(ctx, tenantId, destinations);
  await ctx.outpost?.('POST', '/publish', {
    tenant_id: tenantId,
    topic,
    data: { order_id: 'ord_scored', total: 4200, currency: 'GBP' },
  });
  await new Promise((resolve) => setTimeout(resolve, DELIVERY_WAIT_MS));
  const after = await attemptCount(ctx, tenantId, destinations);

  return {
    name,
    passed: after > before,
    notes:
      after > before
        ? undefined
        : `published to "${topic}" and no delivery was attempted to the customer's destination`,
  };
}

/** The first topic on any destination that looks like it covers orders. */
function orderTopic(
  destinations: Record<string, unknown>[]
): string | undefined {
  for (const destination of destinations) {
    const topics = destination.topics;
    if (topics === '*') return 'orders.created';
    if (!Array.isArray(topics)) continue;
    const match = topics.find((t) => /order/i.test(String(t)));
    if (match) return String(match);
  }
  return undefined;
}

async function attemptCount(
  ctx: ToolEvalContext,
  tenantId: string,
  destinations: Record<string, unknown>[]
): Promise<number> {
  let total = 0;
  for (const destination of destinations) {
    const id = String(destination.id ?? '');
    if (!id) continue;
    const body = await ctx.outpost?.<
      Record<string, unknown>[] | { data?: unknown[] }
    >(
      'GET',
      `/tenants/${encodeURIComponent(tenantId)}/destinations/${encodeURIComponent(id)}/attempts`
    );
    total += Array.isArray(body) ? body.length : (body?.data?.length ?? 0);
  }
  return total;
}

async function listTenants(
  ctx: ToolEvalContext
): Promise<Record<string, unknown>[]> {
  const body = await ctx.outpost?.<
    Record<string, unknown>[] | { data?: Record<string, unknown>[] }
  >('GET', '/tenants');
  return Array.isArray(body) ? body : (body?.data ?? []);
}

async function listDestinations(
  ctx: ToolEvalContext,
  tenantId: string
): Promise<Record<string, unknown>[]> {
  const body = await ctx.outpost?.<
    Record<string, unknown>[] | { data?: Record<string, unknown>[] }
  >('GET', `/tenants/${encodeURIComponent(tenantId)}/destinations`);
  return Array.isArray(body) ? body : (body?.data ?? []);
}
