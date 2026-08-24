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
 * Scored on behaviour, not configuration, and the reason matters because the
 * first version of this comment gave a fictional one. It claimed a tenant's own
 * topic list gates delivery and that an agent could edit that instead —
 * `Tenant.topics` is read-only and derived from its destinations, verified
 * live: a `PUT` with topics returns `[]`, and adding a destination on
 * `order.shipped` makes it `["order.shipped"]`. (The `tenants[].topics` field
 * in every seed in this repo is therefore inert.)
 *
 * The real reason is Outpost's per-destination `filter`, which can suppress an
 * event that the `topics` array admits. A scorer reading configuration would
 * pass a destination whose topics look right and whose filter drops everything.
 * Publishing real events and checking what arrives arrives at the truth
 * whichever lever the agent used.
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
/**
 * Deliberately slower than the 1s default.
 *
 * Each poll costs one events read plus one attempts read per destination, and
 * two waits run back to back. At 1s that is well over a hundred requests for a
 * single cell, and `waitFor` treats a failed probe as "not ready yet" — so a
 * rate-limited read is indistinguishable from nothing having arrived, and
 * surfaces as a false failure on whichever check is being measured. Observed
 * once on the collateral check, which is the worst place for it: it accuses an
 * agent of breaking a customer it never touched.
 */
const POLL_INTERVAL_MS = 3_000;

interface Attempt {
  id?: string;
  status?: string;
  event_id?: string;
}

interface Destination {
  id?: string;
  topics?: string[];
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
  await publish(ctx, ACME, KEPT);
  await publish(ctx, ACME, UNMENTIONED);
  await publish(ctx, ACME, UNWANTED);

  // Two must arrive and one must not, so the positives starting the clock is
  // what gives the negative its chance to be wrong. Reading the moment the
  // positives land would pass a configuration that changed nothing at all.
  const acme = await waitForSettled(
    () => deliveredTopics(ctx, ACME),
    (topics) => topics.has(KEPT) && topics.has(UNMENTIONED),
    {
      timeoutMs: DELIVERY_WAIT_MS,
      settleMs: SETTLE_MS,
      intervalMs: POLL_INTERVAL_MS,
      description: "acme's remaining topics to be delivered",
    }
  );

  // Globex is probed *after* acme's wait, not alongside it.
  //
  // Sharing one publish meant globex's event was already 45 seconds old by the
  // time it was measured whenever acme's wait ran to timeout — which is exactly
  // the case where the agent broke acme, so the collateral check failed on the
  // runs where it mattered most. Measured: with a correct fix acme resolves
  // fast and globex passed 5/5; on the delete and disable paths globex failed
  // twice, while delivering perfectly well when tested on its own.
  //
  // The precise interaction was never pinned down, and this does not attempt
  // to. It removes the coupling instead: each tenant gets its own publish and
  // its own window, so how long acme takes cannot decide whether globex looks
  // untouched. Accusing an agent of breaking a customer it never touched is the
  // worst false failure this scorer could produce.
  await publish(ctx, GLOBEX, UNWANTED);

  const globex = await waitForSettled(
    () => deliveredTopics(ctx, GLOBEX),
    (topics) => topics.has(UNWANTED),
    {
      timeoutMs: DELIVERY_WAIT_MS,
      settleMs: SETTLE_MS,
      intervalMs: POLL_INTERVAL_MS,
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

  // A platform fault throws; an agent fault is scored. Telling them apart needs
  // the configuration, not the delivery count.
  //
  // The first version threw whenever acme received nothing — which is exactly
  // what deleting the destination, disabling it, or setting `topics: []`
  // produces. Those are the worst things an agent can do here, and the throw
  // discarded the `checks` array that described them, so no result row was
  // written at all: the scenario structurally could not report its own most
  // severe failures. `checkNothingDisabled` existed to name a route the scorer
  // then threw away.
  //
  // So only throw when the configuration says acme *should* have received
  // something and nothing arrived. That is the seed or the platform. If nothing
  // arrived because no enabled destination subscribes to the topic any more,
  // the agent did that, and the checks above already say so.
  if (acme.size === 0) {
    const live = (await listDestinations(ctx, ACME)).filter(
      (d) => !d.disabled_at
    );
    const shouldHaveArrived = live.some((d) => {
      const topics = d.topics ?? [];
      return topics.includes('*') || topics.includes(KEPT);
    });
    if (shouldHaveArrived) {
      throw new Error(
        `acme has an enabled destination subscribed to ${KEPT} and received nothing ` +
          'after publishing: the seed or the platform is at fault, not the agent, ' +
          'so this run is not scoreable'
      );
    }
  }

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

/**
 * Outpost list endpoints answer `{ pagination, models }`, not `{ data }`.
 *
 * A `404` is an empty read rather than a failure, and only a `404`. Deleting a
 * tenant's last destination deletes the tenant with it, so an agent that
 * removes the destination — one of the wrong routes this scenario scores —
 * makes every subsequent read 404. Letting that propagate threw the whole cell
 * away and wrote no result, which is the same defect the throw above was just
 * repaired for. Anything else still propagates, because a scorer that treats
 * every error as "nothing there" reports a confident agent failure for a
 * platform blip.
 */
async function list<T>(ctx: ToolEvalContext, path: string): Promise<T[]> {
  let rows: T[] | { models?: T[]; data?: T[] } | undefined;
  try {
    rows = await ctx.outpost?.<T[] | { models?: T[]; data?: T[] }>('GET', path);
  } catch (error) {
    if (String((error as Error).message).includes('404')) return [];
    throw error;
  }
  if (!rows) return [];
  if (Array.isArray(rows)) return rows;
  return rows.models ?? rows.data ?? [];
}
