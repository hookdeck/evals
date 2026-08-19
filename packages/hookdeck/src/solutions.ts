import { waitFor, waitForConsistent } from './wait-for.js';

/**
 * Helpers for `SOLUTION.ts` files — the known-good configurations `score-only`
 * applies so a scorer can be exercised against the state a correct agent would
 * have left.
 *
 * The rule these encode: **a solution must not return until its change is in
 * force.** A scorer starts sending traffic the moment a solution returns, so a
 * solution that returns early races the scorer it exists to serve, and the
 * resulting failure is indistinguishable from the scorer flake the whole
 * exercise is trying to measure.
 *
 * "In force" is stronger than "written" and stronger than "readable", and the
 * difference is not pedantry. A filter rule reads back through the API about
 * 370ms after the write and is still not applied on the ingest path at 490ms;
 * worse, while it propagates, enforcement alternates — a request at +2.5s was
 * filtered and a later one at +4.5s was not. So neither the write's
 * acknowledgement nor a read-back nor a single correct rejection is sufficient.
 * See hookdeck/evals#25.
 *
 * The only check available, absent a readiness signal from the product, is
 * behavioural and repeated: send something the rule should reject and require it
 * to be rejected several times in a row.
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
/** How long it is then given to actually take effect. Longer, because
 *  enforcement lags readability and settles unevenly. */
const RULE_ENFORCED_TIMEOUT_MS = 45_000;

/**
 * Set a connection's rules by connection *name*, and wait until they read back.
 *
 * By name rather than by position: the project is fixed and reused between
 * iterations, and a reset removes only what a run added, so more than one
 * connection can be present and their order is not guaranteed. Taking the first
 * applied rules to whichever connection happened to sort first.
 */
export interface EnforcementProbe {
  /** Send something the rule should reject. */
  send: () => Promise<void>;
  /** True when that thing was rejected — i.e. the rule is being applied. */
  rejected: () => Promise<boolean>;
}

export async function setConnectionRules(
  ctx: Api,
  connectionName: string,
  rules: Record<string, unknown>[],
  /**
   * Optional behavioural check. Without one this returns when the rule is
   * readable, which is not the same as in force — see the note above. Supply one
   * for any rule whose effect the scorer measures immediately.
   */
  probe?: EnforcementProbe
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
      description: `rules ${[...expected].join(', ')} to be readable on ${connectionName}`,
    }
  );

  if (!probe) return;

  // Three agreeing rejections, not one. A single rejection is exactly the
  // observation that misleads: measured propagation rejected at +2.5s and
  // admitted at +4.5s, so the first correct answer can arrive before the rule
  // is uniformly applied.
  await waitForConsistent(
    async () => {
      await probe.send();
      return probe.rejected();
    },
    (rejected) => rejected,
    {
      timeoutMs: RULE_ENFORCED_TIMEOUT_MS,
      intervalMs: 2_000,
      consecutive: 3,
      description: `the rules on ${connectionName} to be enforced consistently`,
    }
  );
}
