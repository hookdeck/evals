import { createHmac } from 'node:crypto';
import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM1, the vendor golden path: Stripe events reach an Express handler, and the
 * handler turns away anything that did not come through Hookdeck.
 *
 * The trap this scenario exists to catch is which signature the handler
 * verifies. Hookdeck verifies Stripe's signature at the source and then signs
 * the forwarded request itself, so the handler's job is to verify
 * `x-hookdeck-signature` (HMAC SHA-256, base64) and not Stripe's. An agent
 * working from memory tends to reach for Stripe's SDK verification, or to use
 * hex where the encoding is base64, or to parse the JSON body before verifying
 * and lose the raw bytes it needed. All three fail here, and all three are
 * covered in the documentation, which is what makes this worth measuring
 * against a skills-equipped run.
 *
 * Scored by sending real traffic rather than by reading configuration, in two
 * halves that fail independently.
 *
 * The Hookdeck half signs a request the way Stripe would, using the secret in
 * `local/.env`, and checks the source accepts it and records an event. The
 * handler half starts what the agent wrote, signs with the project's signing
 * secret from `HOOKDECK_WEBHOOK_SECRET`, and posts straight at it.
 *
 * The first version scored the handler through the real delivery path, which
 * meant Hookdeck had to reach localhost, which meant a live `hookdeck listen`
 * tunnel at scoring time. That failed for a reason that had nothing to do with
 * the agent: asked to set this up, it wrote the handler, configured the
 * connection, and documented `npm start` as the developer's step, which is
 * correct. The deliverable is code and configuration, not a running process. So
 * the scorer runs the process itself, and the tunnel belongs to the local-dev
 * scenario that is actually about tunnels.
 */
const STRIPE_WEBHOOK_SECRET = 'whsec_51KzQmTestSecretForEvalsOnly0xA9';
const PORT = 3100;
/** Ingestion is not synchronous with the POST. */
const INGEST_WAIT_MS = 8_000;
/** Long enough for `npm install` on a cold workspace. */
const BOOT_TIMEOUT_MS = 180_000;

const scorer: ToolScorer = async (ctx) => {
  const source = await findStripeSource(ctx);
  if (!source?.url) {
    return {
      passed: false,
      checks: [
        {
          name: 'created a Stripe source',
          passed: false,
          notes: 'no source with type "STRIPE"',
        },
      ],
    };
  }

  const checks: CheckResult[] = [
    { name: 'created a Stripe source', passed: true },
    await checkSourceAcceptsStripe(ctx, String(source.url)),
    ...(await checkHandler(ctx)),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * The Hookdeck half: does a genuine Stripe request get in.
 *
 * Proves the agent configured the source's verification with the secret the
 * developer already had, rather than creating a source that accepts anything.
 * Nothing here depends on where the connection points.
 */
async function checkSourceAcceptsStripe(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<CheckResult> {
  const sentAt = new Date();
  const body = JSON.stringify({
    id: 'evt_test_checkout_completed',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_a1b2c3', amount_total: 4200 } },
  });

  const res = await fetch(sourceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': stripeSignature(body),
    },
    body,
  });

  if (!res.ok) {
    return {
      name: 'a genuine Stripe request is accepted at the source',
      passed: false,
      notes: `source returned ${res.status}; the verification secret is probably not the one in local/.env`,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, INGEST_WAIT_MS));
  const { models } = await ctx.api<{ models?: { created_at?: string }[] }>(
    'GET',
    '/events?limit=100&order_by=created_at&dir=desc'
  );
  const arrived = (models ?? []).some(
    (e) => e.created_at && new Date(e.created_at) >= sentAt
  );

  return {
    name: 'a genuine Stripe request is accepted at the source',
    passed: arrived,
    notes: arrived
      ? undefined
      : 'accepted at the edge but no event was recorded',
  };
}

/**
 * The handler half: run what the agent wrote and sign requests at it.
 *
 * The scorer owns the process. The agent's job was to write the handler and
 * document how to start it, not to leave a server running, so scoring starts it
 * on a port of the scorer's choosing and stops it afterwards.
 *
 * Both directions are checked because either alone is passable by a broken
 * handler: one that rejects everything passes the negative, and one that
 * verifies nothing passes the positive.
 */
async function checkHandler(ctx: ToolEvalContext): Promise<CheckResult[]> {
  const names = [
    'the handler accepts a genuine Hookdeck signature',
    'the handler rejects a forged signature',
  ];
  const failBoth = (notes: string) =>
    names.map((name) => ({ name, passed: false, notes }));

  if (!ctx.sandbox) return failBoth('no sandbox to run the handler in');
  const secret = process.env.HOOKDECK_WEBHOOK_SECRET;
  if (!secret) {
    return failBoth(
      'HOOKDECK_WEBHOOK_SECRET is not set, so a genuine signature cannot be produced'
    );
  }

  const dir = await handlerDir(ctx);
  if (!dir) return failBoth('no package.json found in the workspace');

  await ctx.sandbox.exec(
    `cd ${dir} && npm install --no-audit --no-fund 2>&1 | tail -2`,
    { timeoutMs: BOOT_TIMEOUT_MS }
  );
  // Both secrets are exported rather than left to the app's own `.env`, and
  // that is the difference between scoring verification and scoring config
  // loading. An agent typically scaffolds its app in a subdirectory with a
  // fresh `.env` full of placeholders, having correctly reported it cannot
  // fetch the real values. dotenv does not override variables already in the
  // environment, so the Hookdeck secret we inject wins while the Stripe one
  // stays a placeholder, and a correct handler fails on the second layer only.
  // Supplying both is the scorer playing the developer who has them.
  //
  // Backgrounded and detached: the scorer needs the shell back.
  const env =
    `PORT=${PORT} ` +
    `STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET} ` +
    `HOOKDECK_WEBHOOK_SECRET=${secret}`;
  await ctx.sandbox.exec(
    `cd ${dir} && ${env} nohup npm start > /tmp/handler.log 2>&1 & sleep 6; echo started`,
    { timeoutMs: 60_000 }
  );

  try {
    const body = JSON.stringify({
      id: 'evt_scored',
      type: 'checkout.session.completed',
    });
    const valid = await post(ctx, body, hookdeckSignature(body, secret));
    const forged = await post(ctx, body, 'bm90LWEtcmVhbC1zaWduYXR1cmU=');

    return [
      {
        name: names[0],
        passed: valid === 200,
        notes: `expected 200, got ${valid || 'no response (handler did not start; see /tmp/handler.log)'}`,
      },
      {
        name: names[1],
        // A 4xx. A connection failure is not a pass: nothing was there to reject.
        passed: forged >= 400 && forged < 500,
        notes: `expected a 4xx, got ${forged || 'no response'}`,
      },
    ];
  } finally {
    await ctx.sandbox.exec(`pkill -f "node .*server" || true`);
  }
}

/**
 * POST at the handler from inside the sandbox, returning the status code.
 *
 * Carries the provider's signature as well as Hookdeck's, because that is what
 * a real delivery looks like: Hookdeck forwards the original request headers
 * and adds its own. Sending only `x-hookdeck-signature` fails a handler that
 * checks both, and checking both is what the documentation recommends and what
 * an agent following it builds. Scored a correct handler as broken until the
 * status codes gave it away: 401 for a forged Hookdeck signature, 400 for a
 * good one with no Stripe signature behind it.
 */
async function post(
  ctx: ToolEvalContext,
  body: string,
  signature: string
): Promise<number> {
  const result = await ctx.sandbox?.exec(
    `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:${PORT}/orders ` +
      `-H 'Content-Type: application/json' ` +
      `-H 'x-hookdeck-signature: ${signature}' ` +
      `-H 'x-hookdeck-verified: true' ` +
      `-H 'Stripe-Signature: ${stripeSignature(body)}' ` +
      `--data-binary '${body}'`
  );
  return Number.parseInt(result?.stdout.trim() ?? '', 10) || 0;
}

/** Hookdeck's scheme: HMAC SHA-256 over the raw body, base64. Not hex. */
function hookdeckSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

/** Where the agent put the app. It may have nested it rather than used the root. */
async function handlerDir(ctx: ToolEvalContext): Promise<string | undefined> {
  // Newest first. An agent often scaffolds its app in a subdirectory rather
  // than editing the seeded skeleton in place, leaving two `package.json`
  // files, and `find` returns them in no useful order. The agent's work is
  // always the more recently written of the two; taking whichever came first
  // risks starting the seeded stub, which verifies nothing and would score as
  // a handler that accepts anything.
  const found = await ctx.sandbox?.exec(
    `find . -maxdepth 3 -name package.json -not -path '*/node_modules/*' ` +
      `-printf '%T@ %p\\n' | sort -rn | head -1 | cut -d' ' -f2-`
  );
  const path = found?.stdout.trim();
  return path ? path.replace(/\/package\.json$/, '') : undefined;
}

/** Stripe's scheme: `t=<unix>,v1=<hex hmac sha256 of "t.body">`. Hex, not base64. */
function stripeSignature(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function findStripeSource(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/sources?limit=100'
  );
  return (models ?? []).find((s) => s.type === 'STRIPE');
}
