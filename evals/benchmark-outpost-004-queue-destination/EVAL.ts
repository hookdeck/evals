import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * Can an agent configure a destination that is not a webhook?
 *
 * Nearly all real Outpost traffic is webhooks, which is exactly why this is
 * worth scoring: an agent that has only ever seen the webhook shape reaches for
 * a `url` and a secret, and a queue is neither. It is a `type`, a set of config
 * fields whose names differ per provider, and `credentials` as a separate
 * object. Outpost rejects a malformed `queue_url` with a 422, so the failure is
 * loud if they get the field right and the value wrong — and silent if they put
 * the value in the wrong field.
 *
 * **This scores configuration, not delivery, and that is deliberate.** The
 * normal rule in this repo is to score behaviour where the API allows it, and
 * here it does not: proving delivery would need a real SQS queue, which means
 * cloud credentials inside the agent sandbox, an external dependency that can
 * fail a run for reasons no agent caused, and queue lifecycle in CI. Delivery
 * is already proven against webhook destinations by `outpost-001` and
 * `outpost-002`; what is untested is whether an agent can configure a
 * non-HTTP type at all.
 *
 * Measured rather than assumed: Outpost validates the *shape* of a destination
 * on create and not its reachability. A well-formed but entirely fictional
 * queue and key pair is accepted; `queue_url: "not-a-url"` is rejected with
 * `422 "config.queue_url failed pattern validation"`. So the API itself covers
 * the part a live queue would add least to.
 *
 * The trap is in the workspace note rather than the API. Acme want *orders* on
 * the queue and everything else unchanged, so deleting the webhook destination
 * — the obvious way to "stop sending their orders to the old endpoint" — also
 * stops their retry notifications, which nobody asked for. The correct move is
 * narrower than the obvious one.
 */

const TENANT = 'acme';
const OTHER_TENANT = 'globex';
/** Exactly what the workspace note gives them. */
const QUEUE_URL =
  'https://sqs.eu-west-1.amazonaws.com/402319887654/acme-order-events';
const OLD_ENDPOINT = 'https://mock.hookdeck.com/api/v1/acme/orders';
const ORDERS = 'orders';
/** The topic they never asked to change, and the one an over-broad fix breaks. */
const RETRIES = 'retries';

interface Destination {
  id?: string;
  type?: string;
  topics?: string[];
  config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  disabled_at?: string | null;
}

const scorer: ToolScorer = async (ctx) => {
  if (!ctx.outpost) {
    throw new Error(
      'no Outpost client, but this scenario declares `requires: [outpost]` ' +
        'and should have been skipped rather than scored'
    );
  }

  const destinations = await listDestinations(ctx, TENANT);
  const queues = destinations.filter(
    (d) => normalise(d.config?.queue_url) === normalise(QUEUE_URL)
  );
  const webhooks = destinations.filter(
    (d) => normalise(d.config?.url) === normalise(OLD_ENDPOINT)
  );

  // An agent that did nothing scores zero, not two out of six.
  //
  // Both negative checks — that the retries still reach the old endpoint, and
  // that the other customer was left alone — are satisfied by the untouched
  // seed. So a run that never acted used to report `2/6`, which reads as
  // partial progress and is really no progress: it is the shape a crashed cell
  // wears, and one did exactly that on 21 August before being spotted.
  //
  // The verdict was never wrong, since `passed` is the conjunction and the four
  // positive checks need real work. It is the per-check count that misleads
  // anyone reading the detail — including us, triaging a run.
  //
  // So when nothing has changed at all, say that in one line instead of
  // awarding marks for leaving things alone.
  const untouched =
    queues.length === 0 &&
    webhooks.some(
      (d) => !d.disabled_at && subscribes(d, ORDERS) && subscribes(d, RETRIES)
    );

  if (untouched) {
    return {
      passed: false,
      checks: [
        {
          name: 'their orders are delivered to the queue they gave us',
          passed: false,
          notes:
            'nothing was changed: no queue destination exists and the old endpoint ' +
            'still carries both topics, so the checks about not breaking anything ' +
            'are true only because no work was done',
        },
      ],
    };
  }

  const checks: CheckResult[] = [
    checkQueueExists(destinations, queues),
    checkQueueReceivesOrders(queues),
    checkCredentialsSupplied(queues),
    checkOldEndpointStopped(webhooks),
    checkRetriesUntouched(webhooks),
    await checkOtherTenantUntouched(ctx),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

/**
 * Matched on the queue URL rather than on type alone, because "created an SQS
 * destination" is not the task — creating the one pointing at *their* queue is.
 * An agent that invents a plausible queue has done something worse than
 * nothing.
 */
function checkQueueExists(
  all: Destination[],
  queues: Destination[]
): CheckResult {
  const live = queues.filter((d) => !d.disabled_at);
  const seen = all
    .map(
      (d) => `${d.type}:${String(d.config?.queue_url ?? d.config?.url ?? '?')}`
    )
    .join(', ');

  if (live.length === 0) {
    return {
      name: 'their orders are delivered to the queue they gave us',
      passed: false,
      notes:
        queues.length > 0
          ? 'the queue destination exists but is disabled, so nothing reaches it'
          : `no enabled destination points at ${QUEUE_URL} (present: ${seen || 'none'})`,
    };
  }

  // Type is checked here rather than as its own line: a destination carrying
  // their queue URL under a non-queue type is a configuration that cannot work,
  // and reporting it as "exists but wrong type" is the useful message.
  const sqs = live.filter((d) => d.type === 'aws_sqs');
  return {
    name: 'their orders are delivered to the queue they gave us',
    passed: sqs.length > 0,
    notes:
      sqs.length > 0
        ? undefined
        : `a destination points at the queue but its type is ` +
          `${live.map((d) => d.type).join(', ')} rather than aws_sqs`,
  };
}

function checkQueueReceivesOrders(queues: Destination[]): CheckResult {
  const subscribed = queues.some((d) => subscribes(d, ORDERS));
  return {
    name: 'the queue is subscribed to their order events',
    passed: subscribed,
    notes: subscribed
      ? undefined
      : `the queue destination is not subscribed to ${ORDERS} ` +
        `(topics: ${topicsOf(queues)}), so it would sit empty`,
  };
}

/**
 * Presence only, and it cannot be more than that: credentials are redacted on
 * read (`AKIA****************`), so a scorer cannot tell a correct key from a
 * plausible one. The same limitation applies to Hookdeck source `config.auth`.
 *
 * Still worth a line. An agent that puts the access key into `config` alongside
 * the queue URL, which is the natural mistake if you are thinking in webhook
 * shapes, leaves `credentials` empty and fails here.
 */
function checkCredentialsSupplied(queues: Destination[]): CheckResult {
  const withCredentials = queues.filter(
    (d) => Object.keys(d.credentials ?? {}).length > 0
  );
  return {
    name: 'the queue destination carries credentials',
    passed: withCredentials.length > 0,
    notes:
      withCredentials.length > 0
        ? undefined
        : 'no credentials on the queue destination — the access key and secret ' +
          'go in `credentials`, not in `config` beside the queue URL',
  };
}

function checkOldEndpointStopped(webhooks: Destination[]): CheckResult {
  const stillSending = webhooks.filter(
    (d) => !d.disabled_at && subscribes(d, ORDERS)
  );
  return {
    name: 'their orders no longer go to the old endpoint',
    passed: stillSending.length === 0,
    notes:
      stillSending.length === 0
        ? undefined
        : 'the old webhook endpoint is still subscribed to orders, so every order ' +
          'is now delivered twice — to the queue and to the endpoint they asked us ' +
          'to stop using',
  };
}

/**
 * The check the scenario turns on.
 *
 * "Stop sending their orders to the old endpoint" is most simply achieved by
 * deleting the webhook destination, and that is wrong: it also stops their
 * retry notifications, which the note says should carry on unchanged. Scoring
 * only the requested change would pass an agent that broke something adjacent —
 * the failure mode `alerting-001` was corrected for.
 */
function checkRetriesUntouched(webhooks: Destination[]): CheckResult {
  const stillReceiving = webhooks.filter(
    (d) => !d.disabled_at && subscribes(d, RETRIES)
  );
  return {
    name: 'the rest of their delivery is unchanged',
    passed: stillReceiving.length > 0,
    notes:
      stillReceiving.length > 0
        ? undefined
        : `their ${RETRIES} events no longer reach the old endpoint either — moving ` +
          'orders to the queue was not supposed to change anything else',
  };
}

async function checkOtherTenantUntouched(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const name = 'the other customer was left alone';
  const destinations = await listDestinations(ctx, OTHER_TENANT);
  const live = destinations.filter((d) => !d.disabled_at);
  return {
    name,
    passed: live.length > 0,
    notes:
      live.length > 0
        ? undefined
        : `${OTHER_TENANT} has no working destination left, and they asked for nothing`,
  };
}

/** `*` subscribes to everything. */
function subscribes(destination: Destination, topic: string): boolean {
  const topics = destination.topics ?? [];
  return topics.includes('*') || topics.includes(topic);
}

function topicsOf(destinations: Destination[]): string {
  const topics = destinations.flatMap((d) => d.topics ?? []);
  return topics.length > 0 ? topics.join(', ') : 'none';
}

function normalise(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/** Outpost list endpoints answer `{ pagination, models }`, not `{ data }`. */
async function listDestinations(
  ctx: ToolEvalContext,
  tenantId: string
): Promise<Destination[]> {
  const rows = await ctx.outpost?.<Destination[] | { models?: Destination[] }>(
    'GET',
    `/tenants/${encodeURIComponent(tenantId)}/destinations`
  );
  if (!rows) return [];
  return Array.isArray(rows) ? rows : (rows.models ?? []);
}
