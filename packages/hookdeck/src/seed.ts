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

export interface Seed {
  resources?: SeedResource[];
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
