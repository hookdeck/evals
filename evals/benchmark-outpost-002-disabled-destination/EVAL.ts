import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';
import { waitForOrLast } from '@hookdeck-evals/hookdeck';

/**
 * Outpost's most reliable support case: a destination switched off after
 * repeated failures, an endpoint since repaired, and nothing flowing.
 *
 * The trap is that nothing recovers on its own, and whether anything told you
 * depends on configuration the customer's deployment may not have.
 * Outpost retries automatically with exponential backoff, so an endpoint that
 * breaks and heals needs no intervention — which is exactly why this scenario
 * does not use that shape. A *disabled* destination is different: the
 * documentation is explicit that events published to a tenant are not delivered
 * to a disabled destination and that "disabled destinations cannot be retried
 * until re-enabled". Retrying one anyway answers `400 "Destination is
 * disabled"`, verified against the live API. So the events are held and the
 * endpoint is healthy.
 *
 * Outpost is not silent about this by design: `alert.destination.disabled` is a
 * documented operator event, alongside `alert.destination.consecutive_failure`
 * at 50/70/90/100% of the threshold. But operator events are off until a sink is
 * configured — Hookdeck Monitoring settings on managed, `OPERATION_EVENTS_TOPICS`
 * plus a sink when self-hosted — so the scenario is set on a deployment where
 * nobody did, which is why the customer is the one who noticed. An agent that
 * also recommends turning them on has given better advice than the task asked
 * for; the scorer neither requires nor penalises it.
 *
 * That combination is what makes it worth scoring. An agent that checks the
 * endpoint finds it fine. An agent that republishes finds the new events held
 * too. The only route through is noticing the destination's state.
 *
 * Scored on outcome rather than method, which is the lesson from
 * `alerting-001`: that scorer asked *who created* an alert and failed the agent
 * that repaired a broken one, which was the better answer. Here it does not
 * matter whether the agent re-enables the existing destination or reaches the
 * same end state another way — what matters is that Acme receives what they
 * missed and receives what comes next.
 *
 * A second tenant is seeded and delivering normally. Recovery scoped too
 * widely is a real failure mode, and it is the one that turns a fix into a
 * second incident.
 */
const TENANT = 'acme';
const OTHER_TENANT = 'globex';
/** Polling ceiling, not a sleep. */
const DELIVERY_WAIT_MS = 45_000;
/** Seeded before the agent ran, all of which failed against the bad endpoint. */
const MISSED_EVENTS = 3;

interface Destination {
  id?: string;
  disabled_at?: string | null;
}

interface Attempt {
  id?: string;
  status?: string;
}

const scorer: ToolScorer = async (ctx) => {
  const destinations = await listDestinations(ctx, TENANT);
  if (destinations.length === 0) {
    return {
      passed: false,
      checks: [
        {
          name: "the customer's destination still exists",
          passed: false,
          notes:
            'no destination for acme: the seeded one was removed rather than repaired, ' +
            'which loses the delivery history the missed events are attached to',
        },
      ],
    };
  }

  // *Any* enabled destination, not the first one listed. Re-enabling the
  // seeded destination is the expected route, but an agent that instead adds a
  // working one has also made acme able to receive, and this scenario scores the
  // end state. Reading `[0]` would decide that on list order.
  const enabled = destinations.filter((d) => !d.disabled_at);

  const checks: CheckResult[] = [
    {
      // Not "the agent called /enable": an end state reached another way is
      // still the end state.
      name: 'the customer can receive again',
      passed: enabled.length > 0,
      notes:
        enabled.length > 0
          ? undefined
          : `all ${destinations.length} of acme's destinations are still disabled, ` +
            'so nothing published to acme will be delivered',
    },
    await checkMissedEventsDelivered(ctx, destinations),
    await checkOtherTenantUntouched(ctx),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * The events sent before the agent ran, which failed and were then held when
 * the destination was disabled.
 *
 * This is the check the scenario exists for. Re-enabling the destination alone
 * makes *future* events flow and leaves the customer missing everything from
 * the outage — which is what they wrote in about. Outpost holds those attempts
 * and exposes a retry, so recovering them is possible and is the actual job.
 */
async function checkMissedEventsDelivered(
  ctx: ToolEvalContext,
  destinations: Destination[]
): Promise<CheckResult> {
  const name = 'the events the customer missed were delivered';

  // Poll: a retry triggered moments before the agent finished is still in
  // flight, and reading once would score the agent for the platform's timing.
  // Summed across the tenant's destinations, for the same reason: an agent that
  // recovered the events onto a replacement destination delivered them.
  const attempts = await waitForOrLast(
    () => listAllAttempts(ctx, TENANT, destinations),
    (rows) =>
      rows.filter((a) => a.status === 'success').length >= MISSED_EVENTS,
    {
      timeoutMs: DELIVERY_WAIT_MS,
      description: 'the held events to be delivered',
    }
  );

  const delivered = attempts.filter((a) => a.status === 'success').length;
  return {
    name,
    passed: delivered >= MISSED_EVENTS,
    notes:
      delivered >= MISSED_EVENTS
        ? undefined
        : `${delivered} of ${MISSED_EVENTS} missed events delivered: the destination may be ` +
          'receiving again, but the customer is still missing the outage window',
  };
}

/**
 * The negative, and the reason it carries weight: an agent that recovers
 * everything rather than what was asked has turned a fix into a second
 * incident. Globex was never broken.
 */
async function checkOtherTenantUntouched(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const name = 'the other customer was left alone';
  const destinations = await listDestinations(ctx, OTHER_TENANT);

  if (destinations.length === 0) {
    return {
      name,
      passed: false,
      notes: `no destination for ${OTHER_TENANT}: it was removed, and it was never part of the problem`,
    };
  }

  // Every one of them, not the first: collateral damage to the second
  // destination of a tenant is still collateral damage.
  const disabled = destinations.filter((d) => d.disabled_at);
  return {
    name,
    passed: disabled.length === 0,
    notes:
      disabled.length === 0
        ? undefined
        : `${disabled.length} of ${OTHER_TENANT}'s destinations were disabled, so fixing acme ` +
          'broke a customer who was working',
  };
}

async function listDestinations(
  ctx: ToolEvalContext,
  tenantId: string
): Promise<Destination[]> {
  const rows = await ctx.outpost?.<Destination[] | { models?: Destination[] }>(
    'GET',
    `/tenants/${encodeURIComponent(tenantId)}/destinations`
  );
  return unwrap<Destination>(rows);
}

/** Every attempt across the tenant's destinations. */
async function listAllAttempts(
  ctx: ToolEvalContext,
  tenantId: string,
  destinations: Destination[]
): Promise<Attempt[]> {
  const perDestination = await Promise.all(
    destinations
      .filter((d): d is Destination & { id: string } => Boolean(d.id))
      .map((d) => listAttempts(ctx, tenantId, d.id))
  );
  return perDestination.flat();
}

async function listAttempts(
  ctx: ToolEvalContext,
  tenantId: string,
  destinationId: string
): Promise<Attempt[]> {
  const rows = await ctx.outpost?.<Attempt[] | { models?: Attempt[] }>(
    'GET',
    `/tenants/${encodeURIComponent(tenantId)}/destinations/${encodeURIComponent(destinationId)}/attempts`
  );
  return unwrap<Attempt>(rows);
}

/**
 * Outpost list endpoints return `{ pagination, models }`, the same shape as
 * Hookdeck's own, and a bare array on some.
 *
 * **Not `{ data }`.** `outpost-001` carries a comment saying so, because
 * reading `data` never matches and silently reports zero — which is exactly
 * what this scorer did on its first run: no attempts anywhere, on a destination
 * that had them. A shape mismatch here does not error, it just quietly answers
 * "nothing happened", which is indistinguishable from an agent that did
 * nothing.
 */
function unwrap<T>(rows: T[] | { models?: T[]; data?: T[] } | undefined): T[] {
  if (!rows) return [];
  if (Array.isArray(rows)) return rows;
  return rows.models ?? rows.data ?? [];
}
