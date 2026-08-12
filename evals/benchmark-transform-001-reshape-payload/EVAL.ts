import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM3, transformations: reshape a provider payload into what the destination
 * expects.
 *
 * Written to the one shape that has produced signal. Every scenario that
 * discriminated so far is a case where the agent finished, believed it worked,
 * and was wrong; every scenario that discriminated nothing asked it to read
 * state and reason. So this one is constructive and its output can be quietly
 * incomplete.
 *
 * `amount_cents` and `currency_code` are a rename each, sitting at the top
 * level, hard to miss. `email` is nested inside `customer`, and a transformation
 * that maps the two obvious fields and forgets the third still compiles, still
 * runs, still delivers, and still returns 200. Nothing about the result looks
 * wrong until the billing service reads a body with no email in it.
 *
 * Scored on the delivered payload rather than on the transformation's code.
 * `EventData.body` is what the destination actually received, so an agent that
 * reshapes by a route we did not anticipate passes, and code that reads
 * correctly but produces the wrong body fails. No unit conversion is asked for,
 * deliberately: cents-to-units would be ambiguous and this scenario is about
 * completeness, not arithmetic.
 */
const INGEST_WAIT_MS = 12_000;

const scorer: ToolScorer = async (ctx) => {
  const source = await findSource(ctx);
  if (!source?.url) {
    return {
      passed: false,
      checks: [{ name: 'the payments source still exists', passed: false }],
    };
  }

  const delivered = await deliverProbe(ctx, String(source.url));
  if (!delivered) {
    return {
      passed: false,
      checks: [
        {
          name: 'a probe event was delivered',
          passed: false,
          notes: 'no event recorded for the probe, so nothing routed at all',
        },
      ],
    };
  }

  const body = delivered.body;
  const checks: CheckResult[] = [
    {
      name: 'amount is at the top level of the delivered body',
      passed: body.amount === 4200,
      notes: describe('amount', 4200, body.amount),
    },
    {
      name: 'currency is at the top level of the delivered body',
      passed: body.currency === 'GBP',
      notes: describe('currency', 'GBP', body.currency),
    },
    {
      // The one that is easy to miss, and the reason this scenario exists: it
      // is the only field that has to be lifted out of a nested object.
      name: 'email is at the top level of the delivered body',
      passed: body.email === 'ana@example.com',
      notes: describe('email', 'ana@example.com', body.email),
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

function describe(
  field: string,
  want: unknown,
  got: unknown
): string | undefined {
  if (got === want) return undefined;
  return got === undefined
    ? `${field} is absent from the delivered body`
    : `expected ${JSON.stringify(want)}, delivered ${JSON.stringify(got)}`;
}

/**
 * Send one event in the old format and read back what the destination received.
 *
 * Scoped by time rather than by a marker in the body, which is the only thing
 * that works here: the task is to replace the body, so any field the probe
 * plants can legitimately be removed by a correct answer. The first version
 * searched for a probe id and a correct transformation stripped it, so the
 * scorer reported that nothing routed at all. Runs hold the project
 * exclusively, so the newest event after the probe was sent is ours.
 */
async function deliverProbe(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<{ body: Record<string, unknown> } | undefined> {
  const sentAt = new Date();
  await fetch(sourceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `ch_probe_${sentAt.getTime()}`,
      amount_cents: 4200,
      currency_code: 'GBP',
      customer: { email: 'ana@example.com', id: 'cus_5512' },
      created: 1786000000,
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, INGEST_WAIT_MS));

  const { models } = await ctx.api<{
    models?: { created_at?: string; data?: { body?: unknown } }[];
  }>('GET', '/events?limit=20&include=data&order_by=created_at&dir=desc');

  for (const event of models ?? []) {
    if (!event.created_at || new Date(event.created_at) < sentAt) continue;
    const body = event.data?.body;
    if (body && typeof body === 'object') {
      return { body: body as Record<string, unknown> };
    }
  }
  return undefined;
}

async function findSource(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/sources?limit=100'
  );
  return (models ?? [])[0];
}
