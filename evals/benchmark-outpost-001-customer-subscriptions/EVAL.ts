import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';
import { waitForOrLast } from '@hookdeck-evals/hookdeck';

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
/** Polling ceiling, not a sleep. */
const DELIVERY_WAIT_MS = 45_000;

const scorer: ToolScorer = async (ctx) => {
  // `requires: [outpost]` in the frontmatter should have skipped this scenario
  // long before scoring, so reaching here means the gate is broken. Throw
  // rather than score: a scorer's only vocabulary is pass and fail, so asked
  // about an absent credential it can only answer with a lie, and the lie it
  // told on 13 August was six agent failures against named vendors.
  //
  // A missing row is recoverable. A wrong row is not.
  if (!ctx.outpost) {
    throw new Error(
      'OUTPOST_API_KEY is not set, so this scenario cannot be scored. It ' +
        'declares `requires: [outpost]` and should have been skipped by the ' +
        'harness; reaching the scorer means the requirement gate did not fire.'
    );
  }

  // A leftover `acme` used to satisfy every check here with no agent action.
  // This was the only Outpost scenario with no seed, and every other one seeds
  // a tenant called `acme` with a destination on an order-ish topic; tenant
  // cleanup runs on release inside a `catch`-and-ignore and is skipped when a
  // run is killed, both of which have happened. The row published green.
  //
  // The fix is in the seed — `deleteTenants: ["acme", "globex"]` — because the
  // state has to be *absent*, not merely distinguishable. Comparing the
  // tenant's `created_at` against the lease was tried first and does not work:
  // tenant create is idempotent, so an agent that correctly `PUT`s an existing
  // id gets the original timestamp back and is scored as having inherited
  // someone else's work. Measured on 24 August, the tenant read two minutes
  // older than the lease about to score it.
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

  // Successful attempts, not attempts.
  //
  // Counting any attempt made this check "Outpost tried", which is not what its
  // name claims. A destination pointed at a hostname the agent invented records
  // an attempt and fails to deliver, and the customer receives nothing. The
  // header of `outpost-004` asserts "delivery is already proven against webhook
  // destinations by outpost-001" — it was not.
  //
  // **This does not close the whole hole, and the remaining half is a scenario
  // problem rather than a scorer one.** The ticket never says where the
  // customer's endpoint is, so any reachable URL satisfies it: one agent stood
  // up a localtunnel *inside its own sandbox*, delivered to itself, passed, and
  // offered to "swap the temporary receiver URL for the real customer endpoint
  // next". That receiver died with the container. Fixing it means giving the
  // ticket an endpoint to deliver to, which changes a published scenario, so it
  // is called out here rather than done quietly.
  const before = await successCount(ctx, tenantId, destinations);
  await ctx.outpost?.('POST', '/publish', {
    tenant_id: tenantId,
    topic,
    data: { order_id: 'ord_scored', total: 4200, currency: 'GBP' },
  });
  // Publishing is accepted before the delivery is attempted, so poll the
  // attempt count rather than sleeping and reading once. A single positive
  // assertion, so the first observation that satisfies it is the answer.
  const after = await waitForOrLast(
    () => successCount(ctx, tenantId, destinations),
    (count) => count > before,
    {
      timeoutMs: DELIVERY_WAIT_MS,
      description: "a delivery attempt to the customer's destination",
    }
  );

  return {
    name,
    passed: after > before,
    notes:
      after > before
        ? undefined
        : `published to "${topic}" and no delivery was attempted to the customer's destination`,
  };
}

/**
 * The first topic on any destination that looks like it covers orders.
 *
 * Outpost's `Topics` schema (`reference` in `outpost/docs/apis/openapi.yaml`)
 * is `oneOf` a bare `"*"` string or an array of topic strings, and the API's
 * own example for listing destinations returns the wildcard as `["*"]` (an
 * array containing the string), not the bare string. Both forms mean
 * "subscribes to everything", so both must count as covering orders.
 */
function orderTopic(
  destinations: Record<string, unknown>[]
): string | undefined {
  for (const destination of destinations) {
    const topics = destination.topics;
    if (topics === '*') return 'orders.created';
    if (!Array.isArray(topics)) continue;
    if (topics.includes('*')) return 'orders.created';
    const match = topics.find((t) => /order/i.test(String(t)));
    if (match) return String(match);
  }
  return undefined;
}

/** Attempts that actually delivered. */
async function successCount(
  ctx: ToolEvalContext,
  tenantId: string,
  destinations: Record<string, unknown>[]
): Promise<number> {
  let total = 0;
  for (const destination of destinations) {
    const id = String(destination.id ?? '');
    if (!id) continue;
    const body = await ctx.outpost?.<
      { status?: string }[] | { models?: { status?: string }[] }
    >(
      'GET',
      `/tenants/${encodeURIComponent(tenantId)}/destinations/${encodeURIComponent(id)}/attempts`
    );
    const rows = Array.isArray(body) ? body : (body?.models ?? []);
    total += rows.filter((a) => a.status === 'success').length;
  }
  return total;
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
    // `/tenants/{id}/destinations/{id}/attempts` is an
    // `AttemptPaginatedResult`: `{ pagination, models }`, the same shape as
    // Hookdeck's own list endpoints. Not `{ data }`, which never matches and
    // silently counted every destination as having zero attempts.
    const body = await ctx.outpost?.<
      Record<string, unknown>[] | { models?: unknown[] }
    >(
      'GET',
      `/tenants/${encodeURIComponent(tenantId)}/destinations/${encodeURIComponent(id)}/attempts`
    );
    total += Array.isArray(body) ? body.length : (body?.models?.length ?? 0);
  }
  return total;
}

async function listTenants(
  ctx: ToolEvalContext
): Promise<Record<string, unknown>[]> {
  // `/tenants` is a `TenantPaginatedResult`: `{ pagination, count, models }`.
  // Not `{ data }` - that field never exists on this response, so this
  // always returned an empty list and every run failed at "created a tenant
  // for the customer" regardless of what the agent actually set up.
  const body = await ctx.outpost?.<
    Record<string, unknown>[] | { models?: Record<string, unknown>[] }
  >('GET', '/tenants');
  return Array.isArray(body) ? body : (body?.models ?? []);
}

async function listDestinations(
  ctx: ToolEvalContext,
  tenantId: string
): Promise<Record<string, unknown>[]> {
  // `models ?? data`, matching every sibling scorer and the client. This file
  // read `data` alone — the exact trap its own comments warn about twice, which
  // survives only because this endpoint happens to be unpaged and returns a
  // bare array. The day it gains an envelope, every agent is told the tenant
  // has nowhere to deliver to.
  const body = await ctx.outpost?.<
    | Record<string, unknown>[]
    | {
        models?: Record<string, unknown>[];
        data?: Record<string, unknown>[];
      }
  >('GET', `/tenants/${encodeURIComponent(tenantId)}/destinations`);
  return Array.isArray(body) ? body : (body?.models ?? body?.data ?? []);
}
