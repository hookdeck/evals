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

  /**
   * Every delivery trigger, not only ones created during the run.
   *
   * This used to exclude anything whose `created_at` predated the lease, on the
   * reasoning that a project ships with defaults and only the agent's own work
   * should count. That was wrong, and it failed the best answer any agent gave
   * in this scenario.
   *
   * The project carried an orphaned delivery trigger from an early run —
   * enabled, with an email channel, scoped to a connection that had since been
   * deleted, so alerting looked configured and could never fire. Claude Code
   * found it, diagnosed exactly that, and repointed it at the live connection.
   * The right answer: it repaired silent alerting instead of leaving a broken
   * trigger in place and adding a duplicate beside it. Updating does not change
   * `created_at`, so the scorer recorded no alert and failed it.
   *
   * The scenario asks whether an alert can fire and reach someone. That is a
   * question about the end state, and it does not care who created the trigger
   * or when. A scorer asserting *how* the outcome was reached rewards the
   * duplicate and punishes the repair — and it gets harder as agents get better
   * at inspecting existing state, which is how this scenario fell from 4/6 to
   * 1/6 without anything about it changing.
   */
  if (triggers.length === 0) {
    return {
      passed: false,
      checks: [
        {
          name: 'an alert exists for delivery failures',
          passed: false,
          notes: 'no delivery issue trigger at all',
        },
      ],
    };
  }

  const enabled = triggers.filter((t) => !t.disabled_at);
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
      { name: 'an alert exists for delivery failures', passed: true },
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

async function findConnection(
  ctx: ToolEvalContext
): Promise<Record<string, unknown> | undefined> {
  const { models } = await ctx.api<{ models?: Record<string, unknown>[] }>(
    'GET',
    '/connections?limit=100'
  );
  return (models ?? [])[0];
}
