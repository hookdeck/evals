import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';
import { waitForSettled } from '@hookdeck-evals/hookdeck';

/**
 * BM14, deduplication: the same event twice within seconds must reach the
 * ledger once.
 *
 * Scored by sending the duplicate rather than by reading the rule, because a
 * deduplicate rule has a window and a set of fields it keys on, and both have
 * to be right for it to do anything. A rule keyed on the wrong field is
 * present, visible, and useless; a window shorter than the provider's retry gap
 * is the same. Sending two identical payloads and counting what routed answers
 * the question the ledger actually cares about.
 *
 * The prompt says the ledger cannot easily be changed, which rules out the
 * answer an agent might otherwise reach for. Idempotency belongs in the
 * consumer and everybody knows it; this scenario is about what to do when that
 * is not available, which is the situation people are actually in when they ask.
 */
/** Polling ceiling, not a sleep: reached only when the first payment never
 *  routes at all, which is itself a scored outcome. */
const INGEST_WAIT_MS = 45_000;
/** How long a suppressed duplicate is given to prove it was not suppressed.
 *  The two are posted back to back, so this is generous. */
const DUPLICATE_SETTLE_MS = 10_000;

const scorer: ToolScorer = async (ctx) => {
  const source = await findSource(ctx);
  if (!source?.url) {
    return {
      passed: false,
      checks: [{ name: 'the payments source still exists', passed: false }],
    };
  }

  const reference = `pay_probe_${ctx.acquiredAt.getTime()}`;
  const body = {
    id: reference,
    amount: 2500,
    currency: 'GBP',
    type: 'payment.succeeded',
  };

  // Byte-identical, back to back, which is what a provider retrying on a
  // timeout actually sends.
  await post(String(source.url), body);
  await post(String(source.url), body);

  // Both checks below read the same number, and they fail in opposite
  // directions, so when this reads matters more here than anywhere else.
  // Returning the moment one event exists would score a rule that does nothing
  // as a pass, because the second event would still be in flight. Waiting for
  // the first to land and then holding for the settle window is what makes
  // "the duplicate did not reach the ledger" mean anything.
  const routed = await waitForSettled(
    async () => {
      const { models } = await ctx.api<{ models?: unknown[] }>(
        'GET',
        `/events?limit=50&include=data&search_term=${encodeURIComponent(reference)}`
      );
      return (models ?? []).length;
    },
    (count) => count >= 1,
    {
      timeoutMs: INGEST_WAIT_MS,
      settleMs: DUPLICATE_SETTLE_MS,
      description: 'the payment to route at least once',
    }
  );

  const checks: CheckResult[] = [
    {
      name: 'the duplicate did not reach the ledger',
      passed: routed <= 1,
      notes:
        routed <= 1
          ? undefined
          : `${routed} events routed for one payment, so the ledger double-counts it`,
    },
    {
      // Guards the opposite failure: a rule so broad it drops the original too.
      // Suppressing everything also produces "no duplicates".
      name: 'the original still reached the ledger',
      passed: routed >= 1,
      notes:
        routed >= 1
          ? undefined
          : 'no events routed at all: the payment was suppressed rather than deduplicated',
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function post(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
