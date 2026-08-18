import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';
import { waitForOrLast } from '@hookdeck-evals/hookdeck';

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
/** Tunnel connect, then cloud delivery. Neither is synchronous with the POST,
 *  and both are polled: these are ceilings, not sleeps. */
const TUNNEL_BOOT_MS = 45_000;
const DELIVERY_WAIT_MS = 45_000;
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
  // Bound once: the polling closures below outlive the narrowing above.
  const sandbox = ctx.sandbox;

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

  // Stop anything the agent left running before starting our own pair. An agent
  // that verifies its work end to end leaves a tunnel and a server up, on its
  // own port and writing to its own log, and Hookdeck will happily deliver the
  // probe to that session instead of ours. The result is a scenario that fails
  // precisely because the agent did the job thoroughly, which is the worst
  // possible thing for a scorer to reward.
  await ctx.sandbox.exec(`pkill -f "hookdeck listen" || true`);
  await ctx.sandbox.exec(`pkill -f "node .*server" || true`);
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
  // `--output compact` is not optional here. The default is an interactive
  // Bubble Tea UI that opens /dev/tty and dies with "could not open a new TTY"
  // anywhere without a terminal, which is every non-interactive context: this
  // scorer, CI, a Docker entrypoint, and an agent's own shell. The agent found
  // this and used the flag; the scorer did not, and read the resulting silence
  // as an agent that had not set the tunnel up.
  const listen =
    `hookdeck listen ${PORT} ${shellArg(sourceName)} --output compact` +
    (path && path !== '/' ? ` --path ${shellArg(path)}` : '');
  await ctx.sandbox.exec(
    `nohup ${listen} > /tmp/bm6-listen.log 2>&1 & echo started`,
    {
      timeoutMs: 120_000,
    }
  );

  // Wait for the tunnel to announce itself rather than assuming it connects
  // within a fixed boot time. This one is not merely slow when it loses the
  // race, it is silent: a CLI destination with no connected session has its
  // requests ignored rather than queued, so a probe posted before the tunnel is
  // up is discarded outright and the retry that would have saved it never
  // happens. The agent then fails a check for the scorer's timing.
  //
  // Matched permissively, and not fatal if it never matches. The readiness line
  // is CLI output, not an API contract, and it has changed wording before;
  // asserting on an exact string would convert a reworded banner into a failed
  // scenario for every agent at once. If nothing matches we post anyway and let
  // the delivery check be the judge, which is the pre-existing behaviour.
  await waitForOrLast(
    async () => {
      const log = await sandbox.exec(
        `cat /tmp/bm6-listen.log 2>/dev/null || true`
      );
      return log.stdout;
    },
    (out) => /ready|connected|listening|https?:\/\//i.test(out),
    {
      timeoutMs: TUNNEL_BOOT_MS,
      description: 'the hookdeck listen tunnel to connect',
    }
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

    // Poll the log the local service writes to. Delivery crosses the cloud and
    // then the tunnel, so it is slower than a plain ingest and more variable.
    const arrived = await waitForOrLast(
      async () => {
        const received = await sandbox.exec(
          `grep -c evt_bm6_probe ${RECEIVED_LOG} 2>/dev/null || echo 0`
        );
        return Number.parseInt(received.stdout.trim(), 10) > 0;
      },
      (seen) => seen,
      {
        timeoutMs: DELIVERY_WAIT_MS,
        description: 'the probe to reach the local service',
      }
    );

    if (arrived) return { name, passed: true };

    // Carry the tunnel's own output into the result. The sandbox is torn down
    // after scoring, so a note pointing at a log file inside it is a dead end:
    // by the time anyone reads the failure, the only copy is gone.
    const tunnelLog = await ctx.sandbox.exec(
      `tail -5 /tmp/bm6-listen.log 2>/dev/null || echo '(no tunnel log)'`
    );
    return {
      name,
      passed: false,
      notes: `the probe never reached the service. tunnel said: ${tunnelLog.stdout.trim().replace(/\s+/g, ' ').slice(0, 300)}`,
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
