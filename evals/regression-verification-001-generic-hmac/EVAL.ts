import { createHmac } from 'node:crypto';
import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

const SECRET = 'acme_whsec_5f2b91';
const HEADER = 'X-Acme-Signature';
/**
 * The example request in PROMPT.md carries a real signature: base64 HMAC-SHA256
 * of exactly the body shown, under exactly the secret shown. Keep it that way if
 * either changes.
 *
 * It was invented before, and an agent that checked the example against the
 * sentence describing it would have found them contradicting each other, with
 * nothing to say which was authoritative — and a wrong reading of the scheme is
 * the failure this scenario exists to catch. The prose was right and the example
 * was noise; a scenario should not make thoroughness a liability.
 */
const EXAMPLE_BODY = JSON.stringify({ order_id: 'ord_4821', total: 1250 });

/**
 * Scored functionally, by signing a request the way the provider would and
 * seeing whether Hookdeck accepts it.
 *
 * Config inspection is not an option: the API redacts `config.auth` on read,
 * so the algorithm, encoding and header key are write-only. That turns out to
 * be the better scorer anyway. It checks that verification *works* rather than
 * that the configuration matches a shape we assumed, so an agent that reaches
 * a correct setup by a route we did not anticipate still passes, and one that
 * writes plausible-looking config that rejects real traffic still fails.
 */
const scorer: ToolScorer = async (ctx) => {
  const source = await findHmacSource(ctx);
  if (!source) {
    return {
      passed: false,
      checks: [
        {
          name: 'created a source using HMAC verification',
          passed: false,
          notes: 'no source with config.auth_type === "HMAC"',
        },
      ],
    };
  }

  const url = String(source.url ?? '');
  const body = EXAMPLE_BODY;
  const signature = createHmac('sha256', SECRET).update(body).digest('base64');

  const accepted = await post(url, body, { [HEADER]: signature });
  const rejected = await post(url, body, { [HEADER]: 'not-a-valid-signature' });

  const checks: CheckResult[] = [
    { name: 'created a source using HMAC verification', passed: true },
    {
      // Wrong algorithm, wrong encoding, or wrong header all land here: the
      // provider's real requests would be turned away.
      name: 'accepts a correctly signed request',
      passed: accepted === 200,
      notes: `expected 200, got ${accepted}`,
    },
    {
      // Guards the opposite failure: verification configured so loosely that
      // it lets anything through, which passes the first check on its own.
      name: 'rejects an incorrectly signed request',
      passed: rejected === 401,
      notes: `expected 401, got ${rejected}`,
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function post(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return res.status;
}

async function findHmacSource(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/sources?limit=100'
  );
  return (models ?? []).find(
    (s) =>
      (s.config as { auth_type?: string } | undefined)?.auth_type === 'HMAC'
  );
}
