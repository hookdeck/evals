/**
 * Minimal Hookdeck API client.
 *
 * Deliberately not the published SDK: scorers assert on raw API state, and a
 * thin fetch wrapper keeps what a scorer sees identical to what the docs
 * describe. It is also the surface an eval's `api()` is bound to, so keeping it
 * small keeps scorers readable.
 */

const DEFAULT_BASE_URL = 'https://api.hookdeck.com/2025-07-01';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Resource kinds the provisioner creates, wipes, and scorers read. */
export const RESOURCE_KINDS = [
  'connections',
  'sources',
  'destinations',
  'transformations',
  'issue-triggers',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface HookdeckResource {
  id: string;
  name?: string;
  created_at?: string;
  [key: string]: unknown;
}

export class HookdeckApiError extends Error {
  constructor(
    readonly method: HttpMethod,
    readonly path: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
    this.name = 'HookdeckApiError';
  }
}

export interface HookdeckClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class HookdeckClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL }: HookdeckClientOptions) {
    if (!apiKey) throw new Error('HookdeckClient requires an apiKey');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        // Verified during the Phase 0 spike: the API takes Bearer, not Basic.
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HookdeckApiError(method, path, res.status, text);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * List every resource of a kind, following pagination.
   *
   * The list endpoints take `id, name, disabled, disabled_at, order_by, dir,
   * limit, next, prev` and notably no `created_at` filter, so anything
   * time-scoped is filtered client-side.
   */
  async list(kind: ResourceKind): Promise<HookdeckResource[]> {
    const all: HookdeckResource[] = [];
    let path = `/${kind}?limit=100`;
    for (;;) {
      const page = await this.request<{
        models?: HookdeckResource[];
        pagination?: { next?: string | null };
      }>('GET', path);
      all.push(...(page.models ?? []));
      const next = page.pagination?.next;
      if (!next) return all;
      path = `/${kind}?limit=100&next=${encodeURIComponent(next)}`;
    }
  }

  async delete(kind: ResourceKind, id: string): Promise<void> {
    await this.request('DELETE', `/${kind}/${id}`);
  }
}
