import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM6, the activation motion: get real events arriving at code running on the
 * developer's own machine.
 *
 * The trap is that a local address is not reachable from Hookdeck's cloud, so
 * the obvious-looking answer fails. An HTTP destination pointing at
 * `http://localhost:4000` is accepted by the API, looks correct in the
 * dashboard, and never delivers anything. The route that works is a CLI
 * destination with `hookdeck listen` tunnelling to the port. The skill's
 * `03-listen.md` calls the HTTP-to-localhost pattern out explicitly as the
 * thing not to do, which is what should make this discriminate between an
 * agent that read the documentation and one that assumed.
 *
 * Deliberately smaller than BM1: an existing handler, no provider, no
 * signatures, no secrets. Just delivery. BM1 bundles this with provider setup
 * and handler code, and when it fails you cannot tell which part broke.
 *
 * Scored by watching an event arrive. The seeded service appends every delivery
 * to a log file, so the check is whether a line turns up in it after the scorer
 * posts at the source. Nothing about the shape of the configuration is
 * asserted: an agent that reaches working local delivery by a route we did not
 * anticipate passes, and one whose configuration looks right but delivers
 * nothing fails.
 *
 * The scorer owns both processes. The agent's deliverable is a working setup
 * and the instructions to run it, not a pair of servers left running, so
 * scoring starts the app, starts the tunnel, exercises it, and stops both.
 */
const PORT = 4100;
const RECEIVED_LOG = '/tmp/bm6-received.log';
/** Tunnel connect, then cloud delivery. Neither is synchronous with the POST. */
const TUNNEL_BOOT_MS = 12_000;
const DELIVERY_WAIT_MS = 15_000;
/** Long enough for `npm install` on a cold workspace. */
const INSTALL_TIMEOUT_MS = 180_000;

const scorer: ToolScorer = async (ctx) => {
  const source = await findSource(ctx);
  if (!source?.url) {
    return {
      passed: false,
      checks: [{ name: 'created a source to receive events', passed: false }],
    };
  }

  const checks: CheckResult[] = [
    { name: 'created a source to receive events', passed: true },
    await checkRoutedForLocalDelivery(ctx),
    await checkEventArrivesLocally(ctx, String(source.url)),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Is the connection routed somewhere a local process can receive from.
 *
 * A CLI destination is the supported answer. This is the one structural check
 * in the scenario, and it earns its place by catching the specific mistake the
 * scenario is about: an HTTP destination pointing at localhost is accepted by
 * the API and silently undeliverable, so without this a broken setup and an
 * absent one look identical in the delivery check below.
 */
async function checkRoutedForLocalDelivery(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const destination = await findCliDestination(ctx);
  const httpToLocalhost = await findLocalhostHttpDestination(ctx);

  return {
    name: 'routed to a CLI destination rather than an unreachable URL',
    passed: Boolean(destination),
    notes: destination
      ? undefined
      : httpToLocalhost
        ? 'found an HTTP destination pointing at localhost, which Hookdeck cannot reach from the cloud'
        : 'no CLI destination found',
  };
}

/**
 * The check the scenario exists for: does an event posted at the source reach
 * the process running locally.
 */
async function checkEventArrivesLocally(
  ctx: ToolEvalContext,
  sourceUrl: string
): Promise<CheckResult> {
  const name = 'an event posted at the source arrives at the local service';
  if (!ctx.sandbox) {
    return { name, passed: false, notes: 'no sandbox to run the service in' };
  }

  const dir = await serviceDir(ctx);
  if (!dir) {
    return {
      name,
      passed: false,
      notes: 'no package.json found in the workspace',
    };
  }

  const destination = await findCliDestination(ctx);
  const path = String(
    (destination?.config as { path?: string } | undefined)?.path ?? ''
  );
  const source = await findSource(ctx);
  const sourceName = String(source?.name ?? '');

  await ctx.sandbox.exec(
    `cd ${dir} && npm install --no-audit --no-fund 2>&1 | tail -2`,
    { timeoutMs: INSTALL_TIMEOUT_MS }
  );
  await ctx.sandbox.exec(`rm -f ${RECEIVED_LOG}`);
  await ctx.sandbox.exec(
    `cd ${dir} && PORT=${PORT} RECEIVED_LOG=${RECEIVED_LOG} ` +
      `nohup npm start > /tmp/bm6-app.log 2>&1 & sleep 5; echo started`,
    { timeoutMs: 60_000 }
  );

  // `hookdeck listen` is interactive by default; `hookdeck ci` authenticates
  // from the key already in the environment so the tunnel can start unattended.
  await ctx.sandbox.exec(
    `hookdeck ci --api-key "$HOOKDECK_API_KEY" 2>&1 | tail -1`,
    { timeoutMs: 60_000 }
  );
  const listen =
    `hookdeck listen ${PORT} ${shellArg(sourceName)}` +
    (path && path !== '/' ? ` --path ${shellArg(path)}` : '');
  await ctx.sandbox.exec(
    `nohup ${listen} > /tmp/bm6-listen.log 2>&1 & sleep ${TUNNEL_BOOT_MS / 1000}; echo listening`,
    { timeoutMs: 120_000 }
  );

  try {
    await fetch(sourceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'evt_bm6_probe',
        kind: 'notification.created',
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_WAIT_MS));

    const received = await ctx.sandbox.exec(
      `grep -c evt_bm6_probe ${RECEIVED_LOG} 2>/dev/null || echo 0`
    );
    const arrived = Number.parseInt(received.stdout.trim(), 10) > 0;

    return {
      name,
      passed: arrived,
      notes: arrived
        ? undefined
        : 'the probe event never reached the service; see /tmp/bm6-listen.log for whether the tunnel connected',
    };
  } finally {
    await ctx.sandbox.exec(`pkill -f "hookdeck listen" || true`);
    await ctx.sandbox.exec(`pkill -f "node .*server" || true`);
  }
}

/** Single-quote for the shell, closing and reopening around any quote. */
function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

async function findCliDestination(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/destinations?limit=100'
  );
  return (models ?? []).find((d) => d.type === 'CLI');
}

async function findLocalhostHttpDestination(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/destinations?limit=100'
  );
  return (models ?? []).find((d) => {
    const url = String((d.config as { url?: string } | undefined)?.url ?? '');
    return /localhost|127\.0\.0\.1/.test(url);
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
