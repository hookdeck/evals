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
/** The source the seed creates. The probe has to go to this one, not whichever
 * source happens to sort first. */
const SOURCE_NAME = 'payments';
/** Ingestion is not synchronous with the POST, so the probe polls for its event. */
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 20_000;

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
 * Scoped by the request the probe itself created, not by a marker in the body
 * and not by wall-clock time. A marker cannot work here: the task is to replace
 * the body, so any field the probe plants can legitimately be removed by a
 * correct answer, and the first version searched for a probe id that a correct
 * transformation stripped, reporting that nothing routed at all.
 *
 * Time-scoping replaced it and has its own hazard. `sentAt` is the scorer's
 * clock and `created_at` is Hookdeck's, so a second of skew in the wrong
 * direction discards the probe's own event and the scenario fails with "nothing
 * routed" against a correct transformation. Events cannot be deleted from a
 * shared project either, so the window cannot simply be widened: the seeded
 * events carry the pre-transformation shape and would score as a failure.
 *
 * The ingest response carries the `request_id`, and `/requests/{id}/events`
 * returns exactly the events that request produced. That is exact rather than
 * approximate, immune to skew and to accumulated history. Time-scoping stays as
 * a fallback for the case where the ingest response is not the shape we expect.
 */
async function deliverProbe(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<{ body: Record<string, unknown> } | undefined> {
  const sentAt = new Date();
  const res = await fetch(sourceUrl, {
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
  const requestId = await ingestedRequestId(res);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const body = requestId
      ? await bodyForRequest(ctx, requestId)
      : await bodyAfter(ctx, sentAt);
    if (body) return { body };
  }
  return undefined;
}

/** The ingest endpoint answers with the id of the request it recorded. */
async function ingestedRequestId(res: Response): Promise<string | undefined> {
  try {
    const json = (await res.json()) as { request_id?: unknown };
    return typeof json.request_id === 'string' ? json.request_id : undefined;
  } catch {
    return undefined;
  }
}

/** Exactly the events this request produced, whatever else the project holds. */
async function bodyForRequest(
  ctx: ToolEvalContext,
  requestId: string
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{
    models?: { data?: { body?: unknown } }[];
  }>('GET', `/requests/${requestId}/events?limit=10&include=data`);
  return firstObjectBody(models);
}

/** Fallback: the newest event recorded since the probe was sent. */
async function bodyAfter(
  ctx: ToolEvalContext,
  sentAt: Date
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{
    models?: { created_at?: string; data?: { body?: unknown } }[];
  }>('GET', '/events?limit=20&include=data&order_by=created_at&dir=desc');
  const since = (models ?? []).filter(
    (e) => e.created_at && new Date(e.created_at) >= sentAt
  );
  return firstObjectBody(since);
}

function firstObjectBody(
  events: { data?: { body?: unknown } }[] | undefined
): Record<string, unknown> | undefined {
  for (const event of events ?? []) {
    const body = event.data?.body;
    if (body && typeof body === 'object') {
      return body as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * The seeded source by name.
 *
 * Taking the first source the API returns was wrong: `/sources` is newest-first,
 * so any source the agent created while working — a scratch source, a second
 * one it decided it wanted — would be probed instead of the one the connection
 * and the transformation hang off, and the scenario would report that nothing
 * routed. Falling back to the first keeps a renamed source scoreable.
 */
async function findSource(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/sources?limit=100'
  );
  const sources = models ?? [];
  return sources.find((s) => s.name === SOURCE_NAME) ?? sources[0];
}
