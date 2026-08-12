import { createHmac } from 'node:crypto';
import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM5, provider webhooks: the same shape as BM1 against a provider that is not
 * in every model's memory.
 *
 * BM1 uses Stripe, whose signature scheme every model has seen thousands of
 * times, and both frontier configurations get it right without looking. This
 * one uses ElevenLabs, which Hookdeck supports as a source type but which an
 * agent is far less likely to recall correctly. The task is identical: let the
 * provider's callbacks in, and make the local service accept only what came
 * through the gateway.
 *
 * That difference is the measurement. If an agent that reads the documentation
 * passes both and an agent working from memory passes Stripe and fails this,
 * the pair says something neither says alone, and it is the closest thing the
 * suite has to a controlled comparison.
 *
 * Scored the way BM1 is, because that design survived seven runs of being
 * wrong. Source verification is checked in both directions against `/requests`,
 * since a source that accepts everything passes the positive on its own. The
 * handler is started by the scorer, given the secrets the developer would hold,
 * and probed with a genuine and a forged Hookdeck signature. Nothing asserts on
 * routing: a CLI destination with no session ignores requests rather than
 * queueing them, which failed BM1 for a reason that had nothing to do with it.
 */
const ELEVENLABS_SECRET = 'wsec_e11_7Qm2vB9xLpTestOnly';
const PORT = 5100;
const INGEST_WAIT_MS = 8_000;
const BOOT_TIMEOUT_MS = 180_000;

const scorer: ToolScorer = async (ctx) => {
  const source = await findElevenLabsSource(ctx);
  if (!source?.url) {
    return {
      passed: false,
      checks: [
        {
          name: 'created an ElevenLabs source',
          passed: false,
          notes: 'no source with type "ELEVENLABS"',
        },
      ],
    };
  }

  const checks: CheckResult[] = [
    { name: 'created an ElevenLabs source', passed: true },
    ...(await checkSourceVerifies(ctx, String(source.url))),
    ...(await checkHandler(ctx)),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function checkSourceVerifies(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<CheckResult[]> {
  const sentAt = new Date();
  const body = JSON.stringify({
    type: 'speech_to_text.completed',
    data: { request_id: 'req_88f2', text: 'the quick brown fox' },
  });

  await postToSource(sourceUrl, body, elevenLabsSignature(body));
  await postToSource(sourceUrl, body, 't=1,v0=deadbeef');
  await new Promise((resolve) => setTimeout(resolve, INGEST_WAIT_MS));

  const { models } = await ctx.api<{
    models?: { created_at?: string; verified?: boolean }[];
  }>('GET', '/requests?limit=100');
  const mine = (models ?? []).filter(
    (r) => r.created_at && new Date(r.created_at) >= sentAt
  );

  return [
    {
      name: 'the source accepts a genuine ElevenLabs signature',
      passed: mine.some((r) => r.verified === true),
      notes: mine.length ? undefined : 'no request reached the source at all',
    },
    {
      name: 'the source rejects a forged ElevenLabs signature',
      passed: mine.some((r) => r.verified === false),
      notes: mine.some((r) => r.verified === false)
        ? undefined
        : 'a forged signature was accepted, so the source is not verifying',
    },
  ];
}

async function checkHandler(ctx: ToolEvalContext): Promise<CheckResult[]> {
  const names = [
    'the service accepts a genuine Hookdeck signature',
    'the service rejects a forged signature',
  ];
  const failBoth = (notes: string) =>
    names.map((name) => ({ name, passed: false, notes }));

  if (!ctx.sandbox) return failBoth('no sandbox to run the service in');
  const secret = process.env.HOOKDECK_WEBHOOK_SECRET;
  if (!secret) return failBoth('HOOKDECK_WEBHOOK_SECRET is not set');

  const dir = await serviceDir(ctx);
  if (!dir) return failBoth('no package.json found in the workspace');

  await ctx.sandbox.exec(
    `cd ${dir} && npm install --no-audit --no-fund 2>&1 | tail -2`,
    { timeoutMs: BOOT_TIMEOUT_MS }
  );
  await ctx.sandbox.exec(`pkill -f "node .*server" || true`);
  // Both secrets exported, because an agent scaffolding its own app writes a
  // `.env` of placeholders and dotenv will not override what is already set.
  await ctx.sandbox.exec(
    `cd ${dir} && PORT=${PORT} ELEVENLABS_WEBHOOK_SECRET=${ELEVENLABS_SECRET} ` +
      `HOOKDECK_WEBHOOK_SECRET=${secret} nohup npm start > /tmp/bm5.log 2>&1 & sleep 6; echo started`,
    { timeoutMs: 60_000 }
  );

  try {
    const body = JSON.stringify({
      type: 'speech_to_text.completed',
      data: { request_id: 'req_scored', text: 'hello' },
    });
    const valid = await postToService(
      ctx,
      body,
      hookdeckSignature(body, secret)
    );
    const forged = await postToService(ctx, body, 'bm90LWEtc2lnbmF0dXJl');

    const log =
      valid === 200
        ? undefined
        : (
            await ctx.sandbox.exec(
              `tail -5 /tmp/bm5.log 2>/dev/null || echo '(no log)'`
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
            : `expected 200, got ${valid || 'no response'}. service said: ${log}`,
      },
      {
        name: names[1],
        passed: forged >= 400 && forged < 500,
        notes: `expected a 4xx, got ${forged || 'no response'}`,
      },
    ];
  } finally {
    await ctx.sandbox.exec(`pkill -f "node .*server" || true`);
  }
}

/** ElevenLabs signs as `t=<unix>,v0=<hex hmac sha256 of "t.body">`. */
function elevenLabsSignature(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', ELEVENLABS_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v0=${signature}`;
}

/** Hookdeck's scheme: HMAC SHA-256 over the raw body, base64. */
function hookdeckSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

async function postToSource(
  url: string,
  body: string,
  signature: string
): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ElevenLabs-Signature': signature,
    },
    body,
  });
}

async function postToService(
  ctx: ToolEvalContext,
  body: string,
  signature: string
): Promise<number> {
  const result = await ctx.sandbox?.exec(
    `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:${PORT}/transcripts ` +
      `-H 'Content-Type: application/json' ` +
      `-H 'x-hookdeck-signature: ${signature}' ` +
      `-H 'x-hookdeck-verified: true' ` +
      `-H 'ElevenLabs-Signature: ${elevenLabsSignature(body)}' ` +
      `--data-binary '${body}'`
  );
  return Number.parseInt(result?.stdout.trim() ?? '', 10) || 0;
}

/** Newest first: an agent may scaffold rather than edit the seeded service. */
async function serviceDir(ctx: ToolEvalContext): Promise<string | undefined> {
  const found = await ctx.sandbox?.exec(
    `find . -maxdepth 3 -name package.json -not -path '*/node_modules/*' ` +
      `-printf '%T@ %p\\n' | sort -rn | head -1 | cut -d' ' -f2-`
  );
  const path = found?.stdout.trim();
  return path ? path.replace(/\/package\.json$/, '') : undefined;
}

async function findElevenLabsSource(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/sources?limit=100'
  );
  return (models ?? []).find((s) => s.type === 'ELEVENLABS');
}
