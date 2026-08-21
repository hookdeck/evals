/**
 * Scenario starting state.
 *
 * A scenario's `remote/seed.json` describes the Hookdeck project the agent
 * finds when it starts. Two parts:
 *
 *   resources - sources, destinations, connections and so on to create
 *   events    - HTTP requests to POST at a seeded source's URL
 *
 * Events are seeded by sending them because there is no create-event API;
 * events exist only as a consequence of delivery. That is also why a seeded
 * project takes a moment to settle, and why scorers scope to `acquiredAt`.
 *
 * Putting context in the seed rather than the prompt is deliberate. The prompt
 * is what a real person types ("webhooks just stopped arriving"); everything
 * the agent needs to work it out lives in the project state, so the scenario
 * measures discovery rather than instruction-following.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookdeckClient, HttpMethod, ResourceKind } from './client.js';
import { waitFor } from './wait-for.js';

export interface SeedResource {
  kind: ResourceKind;
  /** Referenced by other resources in the same seed via `$ref`. */
  ref?: string;
  /** Request body, with `$ref:<name>` placeholders resolved before sending. */
  body: Record<string, unknown>;
  /**
   * Applied after creation, e.g. `{"path": "/connections/{id}/pause"}` to seed
   * BM8's paused connection. Defaults to PUT: the action endpoints
   * (pause, unpause, enable, disable, archive) are all PUT on this API.
   */
  then?: SeedStep[];
}

export interface SeedStep {
  path: string;
  method?: HttpMethod;
  /** A JSON request body. `$ref:<name>` placeholders are resolved before sending. */
  body?: Record<string, unknown>;
}

export interface SeedEvent {
  /** `ref` of the source to POST at. */
  source: string;
  body?: unknown;
  /**
   * Generate a body of roughly this many bytes instead of sending `body`.
   * For scenarios about size limits, so the seed file stays small: a literal
   * 10 MiB payload does not belong in version control.
   */
  bodyBytes?: number;
  headers?: Record<string, string>;
  /** Send this many copies. Defaults to 1. */
  count?: number;
}

/**
 * Outpost state a scenario starts from.
 *
 * Kept as its own section rather than folded into `resources`, because Outpost
 * is a separate service: different base URL, different key, and a tenant model
 * the gateway does not have. Sharing `ResourceKind` between them would make the
 * seed file look uniform while the two halves went to different APIs.
 *
 * Applied only when an Outpost client is configured. A scenario needing this
 * should declare `requires: [outpost]` so it reads as skipped rather than
 * failing on a machine with no Outpost key.
 */
export interface OutpostSeed {
  /**
   * Delete the project's operator event destinations before seeding.
   *
   * For scenarios about configuring alerting, which have to start from none
   * configured. The project is shared and long-lived, so it accumulates real
   * ones — at the time of writing it carried a destination subscribed to `*`,
   * which would have made "you are not being alerted" false and let a correct
   * agent answer that this was already set up.
   *
   * `FixedProjectSource` captures them at acquire and restores them on release,
   * so this removes them for the run rather than for good.
   */
  clearOperatorEventDestinations?: boolean;
  tenants?: {
    id: string;
    topics?: string[];
    destinations?: {
      /** Referenced by `after` steps via `$ref:<name>`. */
      ref?: string;
      type?: string;
      topics?: string[] | string;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
    }[];
  }[];
  /** Events published before the agent runs, so history exists to reason about. */
  publish?: { tenant: string; topic: string; data?: unknown; count?: number }[];
  /**
   * Applied after publishing, for the same reason the gateway seed has one:
   * a resolve scenario starts from history that already went wrong and a
   * system that is now healthy. Disabling a destination here is how a scenario
   * expresses "this was switched off after it kept failing".
   */
  after?: SeedStep[];
}

export interface Seed {
  resources?: SeedResource[];
  outpost?: OutpostSeed;
  events?: SeedEvent[];
  /**
   * Requests applied after every event has been sent.
   *
   * A `then` step runs while its resource is being created, so it cannot
   * express "let these deliveries fail, then repair the endpoint". That state
   * is what a resolve scenario starts from: history that already went wrong and
   * a system that is now healthy. Paths may contain `$ref:name`, resolved to
   * the created resource's id.
   */
  after?: SeedStep[];
}

export interface AppliedSeed {
  /** `ref` to created resource, so scorers and event seeding can find them. */
  refs: Record<string, { id: string; url?: string }>;
}

export function readSeed(remoteDir: string): Seed | undefined {
  const path = join(remoteDir, 'seed.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Seed;
}

/** Replace `$ref:<name>` strings with the id of a resource created earlier. */
function resolveRefs(
  body: Record<string, unknown>,
  refs: AppliedSeed['refs']
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.startsWith('$ref:')) {
      const name = value.slice('$ref:'.length);
      const target = refs[name];
      if (!target) throw new Error(`seed references unknown ref "${name}"`);
      out[key] = target.id;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = resolveRefs(value as Record<string, unknown>, refs);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function applySeed(
  client: HookdeckClient,
  seed: Seed
): Promise<AppliedSeed> {
  const refs: AppliedSeed['refs'] = {};

  for (const resource of seed.resources ?? []) {
    const created = await client.request<{ id: string; url?: string }>(
      'POST',
      `/${resource.kind}`,
      resolveRefs(resource.body, refs)
    );
    if (resource.ref) {
      // A created source returns its delivery URL on the create response, so
      // event seeding needs no second lookup.
      refs[resource.ref] = { id: created.id, url: created.url };
    }
    for (const step of resource.then ?? []) {
      await client.request(
        step.method ?? 'PUT',
        step.path.replace('{id}', created.id),
        step.body
      );
    }
  }

  const eventsStartedAt = new Date();

  for (const event of seed.events ?? []) {
    const target = refs[event.source];
    if (!target?.url) {
      throw new Error(
        `seed event references source "${event.source}" with no delivery URL`
      );
    }
    const body = event.bodyBytes
      ? JSON.stringify({ padding: 'x'.repeat(event.bodyBytes) })
      : JSON.stringify(event.body ?? {});
    for (let i = 0; i < (event.count ?? 1); i++) {
      // Oversized payloads are rejected at ingestion (413), which is the point
      // of some scenarios, so a non-2xx here is not an error.
      await fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...event.headers },
        body,
      });
    }
  }

  if (seed.after?.length) {
    await waitForEventsToSettle(client, eventsStartedAt);
  }

  for (const step of seed.after ?? []) {
    await client.request(
      step.method ?? 'PUT',
      resolvePathRefs(step.path, refs),
      step.body ? resolveRefs(step.body, refs) : undefined
    );
  }

  return { refs };
}

/** Event states that mean delivery has not been attempted yet, or not finished. */
const PENDING_EVENT_STATUSES = new Set(['QUEUED', 'SCHEDULED']);

/**
 * Block until every event seeded since `since` has been delivered at least once.
 *
 * Only called when a seed has an `after` block, because that is the only time it
 * matters, and it costs a scenario several seconds.
 *
 * A POST to a source URL returns as soon as ingestion accepts it; delivery is
 * queued and happens on a worker. So an `after` step that repairs a destination
 * can land *before* the first attempt on an event that was meant to fail against
 * the broken one. That event then succeeds, the scenario self-heals, and the
 * agent is scored on work it never had to do. resolve-002 is the case: it seeds
 * failing checkout deliveries, then repairs the endpoint, and asks the agent to
 * redeliver. Every seeded event has to have failed before the repair or there is
 * nothing to redeliver.
 *
 * Waiting on state rather than sleeping a fixed interval: the settle time varies
 * with how many events a scenario seeds, and a sleep long enough for the worst
 * case is dead time in every other scenario.
 */
async function waitForEventsToSettle(
  client: HookdeckClient,
  since: Date,
  timeoutMs = 30_000,
  pollMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const page = await client.request<{
      models?: { created_at?: string; status?: string }[];
    }>('GET', '/events?limit=100&order_by=created_at&dir=desc');

    // List endpoints take no created_at filter, so scope client-side. Events
    // rejected at ingestion (an oversized payload, a filter) never appear here
    // at all, which is correct: there is nothing to wait for.
    const pending = (page.models ?? []).filter(
      (event) =>
        event.created_at &&
        new Date(event.created_at) >= since &&
        PENDING_EVENT_STATUSES.has(event.status ?? '')
    );

    if (pending.length === 0) return;

    if (Date.now() >= deadline) {
      // Proceeding is better than throwing: the seed is otherwise valid and the
      // scenario may still score. Say so loudly, because a silent timeout puts
      // the race back and the resulting pass looks legitimate.
      console.warn(
        `[seed] ${pending.length} event(s) still pending after ${timeoutMs}ms; ` +
          'applying `after` steps anyway. A seeded event may be delivered ' +
          'against post-`after` state, which can self-heal the scenario.'
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Replace `$ref:name` in a path with the created resource's id. */
function resolvePathRefs(path: string, refs: AppliedSeed['refs']): string {
  return path.replace(/\$ref:([\w-]+)/g, (_, name: string) => {
    const target = refs[name];
    if (!target) throw new Error(`seed step references unknown ref "${name}"`);
    return target.id;
  });
}

/**
 * Apply the Outpost half of a seed.
 *
 * Separate from `applySeed` because it talks to a different service with its
 * own client, and because a scenario can want gateway state, Outpost state, or
 * both. The caller decides whether an Outpost client exists; this does not
 * silently no-op, so a seed asking for Outpost state on a machine without a key
 * fails loudly rather than running the scenario against nothing.
 */
/** How long published events are given to be attempted before the seed gives up. */
const ATTEMPT_WAIT_MS = 60_000;

type OutpostCall = <T>(
  method: HttpMethod,
  path: string,
  body?: unknown
) => Promise<T>;

export async function applyOutpostSeed(
  outpost: OutpostCall,
  seed: OutpostSeed
): Promise<{ destinations: Record<string, string> }> {
  const destinations: Record<string, string> = {};

  for (const tenant of seed.tenants ?? []) {
    // Delete first, so the seed is idempotent.
    //
    // Tenant create is idempotent on the id but destination create is not, so
    // seeding onto a surviving tenant appends a second destination rather than
    // replacing the first. The scenario then starts with two, one carrying the
    // seeded history and one empty, and any scorer reading `[0]` gets whichever
    // sorted first. That is how `alerting-001` came to publish a wrong result
    // for twelve days — a leftover from an earlier run that nothing collected.
    //
    // Tenants are collected on release, but that runs in a `catch`-and-ignore
    // so a crashed run leaves them behind. Deleting here does not depend on the
    // previous run having exited cleanly.
    await outpost('DELETE', `/tenants/${encodeURIComponent(tenant.id)}`).catch(
      () => undefined
    );
    await outpost('PUT', `/tenants/${encodeURIComponent(tenant.id)}`, {
      ...(tenant.topics ? { topics: tenant.topics } : {}),
    });

    for (const destination of tenant.destinations ?? []) {
      const created = await outpost<{ id: string }>(
        'POST',
        `/tenants/${encodeURIComponent(tenant.id)}/destinations`,
        {
          type: destination.type ?? 'webhook',
          topics: destination.topics ?? '*',
          config: destination.config ?? {},
          ...(destination.credentials
            ? { credentials: destination.credentials }
            : {}),
        }
      );
      if (destination.ref) destinations[destination.ref] = created.id;
    }
  }

  if (seed.clearOperatorEventDestinations) {
    await clearOperatorEventDestinations(outpost);
  }

  const published = new Map<string, number>();
  for (const event of seed.publish ?? []) {
    for (let i = 0; i < (event.count ?? 1); i += 1) {
      await outpost('POST', '/publish', {
        tenant_id: event.tenant,
        topic: event.topic,
        data: event.data ?? {},
      });
    }
    published.set(
      event.tenant,
      (published.get(event.tenant) ?? 0) + (event.count ?? 1)
    );
  }

  // Wait for the published events to be *attempted* before running `after`.
  //
  // Publishing is synchronous and delivery is not, so `after` otherwise lands
  // while the events are still queued. For this seed's shape that is not a slow
  // start, it is a different scenario: `after` disables the destination, and a
  // disabled destination is never attempted, so the failed attempts the scorer
  // looks for are never created at all. Verified — with a fresh tenant, acme
  // ended with zero attempts; the run before it showed three only because the
  // tenant had survived from an earlier run and had been delivering while it
  // sat there.
  //
  // This is the same trap `applySeed` fixes on the gateway side, where
  // `resolve-002` repaired an endpoint before the first delivery attempt and
  // left nothing to redeliver. Second time, same cause.
  await waitForPublishedAttempts(outpost, published);

  for (const step of seed.after ?? []) {
    const path = step.path.replace(
      /\$ref:([a-zA-Z0-9_-]+)/g,
      (_, ref: string) => destinations[ref] ?? `$ref:${ref}`
    );
    await outpost(step.method ?? 'PUT', path, step.body);
  }

  return { destinations };
}

/**
 * Poll until each tenant has at least as many delivery attempts as it had
 * events published.
 *
 * Any status counts. The point is that Outpost has *tried*, not that it
 * succeeded: a seed deliberately pointing at a failing endpoint wants the
 * failures, and waiting for success would hang forever on exactly the scenarios
 * that need this most.
 *
 * Throws on timeout rather than continuing. A seed that cannot establish its
 * own precondition has not set up the scenario, and running the agent against
 * a state that quietly differs from the intended one produces a result that
 * looks valid and is not — which is worth more than the cost of a failed run.
 */
async function waitForPublishedAttempts(
  outpost: OutpostCall,
  published: Map<string, number>
): Promise<void> {
  for (const [tenant, expected] of published) {
    if (expected < 1) continue;
    await waitFor(
      () => countAttempts(outpost, tenant),
      (seen) => seen >= expected,
      {
        timeoutMs: ATTEMPT_WAIT_MS,
        description: `${expected} delivery attempt(s) on tenant ${tenant}`,
      }
    );
  }
}

async function countAttempts(
  outpost: OutpostCall,
  tenant: string
): Promise<number> {
  const destinations = unwrapModels<{ id?: string }>(
    await outpost<{ id?: string }[] | { models?: { id?: string }[] }>(
      'GET',
      `/tenants/${encodeURIComponent(tenant)}/destinations`
    )
  );
  let total = 0;
  for (const destination of destinations) {
    if (!destination.id) continue;
    total += unwrapModels<unknown>(
      await outpost<unknown[] | { models?: unknown[] }>(
        'GET',
        `/tenants/${encodeURIComponent(tenant)}/destinations/${encodeURIComponent(destination.id)}/attempts`
      )
    ).length;
  }
  return total;
}

/**
 * Outpost list endpoints return `{ pagination, models }`, not `{ data }`.
 *
 * Reading the wrong key does not error, it returns nothing — so a wait built on
 * it would time out on a tenant that was delivering perfectly well. Both
 * `outpost-001` and `outpost-002` have been caught by this.
 */
function unwrapModels<T>(
  rows: T[] | { models?: T[]; data?: T[] } | undefined
): T[] {
  if (!rows) return [];
  if (Array.isArray(rows)) return rows;
  return rows.models ?? rows.data ?? [];
}

/**
 * Remove every operator event destination on the project.
 *
 * A project that has never had one answers `404 "tenant not found"` on the
 * list, because the backing tenant is created lazily on the first create. That
 * is an empty list and not a failure — treating it as one would throw on
 * exactly the clean project this is trying to produce.
 */
async function clearOperatorEventDestinations(
  outpost: OutpostCall
): Promise<void> {
  let existing: { id?: string }[] = [];
  try {
    existing = unwrapModels<{ id?: string }>(
      await outpost<{ id?: string }[] | { models?: { id?: string }[] }>(
        'GET',
        '/operator-events/destinations'
      )
    );
  } catch {
    return;
  }

  for (const destination of existing) {
    if (!destination.id) continue;
    await outpost(
      'DELETE',
      `/operator-events/destinations/${encodeURIComponent(destination.id)}`
    );
  }
}
