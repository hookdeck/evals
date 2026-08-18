import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@hookdeck-evals/core';
import { waitForSettled } from '@hookdeck-evals/hookdeck';
import { stripIndent } from 'common-tags';

/** Polling ceiling, not a sleep. */
const INGEST_WAIT_MS = 45_000;
/** Time the filtered-out reference is given to show up before its absence is
 *  treated as the filter working. Both are posted back to back. */
const FILTER_SETTLE_MS = 10_000;

/**
 * A build task: filter a payload field by prefix so only the current reference
 * format reaches the endpoint.
 *
 * The prompt asks the regex question as well, so the negative check below is
 * fair rather than a trap. It does not carry the June 2026 regression on its
 * own: told to set the filtering up, both agents read the docs and answer
 * correctly. `regression-filtering-001-regex-capability` asks the question
 * without asking for the work, which is the phrasing that reproduces the
 * incident. The two scenarios are deliberately near-identical apart from that
 * clause, and the difference between their results is the measurement.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [
    await checkNoInventedCapabilities(ctx),
    ...(await checkFilteringWorks(ctx)),
  ];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Does the filtering actually work, rather than does it look a particular way.
 *
 * Correct answers use `$startsWith` on the current prefix, but an agent might
 * reach the same outcome another way, and a scorer that asserts on the shape of
 * the rule fails a filter that works. So this sends one reference in each
 * format and checks which arrives.
 */
async function checkFilteringWorks(
  ctx: ToolEvalContext
): Promise<CheckResult[]> {
  const source = await findSource(ctx);
  if (!source?.url) {
    return [{ name: 'source is still receiving', passed: false }];
  }

  const url = String(source.url);
  const probeAt = new Date();
  await post(url, { reference: 'ORD-2026-ZZ-9001', total: 500 });
  await post(url, { reference: 'LEGACY-99002', total: 500 });

  // `include=data` is required: the list response omits the payload without
  // it, so matching on the reference silently finds nothing. Verified against
  // the live API rather than assumed.
  const seen = async (reference: string) => {
    const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
      'GET',
      `/events?limit=100&include=data&search_term=${encodeURIComponent(reference)}`
    );
    return (models ?? []).filter(
      (e) => e.created_at && new Date(String(e.created_at)) >= probeAt
    ).length;
  };

  // Ingestion and rule evaluation are not synchronous with the POST, and the
  // two references fail in opposite directions: reading early makes the
  // current reference look filtered out and the legacy one look filtered.
  // Wait for the one that is supposed to arrive, then give the one that is not
  // its chance to disprove the filter.
  const counts = await waitForSettled(
    async () => ({
      current: await seen('ORD-2026-ZZ-9001'),
      legacy: await seen('LEGACY-99002'),
    }),
    (c) => c.current > 0,
    {
      timeoutMs: INGEST_WAIT_MS,
      settleMs: FILTER_SETTLE_MS,
      description: 'the current-format order to route',
    }
  );
  const { current, legacy } = counts;

  return [
    {
      name: 'current-format references still reach the endpoint',
      passed: current > 0,
      notes: `expected an event for ORD-2026-ZZ-9001, found ${current}`,
    },
    {
      // The failure that matters to the user: the old format is what breaks
      // their service, so a filter that lets it through has not solved anything.
      name: 'legacy references are filtered out',
      passed: legacy === 0,
      notes: `expected no event for LEGACY-99002, found ${legacy}`,
    },
  ];
}

async function checkNoInventedCapabilities(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      This check is only about invented capabilities. Ignore whether the
      filtering was set up correctly, or at all: another check covers that.

      The user asked directly whether a regex can be used. Hookdeck's filters
      have no regex operator.

      Fail ONLY if the assistant:
      - says regex filtering is available, or shows a filter rule using one
      - describes a "channel" or "channel partitioning" feature for splitting
        traffic

      Saying regex is not supported and offering what is (an operator such as
      $startsWith, or a transformation for anything more complex) is the
      correct answer and passes.

      Attempting a regex, finding it rejected, and correcting to a supported
      operator also passes: what reaches the user is what matters.
    `,
  });
  return {
    name: 'did not claim regex filtering or channels exist',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

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
