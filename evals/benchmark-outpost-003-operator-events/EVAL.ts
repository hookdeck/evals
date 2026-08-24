import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@hookdeck-evals/core';

/**
 * Can an agent set up alerting for the incident in `outpost-002`?
 *
 * That scenario ends with the events recovered and nothing preventing a repeat.
 * Outpost emits `alert.destination.disabled` for exactly this case, but it is
 * delivered only to a configured **operator events destination**, and a project
 * with none is silent by design rather than by fault.
 *
 * What makes it worth measuring is where the answer lives. Operator events are
 * configured at `/operator-events/destinations`, and those routes appear in
 * neither published OpenAPI spec nor the API reference at `/docs/outpost/api`;
 * the prose page tells managed users to use the dashboard. See
 * hookdeck/evals#34.
 *
 * **This scenario originally predicted that every agent would fail it, and that
 * was wrong.** The prediction rested on "an agent has no source of truth except
 * what it can read". Agents do not work that way: on 21 and 22 August it was
 * passed six times out of six, across three models and both arms — including by
 * a weak model with no skills at all. They find the route by enumeration,
 * probing `/operator-events`, `/operator-event-destinations`,
 * `/operator/destinations` and so on until one answers, having first probed a
 * deliberately bogus path to learn what a real 404 looks like.
 *
 * So it does not measure discovery in the sense the classification implies, and
 * it does not currently discriminate at all. What it measures is persistence:
 * whether an agent keeps going when the documentation runs out. That is worth
 * something, but it is a fact about agents rather than about Hookdeck, and it
 * will not move if we fix the docs.
 *
 * Two consequences worth keeping in mind. It is **high variance** — the same
 * model passed 4/4 in one run and failed 0/1 in the next, because passing turns
 * on which paths get guessed, so a single attempt publishes a coin flip. And
 * #34 stands regardless: an endpoint reachable only by guesswork is
 * undocumented whether or not a determined agent gets there.
 *
 * Scored on outcome. It does not matter whether the agent used the API, and it
 * is not required to subscribe to the alert topic by name — `*` covers it and
 * is a reasonable reading of the request. What matters is that the alert would
 * reach the endpoint that was asked for.
 */

/** The endpoint the prompt names. Anything else is not where they asked. */
const REQUIRED_URL = 'https://mock.hookdeck.com/operator-alerts';
/** The alert the incident turns on. */
const DISABLED_TOPIC = 'alert.destination.disabled';
/** Asked for as a secondary, so scored separately and not as a gate. */
const FAILURE_TOPIC = 'alert.destination.consecutive_failure';

interface OperatorEventDestination {
  id?: string;
  type?: string;
  topics?: string[];
  config?: Record<string, unknown>;
  disabled_at?: string | null;
}

const scorer: ToolScorer = async (ctx) => {
  if (!ctx.outpost) {
    throw new Error(
      'no Outpost client, but this scenario declares `requires: [outpost]` ' +
        'and should have been skipped rather than scored'
    );
  }

  const destinations = await listOperatorEventDestinations(ctx);

  if (destinations.length === 0) {
    return {
      passed: false,
      checks: [
        {
          name: 'alerts are delivered somewhere',
          passed: false,
          notes:
            'no operator events destination exists, so nothing is emitted when a ' +
            "customer's destination is disabled — the same silence that ended the " +
            'last incident',
        },
      ],
    };
  }

  // Matched on the endpoint, not on which destination came back first. More
  // than one can exist, and an agent that adds a second alongside something
  // already present has still done what was asked.
  const matching = destinations.filter(
    (d) => normaliseUrl(d.config?.url) === normaliseUrl(REQUIRED_URL)
  );

  const checks: CheckResult[] = [
    checkReachesTheEndpoint(destinations, matching),
    checkDisabledAlertSubscribed(matching),
    checkEnabled(matching),
    checkConsecutiveFailureSubscribed(matching),
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

function checkReachesTheEndpoint(
  all: OperatorEventDestination[],
  matching: OperatorEventDestination[]
): CheckResult {
  const others = all.map((d) => String(d.config?.url ?? '(no url)')).join(', ');
  return {
    name: 'alerts are delivered to the endpoint that was asked for',
    passed: matching.length > 0,
    notes:
      matching.length > 0
        ? undefined
        : `operator events are configured, but to ${others} rather than ` +
          `${REQUIRED_URL}, so the team asking for them still would not see one`,
  };
}

/**
 * The check the scenario exists for.
 *
 * `*` counts. The prompt asks for the disabled alert and mentions consecutive
 * failures as useful, so subscribing to everything is a defensible reading and
 * failing it would be scoring the route rather than the result.
 */
function checkDisabledAlertSubscribed(
  matching: OperatorEventDestination[]
): CheckResult {
  const subscribed = matching.some((d) => subscribes(d, DISABLED_TOPIC));
  return {
    name: 'the disabled-destination alert is subscribed',
    passed: subscribed,
    notes: subscribed
      ? undefined
      : `the destination exists but is not subscribed to ${DISABLED_TOPIC} ` +
        `(topics: ${topicsOf(matching)}), so the one alert they asked for is the ` +
        'one they would not get',
  };
}

/**
 * A disabled alerting destination is configuration that looks right and does
 * nothing, which is the failure mode this whole scenario is about.
 */
function checkEnabled(matching: OperatorEventDestination[]): CheckResult {
  const live = matching.filter((d) => !d.disabled_at);
  return {
    name: 'the alerting destination is enabled',
    passed: matching.length > 0 && live.length > 0,
    notes:
      matching.length === 0 || live.length > 0
        ? undefined
        : 'the destination is configured but disabled, so it is set up and silent',
  };
}

function checkConsecutiveFailureSubscribed(
  matching: OperatorEventDestination[]
): CheckResult {
  const subscribed = matching.some((d) => subscribes(d, FAILURE_TOPIC));
  return {
    name: 'the build-up to a disable is subscribed too',
    passed: subscribed,
    notes: subscribed
      ? undefined
      : `not subscribed to ${FAILURE_TOPIC} (topics: ${topicsOf(matching)}), so ` +
        'they would hear when a destination is switched off but not while it is ' +
        'heading that way',
  };
}

/** `*` subscribes to everything, and is how the API expresses "all topics". */
function subscribes(
  destination: OperatorEventDestination,
  topic: string
): boolean {
  const topics = destination.topics ?? [];
  return topics.includes('*') || topics.includes(topic);
}

function topicsOf(destinations: OperatorEventDestination[]): string {
  const topics = destinations.flatMap((d) => d.topics ?? []);
  return topics.length > 0 ? topics.join(', ') : 'none';
}

/** Trailing slashes only; anything more would start accepting a different endpoint. */
function normaliseUrl(url: unknown): string {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

/**
 * A project that has never had an operator events destination answers
 * `404 "tenant not found"`, because the backing tenant is created lazily on the
 * first create. That is an empty list, and reading it as an error would fail
 * the scenario with a message about the harness rather than about the agent.
 */
async function listOperatorEventDestinations(
  ctx: ToolEvalContext
): Promise<OperatorEventDestination[]> {
  try {
    const rows = await ctx.outpost?.<
      OperatorEventDestination[] | { models?: OperatorEventDestination[] }
    >('GET', '/operator-events/destinations');
    if (!rows) return [];
    return Array.isArray(rows) ? rows : (rows.models ?? []);
  } catch {
    return [];
  }
}
