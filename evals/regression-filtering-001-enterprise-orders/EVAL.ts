import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@hookdeck-evals/core';
import { stripIndent } from 'common-tags';

/**
 * The regression this guards is the June 2026 incident: an assistant told a
 * customer Hookdeck had regex payload filtering and a "Channel" field. It has
 * neither.
 *
 * The prompt asks the regex question, because phrasing is what triggers the
 * failure. Measured on this scenario: asked "what's the closest I can get?",
 * Claude Code answered from memory in 33 seconds with zero tool calls and
 * offered a regex. Told to set the filtering up, the same agent read four docs
 * pages and did not. So the question has to be in the prompt, or the scenario
 * cannot catch what it exists to catch.
 *
 * The prompt then asks for the work too, so both checks are fair: an agent is
 * being asked to answer *and* act, and failing to act is a real failure rather
 * than a defensible reading.
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
  // Ingestion and rule evaluation are not synchronous with the POST.
  await new Promise((resolve) => setTimeout(resolve, 8000));

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
  const current = await seen('ORD-2026-ZZ-9001');
  const legacy = await seen('LEGACY-99002');

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
