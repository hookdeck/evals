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
 * Scored by sending real traffic rather than by reading configuration. The
 * scorer signs a request the way Stripe would, using the secret seeded in
 * `local/.env` so both sides know it, and then asks Hookdeck what the delivery
 * attempt returned. That is the only way to send genuinely Hookdeck-signed
 * traffic at the handler: the signing secret Hookdeck uses is not exposed on
 * the API, so a scorer cannot forge one. Going through the real delivery path
 * needs no secret and tests the whole chain.
 *
 * The negative needs no secret either, because producing an invalid signature
 * is easy. It is checked directly against the handler, in the sandbox.
 */
const STRIPE_WEBHOOK_SECRET = 'whsec_51KzQmTestSecretForEvalsOnly0xA9';
const DEFAULT_PORT = 3000;
/** Rule evaluation and delivery are not synchronous with the POST. */
const DELIVERY_WAIT_MS = 15_000;

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
    ...(await checkDeliverySucceeds(ctx, String(source.url))),
    await checkRejectsForgedSignature(ctx),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * The positive path, end to end: sign as Stripe, post at the source, and read
 * back what the handler answered Hookdeck.
 *
 * A 200 means the handler verified a real `x-hookdeck-signature` and accepted
 * it. Anything else means it turned away traffic it should have taken, which is
 * the failure a developer would see as "my webhooks stopped working".
 */
async function checkDeliverySucceeds(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<CheckResult[]> {
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
    return [
      {
        name: 'a genuine Stripe request is accepted at the source',
        passed: false,
        notes: `source returned ${res.status}; the Stripe verification secret is probably not the one in local/.env`,
      },
      { name: 'the handler accepted the delivered event', passed: false },
    ];
  }

  await new Promise((resolve) => setTimeout(resolve, DELIVERY_WAIT_MS));
  const attempt = await attemptForProbe(ctx, sentAt);

  return [
    {
      name: 'a genuine Stripe request is accepted at the source',
      passed: true,
    },
    {
      name: 'the handler accepted the delivered event',
      passed: attempt?.response_status === 200,
      notes: attempt
        ? `delivery attempt returned ${attempt.response_status}, expected 200`
        : 'no delivery attempt recorded: nothing was listening, so the event was never delivered',
    },
  ];
}

/**
 * The attempt for the event this scorer just sent, found by event id rather
 * than by time.
 *
 * `/attempts` takes an `event_id` filter and has no time filter, and the
 * project is shared across runs, so picking "the most recent attempt" would
 * eventually read a different run's delivery and score this one on it. Find our
 * event first, then ask only about that event's attempts.
 */
async function attemptForProbe(
  ctx: ToolEvalContext,
  sentAt: Date
): Promise<{ response_status?: number } | undefined> {
  const { models: events } = await ctx.api<{
    models?: { id?: string; created_at?: string }[];
  }>('GET', '/events?limit=100&order_by=created_at&dir=desc');

  const event = (events ?? []).find(
    (e) => e.created_at && new Date(e.created_at) >= sentAt
  );
  if (!event?.id) return undefined;

  const { models: attempts } = await ctx.api<{
    models?: { response_status?: number }[];
  }>('GET', `/attempts?event_id=${encodeURIComponent(event.id)}&limit=100`);

  return (attempts ?? [])[0];
}

/**
 * The negative, checked straight at the handler rather than through Hookdeck.
 *
 * Guards the failure the positive check cannot see: a handler that returns 200
 * to everything passes on delivery alone and verifies nothing. Runs in the
 * sandbox because the handler is on localhost inside the container.
 */
async function checkRejectsForgedSignature(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const name = 'the handler rejects a forged signature';
  if (!ctx.sandbox) {
    return { name, passed: false, notes: 'no sandbox to reach the handler' };
  }

  const port = await handlerPort(ctx);
  const result = await ctx.sandbox.exec(
    `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:${port}/orders ` +
      `-H 'Content-Type: application/json' ` +
      `-H 'x-hookdeck-signature: bm90LWEtcmVhbC1zaWduYXR1cmU=' ` +
      `-d '{"id":"evt_forged","type":"checkout.session.completed"}'`
  );

  const status = Number.parseInt(result.stdout.trim(), 10);
  return {
    name,
    // 2xx means it took the request on trust. A connection failure (000) is not
    // a pass either: it means nothing was running to reject anything.
    passed: status >= 400 && status < 500,
    notes: `expected a 4xx, got ${result.stdout.trim() || 'no response'}`,
  };
}

/** Stripe's scheme: `t=<unix>,v1=<hex hmac sha256 of "t.body">`. Hex, not base64. */
function stripeSignature(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

/**
 * The port the handler is on. The seeded app reads `PORT` and defaults to 3000,
 * but an agent may have moved it, and `hookdeck listen <port>` records the port
 * it was pointed at, so prefer what the CLI destination says.
 */
async function handlerPort(ctx: ToolEvalContext): Promise<number> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/destinations?limit=100'
  );
  for (const destination of models ?? []) {
    const config = destination.config as { port?: number } | undefined;
    if (typeof config?.port === 'number') return config.port;
  }
  return DEFAULT_PORT;
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
