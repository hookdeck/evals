/**
 * Where a run's Hookdeck project comes from.
 *
 * Two implementations, one interface, because the answer is changing. Today
 * the public API has no way to create a project (those routes are session
 * authenticated on the dashboard API), so runs share a project set up ahead of
 * time and reset between runs. An org-level API key with public
 * project-management endpoints is expected within a month, at which point
 * `ApiProjectSource` creates and destroys a project per run and most of
 * `FixedProjectSource` retires.
 *
 * Keeping that behind this interface is what makes the swap a new file rather
 * than a rewrite of the runtime.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  HookdeckClient,
  RESOURCE_KINDS,
  type HookdeckResource,
  type ResourceKind,
} from './client.js';
import { OutpostClient } from './outpost-client.js';

export interface LeasedProject {
  projectId: string;
  apiKey: string;
  /**
   * When the lease started. Scorers MUST scope event and request queries to
   * this window: events cannot be deleted through the API, so a shared project
   * accumulates history and a scorer that just asks "did an event arrive?"
   * will eventually say yes because of an earlier run.
   */
  acquiredAt: Date;
  client: HookdeckClient;
}

/**
 * Implementations MUST call `muteIssueTriggerNotifications` on every project
 * they hand out, including one they have just created: a new project ships with
 * issue triggers that email every member, and runs set them off on purpose.
 */
export interface ProjectSource {
  readonly id: string;
  acquire(): Promise<LeasedProject>;
  release(project: LeasedProject): Promise<void>;
}

/**
 * Clear the notification channels on every issue trigger in the project.
 *
 * A new project's default issue triggers carry an `email` channel, and the email
 * channel has no recipients of its own: it goes to every member of the
 * organization who has not turned alerts off (admins, owners and project members
 * only, if the project is private), whenever the project's notification methods
 * include email. That project setting would be the cleaner switch, because it
 * leaves the triggers looking like a customer's, but it is only writable with a
 * dashboard session, not a project API key — so the triggers are the lever the
 * harness can reach.
 * Scenarios fail deliveries, requests and transformations deliberately, so with
 * the defaults left alone every run emails the people on the eval project's
 * team. It had been happening since at least 21 August when it was raised, on
 * 6 November.
 *
 * The triggers are kept, enabled and scoped as they were, so issues still open.
 * Only who is told changes. `channels: {}` is the API's own "notify no one".
 *
 * **This changes what `alerting-001` starts from**, and is an instrument change
 * rather than housekeeping. No scorer reads issues, and acquire mutes before the
 * agent runs while release mutes after scoring, so no agent's own work is
 * altered. But the agent now finds every existing trigger with `channels: {}` —
 * exactly the silent state that scenario fails an agent for leaving — so a
 * default delivery trigger can no longer be passed by confirming it, and an agent
 * copying its neighbours' shape fails the channel check. Results either side of
 * this change are not comparable for that scenario.
 *
 * Every trigger, not only the snapshot's. In CI the snapshot is taken by each
 * fresh checkout, so a trigger leaked by a run that died before release can be
 * recorded as pristine and then never deleted; muting it is the only reset that
 * still reaches it. Every channel, not only email: a Slack or PagerDuty channel
 * on an eval project would page a person for a failure we caused on purpose.
 *
 * Returns the ids it changed, so a caller can log them.
 */
export async function muteIssueTriggerNotifications(
  client: HookdeckClient
): Promise<string[]> {
  const muted: string[] = [];
  for (const trigger of await client.list('issue-triggers')) {
    // Skip only an empty object. A missing or null `channels` is not muted: the
    // notification service falls through to emailing the team when a trigger
    // has no channels at all.
    const channels = trigger.channels as Record<string, unknown> | null;
    if (
      channels &&
      typeof channels === 'object' &&
      Object.keys(channels).length === 0
    ) {
      continue;
    }
    await client.request('PUT', `/issue-triggers/${trigger.id}`, {
      channels: {},
    });
    muted.push(trigger.id);
  }
  return muted;
}

/**
 * The set of resources a project contains before the harness first touches it.
 *
 * A new Hookdeck project is NOT empty: it ships with four issue triggers
 * (delivery, request, transformation, backpressure), all wildcard-scoped.
 * Resetting to empty would leave the project unlike any real customer's, and
 * would change what BM4 tests — an agent asked to alert on failing deliveries
 * should be reasoning about the trigger that already exists, not creating one
 * from scratch. So we reset to pristine, not to empty.
 *
 * Recording IDs rather than a count means any future default resource type is
 * protected without a code change.
 */
export interface PristineSnapshot {
  capturedAt: string;
  ids: Record<string, string[]>;
}

/**
 * What the Event Gateway side of the Outpost project contains when nothing has
 * touched it: nothing.
 *
 * `OUTPOST_API_KEY` is an ordinary project API key, so it authenticates
 * `api.hookdeck.com` and the CLI as well as the Outpost subdomain, and an agent
 * can create sources and connections in the Outpost project with it. Agents
 * did: on 24 and 25 August a source, two destinations, two connections and two
 * issue triggers appeared there — one destination on `outpost-003`'s alert URL,
 * the other on a `mock.hookdeck.com` path of the kind `outpost-001` accepted
 * before its endpoint was fixed — and nothing reset them; three of them were
 * updated again in September. On 5 November `outpost-005` found one of those
 * connections, added a topic filter to it instead of changing the Outpost
 * destination's topics, and the filter survived from attempt 1 into attempts 2
 * and 3 of the same cell.
 *
 * **Declared rather than captured.** The gateway project is reset to a snapshot
 * taken on first acquire, but in CI every job is a fresh checkout, so a captured
 * snapshot is taken from whatever the last job left — here it would have
 * recorded those leftovers as pristine and protected them. The tenant cleanup
 * below gives the same reason for not persisting a tenant baseline. A declared
 * baseline cannot be poisoned by a run that died.
 *
 * **Empty, unlike the gateway project, and that is not a contradiction of
 * "pristine, not empty".** A new Event Gateway project ships with default issue
 * triggers; an Outpost project ships with none, because the platform's project
 * creation sets up an Outpost project without the gateway defaults (read in the
 * Event Gateway implementation, not inferred from the API). Consistent with
 * that, the two issue triggers found here were created within a minute of
 * the leftover source and connection. No Outpost seed creates gateway
 * resources either. So for this
 * project, pristine *is* empty. If a scenario ever needs a gateway resource in
 * the Outpost project, its seed creates it, and the reset before the next seed
 * removes it.
 */
export const OUTPOST_GATEWAY_PRISTINE: PristineSnapshot = {
  capturedAt: 'declared',
  ids: {},
};

export interface FixedProjectSourceOptions {
  apiKey: string;
  projectId?: string;
  /** Where the pristine snapshot is persisted between runs. */
  snapshotPath?: string;
  /** Where the pristine Outpost managed config is recorded. See #41. */
  outpostConfigPath?: string;
  baseUrl?: string;
  /**
   * Set when scenarios requiring Outpost can run. Outpost is a separate
   * product with its own API and its own state, and nothing else here resets
   * it, so a tenant one run creates survives into the next.
   */
  outpostApiKey?: string;
  outpostBaseUrl?: string;
}

export class FixedProjectSource implements ProjectSource {
  readonly id = 'fixed-project';
  private readonly options: FixedProjectSourceOptions;
  private readonly projectId: string;
  private readonly snapshotPath: string;
  private readonly outpostConfigPath: string;
  private cachedClient?: HookdeckClient;
  private cachedOutpostClient?: OutpostClient;
  private cachedOutpostGatewayClient?: HookdeckClient;
  private outpostTenantsAtAcquire?: Set<string>;
  private outpostConfigAtAcquire?: Record<string, unknown>;
  private operatorEventDestinationsAtAcquire?: OperatorEventDestination[];

  constructor(options: FixedProjectSourceOptions) {
    this.options = options;
    this.projectId = options.projectId ?? 'evals-ci';
    this.snapshotPath = options.snapshotPath ?? '.hookdeck-pristine.json';
    this.outpostConfigPath =
      options.outpostConfigPath ?? '.outpost-pristine-config.json';
  }

  /**
   * Built on first use, not in the constructor. Experiment files are imported
   * to *list* what exists (`--dry`, `list`), and listing should not require
   * credentials. A missing key then fails when a run actually needs it, with a
   * message naming the experiment rather than a stack trace at import time.
   */
  private get client(): HookdeckClient {
    if (!this.cachedClient) {
      if (!this.options.apiKey) {
        throw new Error(
          'HOOKDECK_API_KEY is not set: a run needs a project to score against'
        );
      }
      this.cachedClient = new HookdeckClient({
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
      });
    }
    return this.cachedClient;
  }

  private get apiKey(): string {
    return this.options.apiKey;
  }

  /**
   * Undefined when no Outpost key is configured, which is the common case.
   *
   * Falls back to the environment rather than requiring every experiment to
   * pass it. Six experiment files construct this source and all six would need
   * the same line; the cost of one of them missing it is a leaked tenant that
   * makes `outpost-001`'s first check pass on work the agent never did, which
   * is too quiet a failure to leave to copy-paste discipline.
   */
  private get outpostClient(): OutpostClient | undefined {
    const apiKey = this.options.outpostApiKey ?? process.env.OUTPOST_API_KEY;
    if (!apiKey) return undefined;
    if (!this.cachedOutpostClient) {
      this.cachedOutpostClient = new OutpostClient({
        apiKey,
        baseUrl: this.options.outpostBaseUrl,
      });
    }
    return this.cachedOutpostClient;
  }

  /**
   * The Event Gateway API, authenticated as the Outpost project.
   *
   * Same host as `client`, different key, so a different project. Undefined
   * when Outpost is off, and when the two keys are the same string — that is
   * one project, already reset by `client`, and resetting it again to the
   * Outpost baseline would delete the gateway project's default issue triggers.
   */
  private get outpostGatewayClient(): HookdeckClient | undefined {
    const apiKey = this.options.outpostApiKey ?? process.env.OUTPOST_API_KEY;
    if (!apiKey || apiKey === this.options.apiKey) return undefined;
    if (!this.cachedOutpostGatewayClient) {
      this.cachedOutpostGatewayClient = new HookdeckClient({
        apiKey,
        baseUrl: this.options.baseUrl,
      });
    }
    return this.cachedOutpostGatewayClient;
  }

  async acquire(): Promise<LeasedProject> {
    const snapshot = await this.loadOrCaptureSnapshot();
    await this.resetToPristine(this.client, snapshot);
    await this.muteNotifications('acquire');
    // Before the seed, not only on release: a run that dies before release
    // must not hand its gateway resources in the Outpost project to the next
    // one, and in CI the next one is usually a different job. Throws, like the
    // reset above, because a scenario started on top of a leftover produces a
    // result that looks valid and is not, and nothing has been paid for yet.
    await this.resetOutpostGateway(snapshot);
    this.outpostTenantsAtAcquire = await this.listOutpostTenants();
    this.outpostConfigAtAcquire = await this.loadOrCaptureOutpostConfig();
    this.operatorEventDestinationsAtAcquire =
      await this.readOperatorEventDestinations();
    return {
      projectId: this.projectId,
      apiKey: this.apiKey,
      acquiredAt: new Date(),
      client: this.client,
    };
  }

  /**
   * Best-effort tidy so the project is not left dirty between runs. `acquire`
   * is what actually guarantees a clean start, which is why a run that crashes
   * without releasing is harmless: the next acquire resets from the snapshot
   * rather than from a per-run timestamp.
   */
  async release(_project: LeasedProject): Promise<void> {
    let snapshot: PristineSnapshot | undefined;
    try {
      snapshot = await this.loadOrCaptureSnapshot();
      await this.resetToPristine(this.client, snapshot);
    } catch {
      // Swallowed deliberately: a failed release must not fail the run, and
      // the next acquire will clean up regardless.
    }
    await this.muteNotifications('release');
    if (snapshot) {
      try {
        await this.resetOutpostGateway(snapshot);
      } catch (error) {
        // Same reasoning, and the next acquire resets this side too.
        console.warn(
          `outpost project gateway reset: release did not complete (${(error as Error).message})`
        );
      }
    }
    await this.releaseOutpostTenants();
    await this.restoreOperatorEventDestinations();
    await this.restoreOutpostConfig();
  }

  /**
   * See `muteIssueTriggerNotifications`. On acquire and on release: acquire is
   * the guarantee, so a trigger a dead run left behind is muted before the next
   * scenario's seeded failures can fire it, and release keeps the project quiet
   * between runs.
   *
   * Warns rather than throws, unlike the reset beside it. A trigger left
   * notifying sends someone an email; it does not make a result wrong, and
   * failing a run over it would trade a nuisance for lost spend. The Outpost
   * project needs no call: its gateway side is reset to empty, triggers included.
   */
  private async muteNotifications(when: 'acquire' | 'release'): Promise<void> {
    try {
      const muted = await muteIssueTriggerNotifications(this.client);
      if (when === 'acquire' && muted.length > 0) {
        console.warn(
          `issue triggers: cleared notification channels on ${muted.join(', ')}, ` +
            'which would have emailed the project team about failures runs cause on purpose'
        );
      }
    } catch (error) {
      console.warn(
        `issue triggers: could not clear notification channels on ${when}, so this ` +
          `project may email its team about failures runs cause on purpose (${(error as Error).message})`
      );
    }
  }

  /**
   * Delete Outpost tenants this lease created.
   *
   * Unlike the Hookdeck side, the guarantee here is on release rather than on
   * acquire, and that asymmetry is forced. Hookdeck resets from a persisted
   * snapshot of what a pristine project contains, so a crashed run is harmless:
   * the next acquire cleans up. Outpost has no such baseline. Tenants carry no
   * marker saying which run made them, and in CI every job is a fresh checkout,
   * so a persisted snapshot would capture a leaked tenant as pristine and
   * protect the very thing it should delete.
   *
   * Comparing against what existed at acquire is the one baseline that cannot
   * be poisoned that way, because this lease established it. The residual: a
   * run that dies before release still leaks, and the next run inherits it.
   * That is strictly better than not cleaning at all, and the remaining case is
   * visible rather than silent, because a leftover tenant makes
   * `outpost-001`'s first check pass without the agent doing anything.
   */
  /**
   * Outpost's managed configuration, or undefined when Outpost is off.
   *
   * Deployment-level rather than project-level, which is why it is captured at
   * all: it is the one piece of state a scenario can change that no reset
   * touches. `/config` is only served by the managed version, so a self-hosted
   * or unreachable deployment answers an error, and that is not a reason to
   * fail an acquire — it just means there is nothing to restore.
   */
  private async readOutpostConfig(): Promise<
    Record<string, unknown> | undefined
  > {
    const outpost = this.outpostClient;
    if (!outpost) return undefined;
    try {
      return await outpost.request<Record<string, unknown>>('GET', '/config');
    } catch {
      return undefined;
    }
  }

  /**
   * The config a pristine project has, read from disk when we have recorded it.
   *
   * In-memory capture was not enough, and the failure was not hypothetical: on
   * 21 August an agent trying to configure operator events sent 21 `PATCH
   * /config` requests and left `TOPICS` empty. The run died before release, the
   * *next* acquire captured the broken value as its baseline, and every seed
   * afterwards failed with `422 invalid topics` — nineteen of twenty-four cells,
   * and the original value was unrecoverable because it had already been
   * overwritten before anyone read it.
   *
   * Deployment config is worse than a leaked tenant in two ways. It is global,
   * so it breaks scenarios that never touch config; and it has no natural
   * baseline, so "pristine" silently becomes whatever the last crash left.
   *
   * On disk it survives a crash, exactly as `.hookdeck-pristine.json` does for
   * the project itself. Values that come back redacted are not recorded, so a
   * mask can never be restored as though it were the setting.
   */
  private async loadOrCaptureOutpostConfig(): Promise<
    Record<string, unknown> | undefined
  > {
    if (!this.outpostClient) return undefined;

    try {
      return JSON.parse(readFileSync(this.outpostConfigPath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // No baseline recorded yet: today's values are the best available one.
      const live = await this.readOutpostConfig();
      if (!live) return undefined;
      const recordable = Object.fromEntries(
        Object.entries(live).filter(([, v]) => !looksRedacted(v))
      );
      try {
        mkdirSync(dirname(this.outpostConfigPath), { recursive: true });
        writeFileSync(
          this.outpostConfigPath,
          JSON.stringify(recordable, null, 2)
        );
      } catch {
        // Recording is best effort; restoring from memory still works for a
        // run that exits cleanly.
      }
      return live;
    }
  }

  /**
   * Put back any managed config value this lease changed.
   *
   * Necessary because Outpost's managed config is **deployment-wide**. Tenants
   * are namespaced per scenario and a leaked one is at least visible; a changed
   * config key is neither. `OPERATOR_EVENTS_TOPICS` left set by one run silently
   * changes what every later run is configured with, including runs of other
   * scenarios, and nothing in the scoreboard would show it.
   *
   * Only keys that actually differ are written back, and only when the value
   * captured at acquire is safe to replay. Some values come back redacted or
   * masked, and PATCHing a redacted value would write the mask in as the real
   * setting — turning a tidy-up into the corruption it was meant to prevent. A
   * key that cannot be restored safely is left alone and reported, because a
   * loud leftover is better than a quiet wrong value.
   */
  private async restoreOutpostConfig(): Promise<void> {
    const outpost = this.outpostClient;
    const before = this.outpostConfigAtAcquire;
    if (!outpost || !before) return;

    try {
      const now = await outpost.request<Record<string, unknown>>(
        'GET',
        '/config'
      );
      const patch: Record<string, unknown> = {};
      const unsafe: string[] = [];

      for (const [key, original] of Object.entries(before)) {
        if (JSON.stringify(now[key]) === JSON.stringify(original)) continue;
        if (looksRedacted(original)) {
          unsafe.push(key);
          continue;
        }
        patch[key] = original;
      }

      if (unsafe.length > 0) {
        console.warn(
          `outpost config: ${unsafe.join(', ')} changed during this run but the ` +
            'value captured at acquire is redacted, so it was left as-is rather ' +
            'than restored to a mask'
        );
      }

      // One key at a time, not one batch.
      //
      // Some keys are read-only even though they are returned by `GET /config`
      // — `OPERATOR_EVENTS_TOPICS` answers `422 ... cannot be set directly`,
      // because on the managed version it is owned by the operator event
      // destinations rather than by config. A single batched PATCH containing
      // one such key is rejected in full, so an unrelated key that genuinely
      // needed restoring is silently left dirty. Measured: the first version of
      // this method restored nothing at all and said nothing about it.
      for (const [key, value] of Object.entries(patch)) {
        try {
          await outpost.request('PATCH', '/config', { [key]: value });
        } catch (error) {
          console.warn(
            `outpost config: could not restore ${key} — it is still set to this ` +
              `run's value for the next one (${(error as Error).message})`
          );
        }
      }
    } catch (error) {
      // Never fail a paid-for run here, but do not be silent about it either:
      // the whole point of this method is that a leftover is invisible.
      console.warn(
        `outpost config: restore did not run (${(error as Error).message})`
      );
    }
  }

  /**
   * The project's operator event destinations, or undefined when Outpost is off.
   *
   * Project-level rather than tenant-level, and therefore outside everything
   * else that gets reset. A scenario about configuring alerting has to start
   * from "no alerting configured", which means deleting whatever the project
   * already has — so this captures it first and `restoreOperatorEventDestinations`
   * puts it back.
   *
   * A project that has never had one answers `404 "tenant not found"`, because
   * the backing tenant is created lazily on the first create. That is an empty
   * list, not an error.
   */
  private async readOperatorEventDestinations(): Promise<
    OperatorEventDestination[] | undefined
  > {
    const outpost = this.outpostClient;
    if (!outpost) return undefined;
    try {
      const rows = await outpost.request<
        OperatorEventDestination[] | { models?: OperatorEventDestination[] }
      >('GET', '/operator-events/destinations');
      return Array.isArray(rows) ? rows : (rows.models ?? []);
    } catch (error) {
      // A 404 is the lazily-created tenant described above: genuinely none.
      // Anything else means the baseline could not be read, and that is not the
      // same thing. Returning `[]` for both would tell `restore` that the
      // project started with no destinations, and it would then delete the ones
      // it found — destroying alerting this run did not configure. Same
      // reasoning as the tenant baseline, and the same answer: without a
      // baseline, do nothing.
      if (String((error as Error).message).includes('404')) return [];
      return undefined;
    }
  }

  /**
   * Put the project's operator event destinations back as they were.
   *
   * Deletes what this lease added and recreates what it removed. Both halves
   * matter: a leftover destination from a run makes the next run's scenario
   * pass before the agent does anything, and a deleted one silently turns off
   * the project's real alerting.
   *
   * **Recreating changes the signing secret.** The secret is generated on
   * create and there is no way to supply it, so a restored destination is
   * equivalent in configuration but not identical, and anything verifying
   * signatures against the old secret would start rejecting. That is acceptable
   * on a dedicated eval project and would not be elsewhere.
   */
  private async restoreOperatorEventDestinations(): Promise<void> {
    const outpost = this.outpostClient;
    const before = this.operatorEventDestinationsAtAcquire;
    if (!outpost) return;
    if (!before) {
      // Undefined means the acquire-time read failed, not that there were none.
      console.warn(
        'outpost operator events: no baseline was captured, so the project was ' +
          'left as this run found it rather than risk deleting a destination ' +
          'this run did not create'
      );
      return;
    }

    try {
      const now = (await this.readOperatorEventDestinations()) ?? [];
      const keep = new Set(before.map((d) => d.id).filter(Boolean));

      // Each one independently. A single failure must not abandon the rest —
      // and in particular a delete that fails must not stop the recreates,
      // because that is the half that puts the project's real alerting back.
      // `restoreOutpostConfig` learned the same lesson from a batched PATCH.
      for (const destination of now) {
        if (!destination.id || keep.has(destination.id)) continue;
        try {
          await outpost.request(
            'DELETE',
            `/operator-events/destinations/${destination.id}`
          );
        } catch (error) {
          console.warn(
            `outpost operator events: could not delete ${destination.id}, which ` +
              `this run added (${(error as Error).message})`
          );
        }
      }

      const present = new Set(now.map((d) => d.id).filter(Boolean));
      for (const destination of before) {
        if (destination.id && present.has(destination.id)) continue;
        try {
          await outpost.request('POST', '/operator-events/destinations', {
            type: destination.type ?? 'webhook',
            ...(destination.topics ? { topics: destination.topics } : {}),
            config: destination.config ?? {},
          });
        } catch (error) {
          console.warn(
            'outpost operator events: could not recreate the destination for ' +
              `${String(destination.config?.url ?? destination.id)}, so the project ` +
              `is left without alerting it had before this run (${(error as Error).message})`
          );
        }
      }
    } catch (error) {
      console.warn(
        "outpost operator events: could not restore the project's destinations, " +
          `so the next run may not start from the state this one found (${(error as Error).message})`
      );
    }
  }

  private async releaseOutpostTenants(): Promise<void> {
    const outpost = this.outpostClient;
    if (!outpost || !this.outpostTenantsAtAcquire) return;
    const keep = this.outpostTenantsAtAcquire;
    try {
      for (const tenant of await outpost.tenants()) {
        if (!tenant.id || keep.has(tenant.id)) continue;
        await outpost.deleteTenant(tenant.id);
      }
    } catch {
      // Same reasoning as the Hookdeck reset above: tidying must never fail a
      // run that has already been paid for.
    }
  }

  /** Tenants present before this lease ran, or undefined when Outpost is off. */
  private async listOutpostTenants(): Promise<Set<string> | undefined> {
    const outpost = this.outpostClient;
    if (!outpost) return undefined;
    try {
      return new Set(
        (await outpost.tenants()).map((t) => t.id).filter(Boolean)
      );
    } catch {
      // Without a baseline, deleting nothing is the only safe move: the
      // alternative is deleting a tenant this run did not create.
      return undefined;
    }
  }

  private async loadOrCaptureSnapshot(): Promise<PristineSnapshot> {
    try {
      return JSON.parse(
        readFileSync(this.snapshotPath, 'utf8')
      ) as PristineSnapshot;
    } catch {
      const ids: Record<string, string[]> = {};
      for (const kind of RESOURCE_KINDS) {
        ids[kind] = (await this.client.list(kind)).map((r) => r.id);
      }
      const snapshot: PristineSnapshot = {
        capturedAt: new Date().toISOString(),
        ids,
      };
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2));
      return snapshot;
    }
  }

  /**
   * Delete everything the snapshot does not list, in dependency order.
   *
   * `onDelete` is called after each deletion rather than once at the end, so a
   * reset that fails partway still leaves a record of what it had already
   * removed.
   */
  private async resetToPristine(
    client: HookdeckClient,
    snapshot: PristineSnapshot,
    onDelete?: (kind: ResourceKind, resource: HookdeckResource) => void
  ): Promise<void> {
    // Connections reference sources and destinations, so they go first.
    for (const kind of RESOURCE_KINDS) {
      const keep = new Set(snapshot.ids[kind] ?? []);
      const existing: HookdeckResource[] = await client.list(kind);
      for (const resource of existing) {
        if (keep.has(resource.id)) continue;
        await client.delete(kind, resource.id);
        onDelete?.(kind, resource);
      }
    }
  }

  /**
   * Reset the Event Gateway side of the Outpost project to
   * `OUTPOST_GATEWAY_PRISTINE`, which is empty.
   *
   * Refuses when the Outpost key turns out to reach the gateway project after
   * all — two different keys for one project, say. The baseline here is "delete
   * everything", so pointing it at the gateway project would delete its default
   * issue triggers. The test is whether anything this key can see is in the
   * gateway project's own snapshot: two projects never share a resource id.
   *
   * Logs each deletion as it happens. Release normally leaves nothing for
   * acquire to find, so a deletion at acquire means a run died before releasing
   * or something outside the harness wrote to the project — both worth seeing
   * in a log.
   */
  private async resetOutpostGateway(
    gatewaySnapshot: PristineSnapshot
  ): Promise<void> {
    const client = this.outpostGatewayClient;
    if (!client) return;

    const gatewayIds = new Set(Object.values(gatewaySnapshot.ids).flat());
    for (const kind of RESOURCE_KINDS) {
      const shared = (await client.list(kind)).filter((r) =>
        gatewayIds.has(r.id)
      );
      if (shared.length > 0) {
        console.warn(
          `outpost project gateway reset: skipped, because OUTPOST_API_KEY can see ${kind} ` +
            `${shared.map((r) => r.id).join(', ')} from the gateway project's pristine ` +
            'snapshot. The two keys appear to belong to one project, and resetting it ' +
            "to the Outpost baseline would delete that project's defaults."
        );
        return;
      }
    }

    await this.resetToPristine(
      client,
      OUTPOST_GATEWAY_PRISTINE,
      (kind, resource) => {
        console.warn(
          `outpost project gateway reset: deleted ${kind} ${resource.id}` +
            (resource.name ? ` (${resource.name})` : '')
        );
      }
    );
  }
}

export interface OperatorEventDestination {
  id?: string;
  type?: string;
  topics?: string[];
  config?: Record<string, unknown>;
  disabled_at?: string | null;
}

/**
 * Does this value look like a mask rather than a setting?
 *
 * Deliberately broad. A false positive leaves a key unrestored and says so; a
 * false negative writes `********` in as a live credential.
 */
function looksRedacted(value: unknown): boolean {
  return (
    typeof value === 'string' && /^\*+$|^\[redacted\]$|\*{4,}/i.test(value)
  );
}
