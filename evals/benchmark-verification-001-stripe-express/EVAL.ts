import { createHmac } from 'node:crypto';
import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';
import { waitForOrLast } from '@hookdeck-evals/hookdeck';

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
/**
 * Also in `local/.env`, which is how the agent gets it: the developer in this
 * scenario has their Stripe endpoint secret already, and without it no agent can
 * set `webhook_secret_key` on the source, so "the source accepts a genuine
 * Stripe signature" is unpassable however good the agent is.
 *
 * That file is force-added. The root `.gitignore` has a bare `.env`, which git
 * matches at any depth, so `local/.env` was silently untracked: every run on the
 * machine that wrote it passed, and a fresh checkout — CI — would have failed
 * this scenario for every agent, with a red check that reads like the agent
 * skipped verification. If it is ever recreated, `git add -f` it.
 */
const STRIPE_WEBHOOK_SECRET = 'whsec_51KzQmTestSecretForEvalsOnly0xA9';
const PORT = 3100;
/** Ingestion is not synchronous with the POST. */
/** Polling ceiling, not a sleep. Reached only when ingestion is genuinely
 *  slow or nothing arrives; a healthy run settles in a second or two. */
const INGEST_WAIT_MS = 45_000;
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
    ...(await checkSourceAcceptsStripe(ctx, String(source.url))),
    ...(await checkHandler(ctx, String(source.name ?? ''))),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * The Hookdeck half: does the source verify Stripe's signature.
 *
 * Both directions, against `/requests`, which records what arrived at the edge
 * and whether it passed verification. A source that accepts anything passes the
 * positive on its own, so the forged case is what proves verification is
 * actually configured.
 *
 * Deliberately says nothing about routing. An earlier version waited for an
 * `/events` row and failed a correct setup: the agent routed to a CLI
 * destination, which is the right answer for local development, and a CLI
 * destination with no connected session has its requests ignored rather than
 * queued, so no event exists once the agent's `hookdeck listen` has stopped.
 * Whether events reach a local process is `benchmark-localdev-001-listen-locally`,
 * and asserting it here made this scenario fail for a reason it is not about.
 */
async function checkSourceAcceptsStripe(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<CheckResult[]> {
  const names = [
    'the source accepts a genuine Stripe signature',
    'the source rejects a forged Stripe signature',
  ];
  const sentAt = new Date();
  const body = JSON.stringify({
    id: 'evt_test_checkout_completed',
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_a1b2c3', amount_total: 4200 } },
  });

  await postToSource(sourceUrl, body, stripeSignature(body));
  await postToSource(sourceUrl, body, 't=1,v1=deadbeef');

  // Newest first and explicitly so: this project accumulates requests across
  // every run forever (they cannot be deleted), so an unordered or
  // oldest-first `limit=100` risks never reaching the two just sent once the
  // project's history passes a hundred rows. Same hazard BM3 hit on `/events`.
  // Poll rather than sleep. Ingestion is asynchronous and `verified` is set
  // after the request lands, so a fixed wait scores whatever happened to have
  // arrived: this check failed a correct agent whenever the platform was slower
  // than the sleep, and which cell lost depended on when its job ran. Both
  // requests are expected, so wait for both rather than for the first.
  const mine = await waitForOrLast(
    async () => {
      const { models } = await ctx.api<{
        models?: { created_at?: string; verified?: boolean }[];
      }>('GET', '/requests?limit=100&order_by=created_at&dir=desc');
      return (models ?? []).filter(
        (r) => r.created_at && new Date(r.created_at) >= sentAt
      );
    },
    (rows) =>
      rows.some((r) => r.verified === true) &&
      rows.some((r) => r.verified === false),
    {
      timeoutMs: INGEST_WAIT_MS,
      description: 'both probe requests to be recorded and verified',
    }
  );

  return [
    {
      name: names[0],
      passed: mine.some((r) => r.verified === true),
      notes: mine.length
        ? undefined
        : 'no request recorded at the source at all',
    },
    {
      name: names[1],
      passed: mine.some((r) => r.verified === false),
      notes: mine.some((r) => r.verified === false)
        ? undefined
        : 'a forged Stripe signature was accepted, so the source is not verifying',
    },
  ];
}

/** POST at the source's public URL, returning the status. */
async function postToSource(
  url: string,
  body: string,
  stripeSig: string
): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': stripeSig,
    },
    body,
  });
  return res.status;
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
async function checkHandler(
  ctx: ToolEvalContext,
  sourceName: string
): Promise<CheckResult[]> {
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
    // A realistic event, not a minimal one. Stripe events always carry
    // `data.object`, so a handler that reads `event.data.object` to do its work
    // is correct, and a probe body without it crashes that handler with a 500
    // and scores it as rejecting valid traffic. Send what Stripe sends.
    const body = JSON.stringify({
      id: 'evt_scored',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_scored',
          object: 'checkout.session',
          amount_total: 4200,
          currency: 'gbp',
          payment_status: 'paid',
        },
      },
    });
    const valid = await postToHandler(
      ctx,
      body,
      hookdeckSignature(body, secret),
      sourceName
    );
    const forged = await postToHandler(
      ctx,
      body,
      'bm90LWEtcmVhbC1zaWduYXR1cmU=',
      sourceName
    );

    // The handler's own output on failure. The sandbox is destroyed after
    // scoring, so a note pointing at a log inside it is a dead end by the time
    // anyone reads the result; a 500 says the handler crashed but not why.
    const log =
      valid === 200
        ? undefined
        : (
            await ctx.sandbox.exec(
              `tail -5 /tmp/handler.log 2>/dev/null || echo '(no handler log)'`
            )
          ).stdout
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 300);

    return [
      {
        name: names[0],
        passed: valid === 200,
        notes:
          valid === 200
            ? undefined
            : `expected 200, got ${valid || 'no response'}. handler said: ${log}`,
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
 *
 * The same argument extends past the signature to every header a real delivery
 * carries. Hookdeck forwards `x-hookdeck-eventid`, `x-hookdeck-source-name` and
 * `x-hookdeck-verified` alongside the signature, and a handler is entitled to
 * check them. gpt-5.6 wrote one that required the source name to match and an
 * event id to be present, which is defence in depth and correct, and a probe
 * that omitted them scored it as rejecting valid traffic. The scenario was
 * penalising the more thorough handler.
 */
async function postToHandler(
  ctx: ToolEvalContext,
  body: string,
  signature: string,
  sourceName: string
): Promise<number> {
  const result = await ctx.sandbox?.exec(
    `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:${PORT}/orders ` +
      `-H 'Content-Type: application/json' ` +
      `-H 'x-hookdeck-signature: ${signature}' ` +
      `-H 'x-hookdeck-verified: true' ` +
      `-H 'x-hookdeck-eventid: evt_scored_probe' ` +
      `-H 'x-hookdeck-source-name: ${sourceName}' ` +
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
