import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * BM4, alerting: be told when deliveries to an endpoint keep failing.
 *
 * The silent failure here is sharper than most, because the artefact is trust.
 * An issue trigger that exists but never fires is worse than no alert at all:
 * the dashboard shows alerting configured, everyone stops watching, and the
 * next outage runs for a day. Every way of getting it wrong looks identical to
 * getting it right from the outside.
 *
 * Three ways to get it wrong, and all three are checked: creating the trigger
 * disabled, scoping it to connections it does not match, and giving it no
 * notification channel. `IssueTriggerDeliveryConfigs` takes either a name
 * pattern with `*` as wildcard or an array of connection ids, so a trigger
 * scoped to the wrong pattern is configured, enabled, visible, and silent. And
 * `channels` is a required field on create but every key inside it is
 * optional, so `channels: {}` satisfies the API and produces a trigger that is
 * enabled and correctly scoped but never notifies anyone:
 * the notification service loops over the keys of `trigger.channels`, which is
 * a no-op on an empty object, so nothing is ever sent. The console's own create form defaults to `email: {selected:
 * true}` for exactly this reason.
 *
 * Scored on configuration rather than by causing a real alert, which is a
 * compromise worth naming. The honest test is to break the destination, send
 * traffic, and wait for an issue to appear, but that depends on the retry cycle
 * completing and would take longer than a run and fail intermittently. So this
 * asks the three questions that decide whether an alert can fire and reach
 * someone, and leaves observing one to a scenario built around the timing.
 */
const scorer: ToolScorer = async (ctx) => {
  const connection = await findConnection(ctx);
  const triggers = await deliveryTriggers(ctx);
  const seeded = await seededTriggerIds(ctx);
  // A new project ships with default issue triggers, so "a delivery trigger
  // exists" is true before the agent does anything. Only ones it created count.
  const created = triggers.filter((t) => !seeded.has(String(t.id)));

  if (created.length === 0) {
    return {
      passed: false,
      checks: [
        {
          name: 'created an alert for delivery failures',
          passed: false,
          notes:
            triggers.length > 0
              ? 'only the project default triggers are present'
              : 'no delivery issue trigger at all',
        },
      ],
    };
  }

  const enabled = created.filter((t) => !t.disabled_at);
  const covering = enabled.filter((t) =>
    coversConnection(
      t,
      String(connection?.name ?? ''),
      String(connection?.id ?? '')
    )
  );
  const notifying = covering.filter((t) => hasNotificationChannel(t));

  return {
    passed: notifying.length > 0,
    checks: [
      { name: 'created an alert for delivery failures', passed: true },
      {
        name: 'the alert is enabled',
        passed: enabled.length > 0,
        notes:
          enabled.length > 0
            ? undefined
            : 'created but disabled, so it cannot fire',
      },
      {
        name: 'the alert covers the fulfilment connection',
        passed: covering.length > 0,
        notes:
          covering.length > 0
            ? undefined
            : `scoped to connections that do not include ${String(connection?.name)}, so it will never fire`,
      },
      {
        name: 'the alert has a notification channel configured',
        passed: notifying.length > 0,
        notes:
          notifying.length > 0
            ? undefined
            : 'channels is missing or empty, so an opened issue notifies no one even though the trigger fires',
      },
    ],
  };
};

export default scorer;

/**
 * Does a trigger's `connections` config actually match this connection.
 *
 * Accepts either shape the API allows: an array of ids, or a name pattern where
 * `*` is a wildcard. A missing config covers everything, which is how the
 * dashboard's own default behaves.
 */
function coversConnection(
  trigger: Record<string, unknown>,
  connectionName: string,
  connectionId: string
): boolean {
  const configs = trigger.configs as { connections?: unknown } | undefined;
  const connections = configs?.connections;
  if (connections === undefined || connections === null) return true;

  if (Array.isArray(connections)) {
    return connections.some(
      (c) => String(c) === connectionId || String(c) === connectionName
    );
  }

  const pattern = String(connections);
  if (pattern === '*' || pattern === '') return true;
  const asRegex = new RegExp(
    `^${pattern.split('*').map(escapeRegex).join('.*')}$`
  );
  return asRegex.test(connectionName) || asRegex.test(connectionId);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `channels` is required on create, but every key inside it is optional, so
 * `channels: {}` (or a channel object whose only keys are themselves empty)
 * satisfies the API and validates as configured while notifying no one.
 * `NotificationService.send` iterates `trigger.channels` with a plain
 * `for...in`, which is a no-op on an empty object, so this mirrors that check
 * rather than trusting the key's mere presence.
 */
function hasNotificationChannel(trigger: Record<string, unknown>): boolean {
  const channels = trigger.channels as
    | Record<string, unknown>
    | null
    | undefined;
  return !!channels && Object.keys(channels).length > 0;
}

async function deliveryTriggers(
  ctx: ToolEvalContext
): Promise<Record<string, unknown>[]> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/issue-triggers?limit=100'
  );
  return (models ?? []).filter((t) => t.type === 'delivery');
}

/**
 * Triggers that existed before the agent ran, identified by having been created
 * at or before the project was leased.
 */
async function seededTriggerIds(ctx: ToolEvalContext): Promise<Set<string>> {
  const { models } = await ctx.api<{
    models?: { id?: string; created_at?: string }[];
  }>('GET', '/issue-triggers?limit=100');
  const seeded = new Set<string>();
  for (const trigger of models ?? []) {
    if (trigger.created_at && new Date(trigger.created_at) < ctx.acquiredAt) {
      seeded.add(String(trigger.id));
    }
  }
  return seeded;
}

async function findConnection(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/connections?limit=100'
  );
  return (models ?? [])[0];
}
