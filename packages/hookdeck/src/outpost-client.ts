/**
 * A minimal Outpost API client, for scenarios that score outbound delivery.
 *
 * Separate from `HookdeckClient` rather than an option on it: Outpost is a
 * different API with a different base URL, its own resource model (tenants own
 * destinations, events are published to topics) and its own key. Folding them
 * together would put an `if` in every method for no shared behaviour.
 *
 * Scoped to what a scorer needs. Scenarios ask an agent to build with Outpost;
 * this reads back what it built and publishes an event to see where it goes.
 */

export const OUTPOST_API_BASE = 'https://api.outpost.hookdeck.com/2025-07-01';

export interface OutpostClientOptions {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Unwrap an Outpost list response.
 *
 * The paginated shape is `{ pagination, models }`, per `TenantPaginatedResult`
 * and `AttemptPaginatedResult` in Outpost's OpenAPI spec. Every method here
 * originally read `data` instead, so all three returned an empty array against
 * the real API. That is how `outpost-001` came to be unpassable: its tenant
 * check could never find a tenant and its delivery check was permanently
 * `0 > 0`. The scorer was fixed on 12 August; this client was the same bug in
 * a second place, found only because tenant cleanup started depending on it.
 *
 * `data` and a bare array stay accepted because they cost nothing and the two
 * expensive failures here have both been an unrecognised envelope.
 */
function listBody<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const envelope = body as { models?: unknown; data?: unknown };
    if (Array.isArray(envelope.models)) return envelope.models as T[];
    if (Array.isArray(envelope.data)) return envelope.data as T[];
  }
  return [];
}

export class OutpostClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OutpostClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? OUTPOST_API_BASE;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Outpost ${method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Tenants in the project. The agent's work shows up here first. */
  async tenants(): Promise<{ id: string; topics?: string[] }[]> {
    return listBody<{ id: string; topics?: string[] }>(
      await this.request('GET', '/tenants')
    );
  }

  async destinations(tenantId: string): Promise<Record<string, unknown>[]> {
    return listBody(
      await this.request(
        'GET',
        `/tenants/${encodeURIComponent(tenantId)}/destinations`
      )
    );
  }

  /** Publish an event, which is how a scorer exercises what the agent built. */
  async publish(event: {
    tenant_id: string;
    topic: string;
    data: Record<string, unknown>;
    eligible_for_retry?: boolean;
  }): Promise<unknown> {
    return this.request('POST', '/publish', event);
  }

  /**
   * Delivery attempts for a tenant's destination, which is where "did it
   * actually arrive" is answered.
   */
  async attempts(
    tenantId: string,
    destinationId: string
  ): Promise<Record<string, unknown>[]> {
    return listBody(
      await this.request(
        'GET',
        `/tenants/${encodeURIComponent(tenantId)}/destinations/${encodeURIComponent(destinationId)}/attempts`
      )
    );
  }

  /** Everything a run created, so a scenario can reset between runs. */
  async deleteTenant(tenantId: string): Promise<void> {
    await this.request('DELETE', `/tenants/${encodeURIComponent(tenantId)}`);
  }
}
