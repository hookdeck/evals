import type { ToolEvalContext } from '@hookdeck-evals/core';
import { waitFor } from '@hookdeck-evals/hookdeck';

/**
 * What a correct agent leaves behind, so `score-only` can exercise the scorer
 * without paying for a run.
 *
 * The route through this scenario is two steps, and the second is the one that
 * matters: re-enabling the destination makes *future* events flow and leaves the
 * customer still missing the outage window. `POST /retry` is what recovers it.
 *
 * The order is not a stylistic choice — the API enforces it. Retrying while the
 * destination is disabled returns `400 "Destination is disabled"`, which is the
 * documented behaviour this whole scenario is built on. Verified against the
 * live API on 20 August, not inferred from the spec.
 */

const TENANT = 'acme';

interface Destination {
  id?: string;
  disabled_at?: string | null;
}

interface OutpostEvent {
  id?: string;
}

interface Attempt {
  status?: string;
}

export default async function solve(ctx: ToolEvalContext): Promise<void> {
  const outpost = ctx.outpost;
  if (!outpost) {
    throw new Error(
      'no Outpost client: this solution cannot be applied without OUTPOST_API_KEY, ' +
        'and applying half of it would score a state no agent produced'
    );
  }

  const destination = (
    await list<Destination>(ctx, `/tenants/${TENANT}/destinations`)
  ).find((d) => d.id);

  if (!destination?.id) {
    throw new Error(`no destination for ${TENANT}: the seed did not apply`);
  }

  // 1. Re-enable. Nothing else is possible until this lands.
  await outpost(
    'PUT',
    `/tenants/${TENANT}/destinations/${destination.id}/enable`
  );

  // 2. Retry what was held.
  //
  // Scoped by `destination_id`, which is load-bearing rather than tidy. Event
  // history outlives the tenant: deleting and recreating `acme` leaves its old
  // events in place, so an unfiltered list returns everything every previous run
  // published — 38 of them at the time of writing, against 3 belonging to this
  // run. Retrying one of those answers `404 "event not found"`, because it
  // matched a destination that no longer exists.
  const events = await list<OutpostEvent>(
    ctx,
    `/events?tenant_id=${TENANT}&destination_id=${encodeURIComponent(destination.id)}`
  );

  for (const event of events) {
    if (!event.id) continue;
    await outpost('POST', '/retry', {
      event_id: event.id,
      destination_id: destination.id,
    });
  }

  // 3. Do not return until the retries have actually been delivered.
  //
  // `POST /retry` answers 202: accepted, not delivered. A solution that returns
  // on the acknowledgement races the scorer it exists to serve, and the failure
  // is indistinguishable from the scorer flake this is meant to rule out. Same
  // rule as `setConnectionRules` in `packages/hookdeck/src/solutions.ts`.
  //
  // Delivery is monotonic here — a successful attempt does not stop being one —
  // so plain `waitFor` is right, and `waitForConsistent` would only be slower.
  await waitFor(
    () =>
      list<Attempt>(
        ctx,
        `/tenants/${TENANT}/destinations/${destination.id}/attempts`
      ),
    (attempts) =>
      attempts.filter((a) => a.status === 'success').length >= events.length,
    {
      timeoutMs: 60_000,
      description: `${events.length} retried event(s) to be delivered`,
    }
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
