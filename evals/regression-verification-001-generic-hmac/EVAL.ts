import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * Fully deterministic: the whole answer is visible in the source's
 * verification config.
 *
 * The signature in the prompt is base64 and the header is non-standard, so the
 * agent has to read both off the sample rather than assume defaults. Getting
 * either wrong means verification rejects every request, and the symptom looks
 * like the provider misbehaving rather than a misconfiguration.
 */
const scorer: ToolScorer = async (ctx) => {
  const source = await findVerifiedSource(ctx);
  if (!source) {
    return {
      passed: false,
      checks: [
        { name: 'created a source with verification configured', passed: false },
      ],
    };
  }

  const config = (source.verification ?? {}) as Record<string, unknown>;
  const hmac = (config.configs ?? config) as Record<string, unknown>;

  const checks: CheckResult[] = [
    { name: 'created a source with verification configured', passed: true },
    check('algorithm is sha256', hmac.algorithm, 'sha256'),
    // The sample signature is base64. Choosing hex is the common wrong answer
    // and fails every request.
    check('encoding is base64', hmac.encoding, 'base64'),
    // The provider uses a non-standard header, so a default guess is wrong.
    check(
      'header key matches the provider',
      String(hmac.header_key ?? '').toLowerCase(),
      'x-acme-signature'
    ),
    check(
      'shared secret carried over',
      hmac.webhook_secret_key,
      'acme_whsec_5f2b91'
    ),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

function check(name: string, actual: unknown, expected: unknown): CheckResult {
  const passed = actual === expected;
  return {
    name,
    passed,
    notes: passed ? undefined : `expected ${String(expected)}, got ${String(actual)}`,
  };
}

async function findVerifiedSource(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/sources?limit=100'
  );
  return (models ?? []).find((s) => s.verification);
}
