import { waitFor } from './wait-for.js';

/**
 * Helpers for `SOLUTION.ts` files — the known-good configurations `score-only`
 * applies so a scorer can be exercised against the state a correct agent would
 * have left.
 *
 * The rule these encode: **a solution must not return until its change is
 * observable.** A scorer starts sending traffic the moment a solution returns,
 * so a solution that returns on the write's acknowledgement rather than on the
 * change being live races the scorer it exists to serve. When that race is lost
 * the scenario fails, and the failure is indistinguishable from the scorer flake
 * the whole exercise is trying to measure — `filtering-001` alternated
 * pass/fail/pass/fail for exactly this reason, and two other explanations were
 * investigated and discarded first.
 */

interface Api {
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
}

interface Connection {
  id?: string;
  name?: string;
  rules?: { type?: string }[];
}

/** How long a written rule is given to become readable before giving up. */
const RULE_VISIBLE_TIMEOUT_MS = 20_000;

/**
 * Set a connection's rules by connection *name*, and wait until they read back.
 *
 * By name rather than by position: the project is fixed and reused between
 * iterations, and a reset removes only what a run added, so more than one
 * connection can be present and their order is not guaranteed. Taking the first
 * applied rules to whichever connection happened to sort first.
 */
export async function setConnectionRules(
  ctx: Api,
  connectionName: string,
  rules: Record<string, unknown>[]
): Promise<void> {
  const { models } = await ctx.api<{ models?: Connection[] }>(
    'GET',
    '/connections?limit=100'
  );

  const connection = (models ?? []).find((c) => c.name === connectionName);
  if (!connection?.id) {
    throw new Error(
      `no connection named "${connectionName}": the seed did not apply, so ` +
        'applying a solution on top of it would be meaningless'
    );
  }

  await ctx.api('PUT', `/connections/${connection.id}`, { rules });

  const expected = new Set(rules.map((r) => String(r.type)));
  await waitFor(
    async () => {
      const { models: after } = await ctx.api<{ models?: Connection[] }>(
        'GET',
        `/connections?limit=100&id=${encodeURIComponent(connection.id as string)}`
      );
      return (after ?? []).find((c) => c.id === connection.id)?.rules ?? [];
    },
    (present) => {
      const types = new Set(present.map((r) => String(r.type)));
      return [...expected].every((t) => types.has(t));
    },
    {
      timeoutMs: RULE_VISIBLE_TIMEOUT_MS,
      description: `rules ${[...expected].join(', ')} to be live on ${connectionName}`,
    }
  );
}
