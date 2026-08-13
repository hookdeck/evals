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

export interface ProjectSource {
  readonly id: string;
  acquire(): Promise<LeasedProject>;
  release(project: LeasedProject): Promise<void>;
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

export interface FixedProjectSourceOptions {
  apiKey: string;
  projectId?: string;
  /** Where the pristine snapshot is persisted between runs. */
  snapshotPath?: string;
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
  private cachedClient?: HookdeckClient;
  private cachedOutpostClient?: OutpostClient;
  private outpostTenantsAtAcquire?: Set<string>;

  constructor(options: FixedProjectSourceOptions) {
    this.options = options;
    this.projectId = options.projectId ?? 'evals-ci';
    this.snapshotPath = options.snapshotPath ?? '.hookdeck-pristine.json';
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

  async acquire(): Promise<LeasedProject> {
    const snapshot = await this.loadOrCaptureSnapshot();
    await this.resetToPristine(snapshot);
    this.outpostTenantsAtAcquire = await this.listOutpostTenants();
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
    try {
      const snapshot = await this.loadOrCaptureSnapshot();
      await this.resetToPristine(snapshot);
    } catch {
      // Swallowed deliberately: a failed release must not fail the run, and
      // the next acquire will clean up regardless.
    }
    await this.releaseOutpostTenants();
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

  /** Delete everything the snapshot does not list, in dependency order. */
  private async resetToPristine(snapshot: PristineSnapshot): Promise<void> {
    // Connections reference sources and destinations, so they go first.
    for (const kind of RESOURCE_KINDS) {
      const keep = new Set(snapshot.ids[kind] ?? []);
      const existing: HookdeckResource[] = await this.client.list(
        kind as ResourceKind
      );
      for (const resource of existing) {
        if (keep.has(resource.id)) continue;
        await this.client.delete(kind as ResourceKind, resource.id);
      }
    }
  }
}
