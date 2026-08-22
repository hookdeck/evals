import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';
import { waitForSettled } from '@hookdeck-evals/hookdeck';

/**
 * Narrow one customer's slice of the event stream without narrowing it too far.
 *
 * Written after a 24-cell run in which the four existing Outpost scenarios were
 * passed by almost everything — `+skills` went 12/12 — because their difficulty
 * had quietly been "work out that Outpost is the product", and the harness
 * stopped withholding that. What was left was mostly setup, and setup is not
 * where agents fail.
 *
 * So this is built around the shape AGENTS.md says actually discriminates: an
 * agent can finish, report success, and be wrong, with nothing erroring. Acme
 * receives three topics and wants one of them stopped. The obvious fix — set
 * their destination to the topic they still talk about — passes the check they
 * complained about and silently stops `order.shipped`, which they never
 * mentioned because it was working. Nobody sees an error. The customer notices
 * days later, when something they depend on has quietly stopped arriving.
 *
 * That is the same failure mode as `resolve-002` and `alerting-001`: acting more
 * broadly than asked. The difference is that here it is the *cheapest* way to
 * satisfy the request, rather than a mistake you have to reach for.
 *
 * Scored on behaviour, not configuration. A destination's `topics` array can be
 * right while delivery is wrong — a tenant's own topic list gates it too, and an
 * agent that edits the tenant instead of the destination reaches the same end
 * state by another route. So this publishes real events and checks what
 * arrives, which passes any correct route and fails any incorrect one.
 */

const ACME = 'acme';
const GLOBEX = 'globex';

/** Still wanted. Named in the ticket only as "everything else". */
const KEPT = 'order.created';
/** Still wanted, and never mentioned — the one a too-narrow fix removes. */
const UNMENTIONED = 'order.shipped';
/** The topic they asked us to stop. */
const UNWANTED = 'order.cancelled';

/** Long enough that "it did not arrive" means it is not coming. */
const DELIVERY_WAIT_MS = 45_000;
const SETTLE_MS = 8_000;

interface Attempt {
  id?: string;
  status?: string;
  event_id?: string;
}

interface Destination {
  id?: string;
  disabled_at?: string | null;
}

const scorer: ToolScorer = async (ctx) => {
  if (!ctx.outpost) {
    throw new Error(
      'no Outpost client, but this scenario declares `requires: [outpost]` ' +
        'and should have been skipped rather than scored'
    );
  }

  // Published together, then read once after they have all had time to land.
  // Sending the positives and the negative separately would let a slow negative
  // arrive after its own check had already passed.
  const before = await attemptCount(ctx, ACME);
  const globexBefore = await attemptCount(ctx, GLOBEX);

  await publish(ctx, ACME, KEPT);
  await publish(ctx, ACME, UNMENTIONED);
  await publish(ctx, ACME, UNWANTED);
  await publish(ctx, GLOBEX, UNWANTED);

  // Two must arrive and one must not, so the positives starting the clock is
  // what gives the negative its chance to be wrong. Reading the moment the
  // positives land would pass a configuration that changed nothing at all.
  const acme = await waitForSettled(
    () => deliveredTopics(ctx, ACME),
    (topics) => topics.has(KEPT) && topics.has(UNMENTIONED),
    {
      timeoutMs: DELIVERY_WAIT_MS,
      settleMs: SETTLE_MS,
      description: "acme's remaining topics to be delivered",
    }
  );

  const globex = await waitForSettled(
    () => deliveredTopics(ctx, GLOBEX),
    (topics) => topics.has(UNWANTED),
    {
      timeoutMs: DELIVERY_WAIT_MS,
      settleMs: SETTLE_MS,
      description: "globex's delivery to be unaffected",
    }
  );

  const checks: CheckResult[] = [
    {
      name: 'acme no longer receives order cancellations',
      passed: !acme.has(UNWANTED),
      notes: acme.has(UNWANTED)
        ? 'a cancellation was still delivered to acme, which is what they asked us to stop'
        : undefined,
    },
    {
      // The check the scenario exists for.
      name: 'acme still receives the shipping events they depend on',
      passed: acme.has(UNMENTIONED),
      notes: acme.has(UNMENTIONED)
        ? undefined
        : `${UNMENTIONED} stopped reaching acme. They asked us to stop cancellations ` +
          'and said everything else should carry on; this is the part they did not ' +
          'mention because it was working, and nothing here would have errored',
    },
    {
      name: 'acme still receives new orders',
      passed: acme.has(KEPT),
      notes: acme.has(KEPT)
        ? undefined
        : `${KEPT} stopped reaching acme, so the change went far wider than the request`,
    },
    {
      name: 'globex was left alone',
      passed: globex.has(UNWANTED),
      notes: globex.has(UNWANTED)
        ? undefined
        : 'globex stopped receiving cancellations too — a change made at the wrong ' +
          'level hits every customer, and they never complained about anything',
    },
    await checkNothingDisabled(ctx),
  ];

  // Sanity, not a check: if the tenant received nothing at all, the failures
  // above are about the harness rather than the agent.
  if (acme.size === 0 && (await attemptCount(ctx, ACME)) === before) {
    throw new Error(
      'no delivery attempts on acme at all after publishing: the seed or the ' +
        'platform is at fault, not the agent, so this run is not scoreable'
    );
  }
  void globexBefore;

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Disabling a destination stops the unwanted topic as effectively as scoping it
 * — and stops everything else too. It is caught by the delivery checks above,
 * but naming it separately makes a red cell say *which* wrong route was taken.
 */
async function checkNothingDisabled(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const disabled: string[] = [];
  for (const tenant of [ACME, GLOBEX]) {
    const rows = await listDestinations(ctx, tenant);
    if (rows.some((d) => d.disabled_at)) disabled.push(tenant);
  }
  return {
    name: 'no destination was switched off to achieve it',
    passed: disabled.length === 0,
    notes:
      disabled.length === 0
        ? undefined
        : `disabled: ${disabled.join(', ')} — that stops the cancellations by ` +
          'stopping everything, which is not what was asked',
  };
}

/** Topics that actually reached a tenant, by successful delivery. */
async function deliveredTopics(
  ctx: ToolEvalContext,
  tenant: string
): Promise<Set<string>> {
  const events = await list<{ id?: string; topic?: string }>(
    ctx,
    `/events?tenant_id=${encodeURIComponent(tenant)}&limit=100`
  );
  const byId = new Map(events.map((e) => [e.id, e.topic]));

  const topics = new Set<string>();
  for (const destination of await listDestinations(ctx, tenant)) {
    if (!destination.id) continue;
    const attempts = await list<Attempt>(
      ctx,
      `/tenants/${encodeURIComponent(tenant)}/destinations/${encodeURIComponent(destination.id)}/attempts`
    );
    for (const attempt of attempts) {
      if (attempt.status !== 'success' || !attempt.event_id) continue;
      const topic = byId.get(attempt.event_id);
      if (topic) topics.add(topic);
    }
  }
  return topics;
}

async function attemptCount(
  ctx: ToolEvalContext,
  tenant: string
): Promise<number> {
  let total = 0;
  for (const destination of await listDestinations(ctx, tenant)) {
    if (!destination.id) continue;
    total += (
      await list<Attempt>(
        ctx,
        `/tenants/${encodeURIComponent(tenant)}/destinations/${encodeURIComponent(destination.id)}/attempts`
      )
    ).length;
  }
  return total;
}

async function publish(
  ctx: ToolEvalContext,
  tenant: string,
  topic: string
): Promise<void> {
  await ctx.outpost?.('POST', '/publish', {
    tenant_id: tenant,
    topic,
    data: { probe: true, topic },
  });
}

async function listDestinations(
  ctx: ToolEvalContext,
  tenant: string
): Promise<Destination[]> {
  return list<Destination>(
    ctx,
    `/tenants/${encodeURIComponent(tenant)}/destinations`
  );
}

/** Outpost list endpoints answer `{ pagination, models }`, not `{ data }`. */
async function list<T>(ctx: ToolEvalContext, path: string): Promise<T[]> {
  const rows = await ctx.outpost?.<T[] | { models?: T[]; data?: T[] }>(
    'GET',
    path
  );
  if (!rows) return [];
  if (Array.isArray(rows)) return rows;
  return rows.models ?? rows.data ?? [];
}
