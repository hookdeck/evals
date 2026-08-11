import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM8, resolve: the connection is paused and nothing else is wrong.
 *
 * The whole difficulty is finding it. The source accepts requests and returns
 * 200, the destination is healthy, the endpoint really is up as the prompt
 * says, and no error appears anywhere. A paused connection is a field on an
 * object nobody thinks to read, and the symptom is silence.
 *
 * Scored entirely deterministically, which is the point of a resolve scenario.
 * Investigate scenarios end in prose and need a judge; this one ends in a state
 * change, so the scorer asks the two questions a developer would: is it
 * unpaused, and does an event actually get through now. The second is what
 * makes the first meaningful, since an agent could unpause the connection and
 * still have left something else broken behind it.
 *
 * Deliberately no seeded event history. A run of failed deliveries would give
 * the game away by pointing at the connection, and the scenario is about
 * noticing an absence rather than reading a list of errors.
 */
const INGEST_WAIT_MS = 12_000;

const scorer: ToolScorer = async (ctx) => {
  const connection = await findConnection(ctx);
  if (!connection) {
    return {
      passed: false,
      checks: [{ name: 'the checkout connection still exists', passed: false }],
    };
  }

  const checks: CheckResult[] = [
    {
      // Recreating the connection instead of unpausing it is a legitimate route
      // to the same outcome, so this is not "did you call unpause".
      name: 'the connection is no longer paused',
      passed: !connection.paused_at,
      notes: connection.paused_at
        ? `still paused at ${String(connection.paused_at)}`
        : undefined,
    },
    await checkEventsFlowAgain(ctx),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * The outcome the person asking actually wanted: send an event and see it
 * delivered.
 *
 * Scoped to this probe by matching the reference we send, because the project
 * is shared across runs and "an event exists" would eventually be true for the
 * wrong reason.
 */
async function checkEventsFlowAgain(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const name = 'a new checkout event reaches the orders API';
  const source = await findSource(ctx);
  if (!source?.url) {
    return { name, passed: false, notes: 'no source to post at' };
  }

  const reference = `chk_probe_${ctx.acquiredAt.getTime()}`;
  await fetch(String(source.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, total: 2400 }),
  });
  await new Promise((resolve) => setTimeout(resolve, INGEST_WAIT_MS));

  const { models } = await ctx.api<{
    models?: { id?: string; status?: string }[];
  }>(
    'GET',
    `/events?limit=20&include=data&order_by=created_at&dir=desc&search_term=${encodeURIComponent(reference)}`
  );
  const event = (models ?? [])[0];

  if (!event) {
    return {
      name,
      passed: false,
      notes:
        'no event created for the probe: the connection is still not routing',
    };
  }

  // A delivered event is SUCCESSFUL. Anything else means it was created and
  // then did not arrive, which is a different failure from not routing at all.
  return {
    name,
    passed: event.status === 'SUCCESSFUL',
    notes:
      event.status === 'SUCCESSFUL'
        ? undefined
        : `event created but its status is ${String(event.status)}`,
  };
}

async function findConnection(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/connections?limit=100'
  );
  return (models ?? [])[0];
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
