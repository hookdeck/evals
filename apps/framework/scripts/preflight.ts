import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { registeredAgentPins } from '@hookdeck-evals/core';
import {
  DEFAULT_ISSUE_TRIGGERS,
  HookdeckClient,
  OUTPOST_GATEWAY_PRISTINE,
  OutpostClient,
  RESOURCE_KINDS,
  redactArtifactDeep,
  redactSecretsForArtifact,
  type HookdeckResource,
  type OperatorEventDestination,
  type ResourceKind,
} from '@hookdeck-evals/hookdeck';
import {
  HOOKDECK_CLI_VERSION,
  SANDBOX_SELF_CHECK_FAILED,
  SKILLS_CLI_VERSION,
  sandboxImageDefinition,
} from '@hookdeck-evals/sandbox';
import { basePromptFor, extractBasePrompt } from '../lib/base-prompt.js';
import {
  discoverEvals,
  EVALS_ROOT,
  loadExperiments,
} from '../lib/discovery.js';
import {
  pinnedCliEvidence,
  pinnedCliFlags,
  shellActivity,
  type RowLike,
} from '../lib/pinned-cli.js';
import {
  CHECKS,
  parsePreflightArgs,
  USAGE,
  type CheckId,
  type PreflightArgs,
} from '../lib/preflight/args.js';
import {
  CANARY_CRITERIA,
  canaryPlan,
  diffInstrument,
  modelsFromRows,
  newestRunPerAgent,
  readPin,
  type AgentInstrument,
  type Instrument,
  type PublishedRowLike,
} from '../lib/preflight/canary.js';
import {
  classifyMissingSecrets,
  evaluateChecksRun,
  evaluateGatewayProject,
  evaluateOutpostGateway,
} from '../lib/preflight/evaluate.js';
import {
  changedSkills,
  checkLink,
  collectLinks,
} from '../lib/preflight/links.js';
import { planCells, type PlannedPair } from '../lib/preflight/matrix.js';
import { modelStanding } from '../lib/preflight/models.js';
import {
  exitCodeFor,
  formatReport,
  maskUrlPath,
  type CheckResult,
  type CheckStatus,
} from '../lib/preflight/report.js';
import { compareSemver, describeVersionGap } from '../lib/preflight/semver.js';
import {
  dollars,
  estimateSpend,
  failRatesFromRows,
  parseCostTable,
  type SpendEstimate,
} from '../lib/preflight/spend.js';
import {
  fillTemplate,
  providerProbes,
  refusalPattern,
  unfinishedRuns,
  workflowSecrets,
  workflowVariables,
} from '../lib/preflight/workflow.js';

/**
 * Everything a matrix dispatch should not find out by failing.
 *
 * ```bash
 * pnpm preflight                                   # the regression suite
 * pnpm preflight --suite benchmark --experiment-suite benchmark,no-skills --runs 3
 * pnpm -s preflight --json                         # -s keeps pnpm's banner out of the JSON
 * pnpm preflight --help
 * ```
 *
 * Every defect v0.5.0 found was discoverable before the run that found it — a
 * Codex PATH miss, a skills pin three months behind, a CLI pin two minors
 * behind, leftovers in the Outpost project, two dispatches publishing over each
 * other (#131). A matrix costs about $100 and six hours; this runs in minutes.
 *
 * **Read-only**, against Hookdeck, Outpost, GitHub and both providers, with one
 * exception: one real completion per provider, the same request the workflow's
 * own preflight makes, because a models list answers 200 with a zero balance.
 * It never prints a secret value: every string in the results is passed through
 * the same redaction the artifact export uses before the report is built, and a
 * delivery URL is printed with its path masked.
 *
 * Every process, HTTP, DNS, Hookdeck and Outpost call goes through `Deps`, so
 * the checks run in tests against fakes; `test/preflight-checks.test.ts` does.
 */

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The slice of the Event Gateway API the checks read. */
export interface GatewayReader {
  list(kind: ResourceKind): Promise<HookdeckResource[]>;
}

/** The slice of the Outpost API the checks read. Only `GET` is ever sent. */
export interface OutpostReader {
  tenants(): Promise<Array<{ id: string }>>;
  get<T>(path: string): Promise<T>;
}

export interface Deps {
  root: string;
  env: Record<string, string | undefined>;
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number }
  ): Promise<ExecResult>;
  fetch: typeof fetch;
  resolveHost(host: string): Promise<boolean>;
  gateway(apiKey: string): GatewayReader;
  outpost(apiKey: string): OutpostReader;
  sleep(ms: number): Promise<void>;
}

const realDeps: Deps = {
  root: EVALS_ROOT,
  env: process.env,
  exec: (cmd, args, opts) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          cwd: opts?.cwd ?? EVALS_ROOT,
          timeout: opts?.timeoutMs ?? 120_000,
          maxBuffer: 256 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        }
      );
    }),
  fetch: (...args) => fetch(...args),
  resolveHost: async (host) => {
    try {
      await lookup(host);
      return true;
    } catch {
      return false;
    }
  },
  gateway: (apiKey) => {
    const client = new HookdeckClient({ apiKey });
    return { list: (kind) => client.list(kind) };
  },
  outpost: (apiKey) => {
    const client = new OutpostClient({ apiKey });
    return {
      tenants: () => client.tenants(),
      get: (path) => client.request('GET', path),
    };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const DECISIONS = new Set<CheckId>([
  'hookdeck-cli-pin',
  'agent-cli-pins',
  'skills-pin',
  'model-ids',
  'base-prompt',
  'skills-cli-pin',
]);

function result(
  id: CheckId,
  status: CheckStatus,
  summary: string,
  details: string[] = []
): CheckResult {
  const meta = CHECKS.find((c) => c.id === id);
  if (!meta) throw new Error(`no check ${id}`);
  return {
    id,
    number: meta.number,
    title: meta.title,
    kind: DECISIONS.has(id) ? 'decision' : 'assertion',
    status,
    summary,
    details,
  };
}

/** Everything several checks read, gathered once. */
export interface Context {
  deps: Deps;
  args: PreflightArgs;
  repo: string;
  headSha: string;
  dirty: boolean;
  dispatchSha?: string;
  lastRelease?: string;
  workflow: string;
  experiments: Array<{
    name: string;
    agent: string;
    provider?: string;
    model?: string;
    suites: string[];
  }>;
  cells: PlannedPair[];
  /** Experiments the requested matrix runs; all of them when it runs none. */
  experimentsInPlan: Set<string>;
  agentsInPlan: Set<string>;
  evalsRequiringOutpost: string[];
  latest?: {
    results: Array<Record<string, unknown>>;
    runId?: string;
  };
  skills: { slug: string; pin?: string; names: string[]; dirs: string[] };
}

async function sh(ctx: { deps: Deps }, cmd: string, args: string[]) {
  const r = await ctx.deps.exec(cmd, args);
  if (r.code !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')} exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`
    );
  }
  return r.stdout;
}

async function ghJson<T>(ctx: { deps: Deps }, args: string[]): Promise<T> {
  return JSON.parse(await sh(ctx, 'gh', args)) as T;
}

/** A file at a commit: local objects first, the GitHub API when absent. */
async function fileAt(
  ctx: Context,
  ref: string,
  path: string
): Promise<string | undefined> {
  const local = await ctx.deps.exec('git', ['show', `${ref}:${path}`]);
  if (local.code === 0) return local.stdout;
  const remote = await ctx.deps.exec('gh', [
    'api',
    `repos/${ctx.repo}/contents/${path}?ref=${ref}`,
    '-H',
    'Accept: application/vnd.github.raw',
  ]);
  return remote.code === 0 ? remote.stdout : undefined;
}

function repoSlug(remoteUrl: string): string {
  const m = /github\.com[:/]([^/]+\/[^/.\s]+)(?:\.git)?\s*$/.exec(remoteUrl);
  if (!m) throw new Error(`cannot read a GitHub repo from ${remoteUrl}`);
  return m[1] as string;
}

async function buildContext(deps: Deps, args: PreflightArgs): Promise<Context> {
  const base = { deps };
  const repo = repoSlug(await sh(base, 'git', ['remote', 'get-url', 'origin']));
  const headSha = (await sh(base, 'git', ['rev-parse', 'HEAD'])).trim();
  const dirty =
    (await sh(base, 'git', ['status', '--porcelain'])).trim().length > 0;
  const dispatch = await deps.exec('gh', [
    'api',
    `repos/${repo}/commits/main`,
    '--jq',
    '.sha',
  ]);
  const release = await deps.exec('gh', [
    'release',
    'list',
    '--exclude-drafts',
    '--limit',
    '1',
    '--json',
    'tagName',
    '--jq',
    '.[0].tagName',
  ]);

  const workflow = readFileSync(
    join(deps.root, '.github/workflows/eval-refresh.yml'),
    'utf8'
  );

  const loaded = await loadExperiments(deps.root);
  const experiments = loaded.map(({ name, config }) => ({
    name,
    agent: config.agent.id,
    provider: config.agent.metadata?.modelProvider,
    model: config.agent.metadata?.modelId,
    suites: [...(config.suite ?? [])],
  }));
  const evals = discoverEvals(deps.root);
  const cells = planCells(
    evals.map((e) => ({
      id: e.id,
      suite: e.suite,
      metadata: e.metadata as never,
    })),
    loaded.map(({ name, config }) => ({
      name,
      suites: [...(config.suite ?? [])],
      skipEval: config.skipEval as never,
    })),
    args.dispatch
  );
  const experimentsInPlan = new Set(
    cells.length > 0
      ? cells.map((c) => c.experiment)
      : loaded.map((e) => e.name)
  );
  const agentsInPlan = new Set(
    experiments.filter((e) => experimentsInPlan.has(e.name)).map((e) => e.agent)
  );
  const plannedEvals = new Set(cells.map((c) => c.eval));
  const evalsRequiringOutpost = evals
    .filter(
      (e) =>
        plannedEvals.has(e.id) &&
        (e.metadata.requires ?? []).some((r) => String(r) === 'outpost')
    )
    .map((e) => e.id);

  const latestPath = join(deps.root, 'results/latest.json');
  const latest = existsSync(latestPath)
    ? (JSON.parse(readFileSync(latestPath, 'utf8')) as Context['latest'])
    : undefined;

  // The pinned skills are what `skills/` links into the submodule.
  const gitmodules = readFileSync(join(deps.root, '.gitmodules'), 'utf8');
  const slug = repoSlug(
    /url\s*=\s*(\S+agent-skills\S*)/.exec(gitmodules)?.[1] ??
      'https://github.com/hookdeck/agent-skills.git'
  );
  const tree = await deps.exec('git', [
    'ls-tree',
    'HEAD',
    'submodules/agent-skills',
  ]);
  const pin = /\bcommit\s+([0-9a-f]{40})\b/.exec(tree.stdout)?.[1];
  const names: string[] = [];
  const dirs: string[] = [];
  const skillsDir = join(deps.root, 'skills');
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    let target: string;
    try {
      target = readlinkSync(join(skillsDir, name));
    } catch {
      continue;
    }
    const m = /submodules\/agent-skills\/(.+)$/.exec(target);
    if (!m) continue;
    names.push(name);
    dirs.push((m[1] as string).replace(/\/$/, ''));
  }

  return {
    deps,
    args,
    repo,
    headSha,
    dirty,
    dispatchSha: dispatch.code === 0 ? dispatch.stdout.trim() : undefined,
    lastRelease:
      release.code === 0 && release.stdout.trim()
        ? release.stdout.trim()
        : undefined,
    workflow,
    experiments,
    cells,
    experimentsInPlan,
    agentsInPlan,
    evalsRequiringOutpost,
    latest,
    skills: { slug, pin, names, dirs },
  };
}

async function npmLatest(ctx: Context, pkg: string): Promise<string> {
  const res = await ctx.deps.fetch(
    `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`
  );
  if (!res.ok) throw new Error(`npm ${pkg}: HTTP ${res.status}`);
  return ((await res.json()) as { version: string }).version;
}

function gapStatus(current: string, latest: string): CheckStatus {
  return compareSemver(current, latest) < 0 ? 'decide' : 'pass';
}

/**
 * A pin baked into the sandbox image, against npm `latest` and against what it
 * was at the last release. Checks 1 and 16 differ only in which pin.
 */
async function imagePinDecision(
  ctx: Context,
  id: 'hookdeck-cli-pin' | 'skills-cli-pin',
  pkg: string,
  pinned: string,
  constant: string,
  file: string,
  consequence: string
): Promise<CheckResult> {
  const latest = await npmLatest(ctx, pkg);
  const details = [`pinned: ${pinned} (${file})`, `npm latest: ${latest}`];
  if (ctx.lastRelease) {
    const source = await fileAt(ctx, ctx.lastRelease, file);
    const then = source && readPin(source, constant);
    if (then) details.push(`pinned at ${ctx.lastRelease}: ${then}`);
  }
  details.push(consequence);
  return result(
    id,
    gapStatus(pinned, latest),
    describeVersionGap(pinned, latest),
    details
  );
}

// 1 ---------------------------------------------------------------------------

function checkHookdeckCli(ctx: Context): Promise<CheckResult> {
  return imagePinDecision(
    ctx,
    'hookdeck-cli-pin',
    'hookdeck-cli',
    HOOKDECK_CLI_VERSION,
    'HOOKDECK_CLI_VERSION',
    'packages/sandbox/src/image.ts',
    'a bump changes the product under test: results either side are not comparable'
  );
}

// 16 --------------------------------------------------------------------------

function checkSkillsCli(ctx: Context): Promise<CheckResult> {
  return imagePinDecision(
    ctx,
    'skills-cli-pin',
    'skills',
    SKILLS_CLI_VERSION,
    'SKILLS_CLI_VERSION',
    'packages/sandbox/src/skills.ts',
    'a bump changes how skills are installed into the sandbox: skills arms either side are not comparable'
  );
}

// 2 ---------------------------------------------------------------------------

async function checkAgentClis(ctx: Context): Promise<CheckResult> {
  const pins = registeredAgentPins().filter((p) => ctx.agentsInPlan.has(p.id));
  const details: string[] = [];
  let behind = 0;
  for (const pin of pins) {
    const latest = await npmLatest(ctx, pin.cliPackage);
    if (compareSemver(pin.defaultCliVersion, latest) < 0) behind += 1;
    let then = '';
    if (ctx.lastRelease) {
      const source = await fileAt(
        ctx,
        ctx.lastRelease,
        `packages/core/src/agents/${pin.id}/runner.ts`
      );
      const v = source && readPin(source, 'defaultCliVersion');
      if (v) then = `; pinned at ${ctx.lastRelease}: ${v}`;
    }
    details.push(
      `${pin.cliPackage}: ${describeVersionGap(pin.defaultCliVersion, latest)}${then}`
    );
  }
  details.push(
    'a bump changes the transcript format the parser reads: re-check the parser'
  );
  return result(
    'agent-cli-pins',
    behind > 0 ? 'decide' : 'pass',
    behind > 0
      ? `${behind} of ${pins.length} behind npm latest`
      : `all ${pins.length} at npm latest`,
    details
  );
}

// 3 ---------------------------------------------------------------------------

/** GitHub's compare API lists at most this many files and commits. */
const COMPARE_FILE_CAP = 300;
const COMPARE_COMMIT_CAP = 250;

async function checkSkillsPin(ctx: Context): Promise<CheckResult> {
  const { slug, pin, names } = ctx.skills;
  if (!pin) {
    return result(
      'skills-pin',
      'warn',
      'no submodules/agent-skills gitlink at HEAD'
    );
  }
  const main = (
    await sh(ctx, 'gh', ['api', `repos/${slug}/commits/main`, '--jq', '.sha'])
  ).trim();
  if (main === pin) {
    return result('skills-pin', 'pass', `at ${slug} main (${pin.slice(0, 7)})`);
  }
  const compare = await ghJson<{
    ahead_by: number;
    behind_by: number;
    files?: Array<{ filename: string }>;
  }>(ctx, ['api', `repos/${slug}/compare/${pin}...${main}`]);
  const files = compare.files ?? [];
  const changed = changedSkills(files.map((f) => f.filename));
  const pinnedChanged = changed.filter((s) => names.includes(s));
  const details = [
    `pinned: ${pin.slice(0, 7)}; main: ${main.slice(0, 7)}`,
    `skills changed between them: ${changed.length > 0 ? changed.join(', ') : 'none'}`,
    `of the skills this repo installs (${names.join(', ')}): ${pinnedChanged.length > 0 ? pinnedChanged.join(', ') : 'none changed'}`,
  ];
  if (
    files.length >= COMPARE_FILE_CAP ||
    compare.ahead_by >= COMPARE_COMMIT_CAP
  ) {
    details.push(
      `the compare API lists at most ${COMPARE_FILE_CAP} files and ${COMPARE_COMMIT_CAP} commits, so the changed-skills list may be incomplete`
    );
  }
  if (compare.behind_by > 0) {
    details.push(
      `the pin is not an ancestor of main: it carries ${compare.behind_by} commit${compare.behind_by === 1 ? '' : 's'} main does not, so moving it to main drops them`
    );
  }
  details.push(
    'a move alters what a skills arm reads and nothing a baseline arm sees'
  );
  return result(
    'skills-pin',
    'decide',
    compare.behind_by > 0
      ? `diverged from ${slug} main: ${compare.ahead_by} behind, ${compare.behind_by} ahead`
      : `${compare.ahead_by} commit${compare.ahead_by === 1 ? '' : 's'} behind ${slug} main`,
    details
  );
}

// 4 ---------------------------------------------------------------------------

async function listModels(
  ctx: Context,
  provider: string
): Promise<string[] | string> {
  if (provider === 'anthropic') {
    const key = ctx.deps.env.ANTHROPIC_API_KEY;
    if (!key) return 'ANTHROPIC_API_KEY not set';
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const res = await ctx.deps.fetch(
        `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${after}` : ''}`,
        { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }
      );
      if (!res.ok) return `Anthropic models list: HTTP ${res.status}`;
      const page = (await res.json()) as {
        data: Array<{ id: string }>;
        has_more?: boolean;
        last_id?: string;
      };
      ids.push(...page.data.map((m) => m.id));
      if (!page.has_more || !page.last_id) return ids;
      after = page.last_id;
    }
  }
  if (provider === 'openai') {
    const key = ctx.deps.env.OPENAI_API_KEY;
    if (!key) return 'OPENAI_API_KEY not set';
    const res = await ctx.deps.fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return `OpenAI models list: HTTP ${res.status}`;
    return ((await res.json()) as { data: Array<{ id: string }> }).data.map(
      (m) => m.id
    );
  }
  return `no models list for provider ${provider}`;
}

async function checkModelIds(ctx: Context): Promise<CheckResult> {
  const byProvider = new Map<string, Map<string, string[]>>();
  for (const e of ctx.experiments) {
    if (!ctx.experimentsInPlan.has(e.name) || !e.model || !e.provider) continue;
    const models = byProvider.get(e.provider) ?? new Map<string, string[]>();
    models.set(e.model, [...(models.get(e.model) ?? []), e.name]);
    byProvider.set(e.provider, models);
  }
  const details: string[] = [];
  let decide = false;
  let unknown = false;
  for (const [provider, models] of [...byProvider].sort()) {
    const listed = await listModels(ctx, provider);
    for (const [model, experiments] of [...models].sort()) {
      const who = `${model} (${experiments.join(', ')})`;
      if (typeof listed === 'string') {
        unknown = true;
        details.push(`${who}: not checked, ${listed}`);
        continue;
      }
      const s = modelStanding(model, listed);
      const parts = [s.listed ? 'listed' : 'NOT in the models list'];
      if (!s.listed && s.variants.length > 0) {
        parts.push(`variants listed: ${s.variants.join(', ')}`);
      }
      if (s.newer.length > 0)
        parts.push(`newer in family: ${s.newer.join(', ')}`);
      if (!s.listed || s.newer.length > 0) decide = true;
      details.push(`${who}: ${parts.join('; ')}`);
    }
  }
  details.push(
    "newer-in-family is read from version numbers in the ids, a heuristic; the list itself is the provider's"
  );
  return result(
    'model-ids',
    decide ? 'decide' : unknown ? 'warn' : 'pass',
    decide
      ? 'a model is unlisted or has a newer sibling'
      : unknown
        ? 'could not read every models list'
        : 'every model is listed and newest in its family',
    details
  );
}

// 5 ---------------------------------------------------------------------------

async function checkBasePrompt(ctx: Context): Promise<CheckResult> {
  const current = basePromptFor('tools');
  if (!ctx.lastRelease) {
    return result(
      'base-prompt',
      'warn',
      'no published release to compare with'
    );
  }
  const then =
    extractBasePrompt(
      (await fileAt(
        ctx,
        ctx.lastRelease,
        'apps/framework/lib/base-prompt.ts'
      )) ?? ''
    ) ??
    extractBasePrompt(
      (await fileAt(
        ctx,
        ctx.lastRelease,
        'apps/framework/harness/run-eval.ts'
      )) ?? ''
    );
  if (then === undefined) {
    return result(
      'base-prompt',
      'warn',
      `could not read the base prompt at ${ctx.lastRelease}`
    );
  }
  if (then === current) {
    return result('base-prompt', 'pass', `unchanged since ${ctx.lastRelease}`);
  }
  return result(
    'base-prompt',
    'decide',
    `changed since ${ctx.lastRelease}: every cell moves at once`,
    [
      `at ${ctx.lastRelease}: ${JSON.stringify(then)}`,
      `now: ${JSON.stringify(current)}`,
    ]
  );
}

// 6 ---------------------------------------------------------------------------

async function checkProviderKeys(ctx: Context): Promise<CheckResult> {
  const probes = providerProbes(ctx.workflow);
  if (probes.length === 0) {
    return result(
      'provider-keys',
      'fail',
      'found no provider requests in the workflow preflight step to repeat'
    );
  }
  const refusal = refusalPattern(ctx.workflow);
  const details: string[] = [];
  let failed = 0;
  for (const probe of probes) {
    const headers: Record<string, string> = {};
    const missing: string[] = [];
    for (const [name, template] of Object.entries(probe.headers)) {
      const filled = fillTemplate(template, ctx.deps.env);
      missing.push(...filled.missing);
      headers[name] = filled.value;
    }
    const label = `${probe.provider} (${probe.model ?? 'no model'})`;
    if (missing.length > 0) {
      failed += 1;
      details.push(`${label}: ${missing.join(', ')} not set in .env`);
      continue;
    }
    const res = await ctx.deps.fetch(probe.url, {
      method: 'POST',
      headers,
      body: probe.body,
    });
    const text = await res.text();
    if (res.status === 200) {
      details.push(`${label}: HTTP 200`);
      continue;
    }
    failed += 1;
    const matched = refusal ? refusal.exec(text)?.[0] : undefined;
    details.push(
      `${label}: HTTP ${res.status}` +
        (matched ? ` (refusing: ${matched})` : '') +
        ` ${text.slice(0, 200).replace(/\s+/g, ' ')}`
    );
  }
  details.push(
    'these are the keys in your .env; the workflow repeats this against the repository secrets before its matrix'
  );
  return result(
    'provider-keys',
    failed > 0 ? 'fail' : 'pass',
    failed > 0
      ? `${failed} of ${probes.length} providers refused a real completion`
      : `${probes.length} providers answered a real completion`,
    details
  );
}

// 7 ---------------------------------------------------------------------------

function spendEstimate(ctx: Context): SpendEstimate | string {
  const costs = parseCostTable(
    readFileSync(join(ctx.deps.root, 'AGENTS.md'), 'utf8')
  );
  if (!costs) return 'could not find the per-pass cost table in AGENTS.md';
  const failRates = failRatesFromRows(
    (ctx.latest?.results ?? []) as Array<{
      experiment?: string;
      passed?: boolean;
      attempts?: number;
    }>
  );
  return estimateSpend(ctx.cells, costs, failRates);
}

async function checkSpend(ctx: Context): Promise<CheckResult> {
  const estimate = spendEstimate(ctx);
  if (typeof estimate === 'string') return result('spend', 'fail', estimate);
  if (ctx.cells.length === 0) {
    return result('spend', 'fail', 'the requested matrix has no cells');
  }
  const details = [
    `${ctx.cells.length} cells, ${ctx.args.dispatch.runs} attempt${ctx.args.dispatch.runs === 1 ? '' : 's'} each (min_attempts can raise a scenario's), stopping at the first pass`,
    ...estimate.rows.map(
      (r) =>
        `${r.experiment}: ${r.cells} cells x ${dollars(r.perAttempt)}, fail rate ${(r.failRate * 100).toFixed(0)}% (${r.failRateSource}) -> ${dollars(r.low)}-${dollars(r.high)}` +
        (r.priced ? '' : ' [NO MEASURED FIGURE: priced at the dearest]')
    ),
    `every cell once: ${dollars(estimate.firstAttempts)}; expected with retries: ${dollars(estimate.low)}-${dollars(estimate.high)}`,
    ...estimate.assumptions.map((a) => `assumes ${a}`),
    'neither provider exposes a balance to a project key: this cannot read one',
  ];
  const summary = `estimated ${dollars(estimate.low)}-${dollars(estimate.high)}`;

  if (ctx.args.confirmBalance) {
    return result(
      'spend',
      'pass',
      `${summary}; balance confirmed by --confirm-balance`,
      details
    );
  }
  if (process.stdin.isTTY && process.stdout.isTTY && !ctx.args.json) {
    process.stdout.write(
      `\nSpend: ${summary}\n${details.map((d) => `  ${d}`).join('\n')}\n`
    );
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      `Do the Anthropic and OpenAI balances both cover ${dollars(estimate.high)}? [y/N] `
    );
    rl.close();
    if (/^y(es)?$/i.test(answer.trim())) {
      return result(
        'spend',
        'pass',
        `${summary}; balance confirmed interactively`,
        details
      );
    }
    return result(
      'spend',
      'fail',
      `${summary}; balance not confirmed`,
      details
    );
  }
  return result(
    'spend',
    'fail',
    `${summary}; confirm the balances cover it with --confirm-balance`,
    details
  );
}

// 8 ---------------------------------------------------------------------------

export async function checkSecrets(ctx: Context): Promise<CheckResult> {
  const wanted = workflowSecrets(ctx.workflow);
  const have = new Set(
    (
      await ghJson<Array<{ name: string }>>(ctx, [
        'secret',
        'list',
        '--json',
        'name',
      ])
    ).map((s) => s.name)
  );
  const { fatal, unneeded } = classifyMissingSecrets(
    wanted,
    have,
    registeredAgentPins(),
    new Set(ctx.experiments.map((e) => e.agent))
  );
  const details = [
    `the workflow reads: ${wanted.join(', ')}`,
    ...unneeded.map(
      (n) =>
        `${n} is missing and is the key of an agent no experiment uses, so nothing reads it`
    ),
    'names only: GitHub does not return secret values, so liveness is check 6 and the workflow preflight',
  ];
  return result(
    'secrets',
    fatal.length > 0 ? 'fail' : 'pass',
    fatal.length > 0
      ? `missing from the repository: ${fatal.join(', ')}`
      : `all ${wanted.length - unneeded.length} needed secrets exist`,
    details
  );
}

// 9 ---------------------------------------------------------------------------

export async function checkMainGreen(ctx: Context): Promise<CheckResult> {
  const sha = ctx.dispatchSha;
  if (!sha) {
    return result('main-green', 'fail', 'could not read main from GitHub');
  }

  if (ctx.headSha === sha && !ctx.dirty) {
    // Checked out at exactly what a dispatch runs: run the same four commands
    // the Checks workflow runs, here.
    const commands: Array<[string, string[]]> = [
      ['pnpm', ['format:check']],
      ['pnpm', ['typecheck']],
      ['pnpm', ['-r', 'test']],
      ['pnpm', ['-r', 'build']],
    ];
    const details: string[] = [];
    let failed = 0;
    for (const [cmd, args] of commands) {
      const r = await ctx.deps.exec(cmd, args, { timeoutMs: 900_000 });
      details.push(
        `${cmd} ${args.join(' ')}: ${r.code === 0 ? 'ok' : `exit ${r.code}`}`
      );
      if (r.code !== 0) {
        failed += 1;
        details.push(
          `  ${(r.stdout + r.stderr).trim().split('\n').slice(-5).join(' | ')}`
        );
      }
    }
    return result(
      'main-green',
      failed > 0 ? 'fail' : 'pass',
      failed > 0
        ? `${failed} of 4 checks fail at main ${sha.slice(0, 7)}`
        : `format, typecheck, tests and build pass locally at main ${sha.slice(0, 7)}`,
      details
    );
  }

  // Not checked out at main: the Checks workflow runs on pull requests only, so
  // read the run for the pull request that produced main.
  const why = `HEAD ${ctx.headSha.slice(0, 7)}${ctx.dirty ? ' (dirty)' : ''} is not main ${sha.slice(0, 7)}`;
  const pulls = await ghJson<
    Array<{ number: number; merge_commit_sha: string; head: { sha: string } }>
  >(ctx, ['api', `repos/${ctx.repo}/commits/${sha}/pulls`]);
  const pr = pulls.find((p) => p.merge_commit_sha === sha);
  if (!pr) {
    return result(
      'main-green',
      'fail',
      `main ${sha.slice(0, 7)} was not merged from a pull request, so no Checks run covers it`,
      [why, 'check out main and re-run to run the checks locally']
    );
  }
  const runs = await ghJson<
    Array<{
      databaseId: number;
      conclusion: string;
      headSha: string;
      event: string;
      createdAt: string;
    }>
  >(ctx, [
    'run',
    'list',
    '--workflow',
    'biome.yml',
    '--commit',
    pr.head.sha,
    '--json',
    'databaseId,conclusion,headSha,event,createdAt',
  ]);
  const run = runs
    .filter((r) => r.event === 'pull_request')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) {
    return result('main-green', 'fail', `no Checks run for #${pr.number}`, [
      why,
    ]);
  }
  const view = await ghJson<{
    conclusion: string;
    jobs: Array<{ steps: Array<{ name: string; conclusion: string }> }>;
  }>(ctx, ['run', 'view', String(run.databaseId), '--json', 'conclusion,jobs']);

  // The base the pull request was merged onto is main's first parent.
  const commit = await ghJson<{ parents: Array<{ sha: string }> }>(ctx, [
    'api',
    `repos/${ctx.repo}/commits/${sha}`,
  ]);
  const parent = commit.parents[0]?.sha;
  let baseCommittedAt: string | undefined;
  if (parent) {
    const r = await ctx.deps.exec('gh', [
      'api',
      `repos/${ctx.repo}/commits/${parent}`,
      '--jq',
      '.commit.committer.date',
    ]);
    if (r.code === 0 && r.stdout.trim()) baseCommittedAt = r.stdout.trim();
  }

  const verdict = evaluateChecksRun({
    mainSha: sha,
    prNumber: pr.number,
    runId: run.databaseId,
    runCreatedAt: run.createdAt,
    conclusion: view.conclusion,
    steps: view.jobs.flatMap((j) => j.steps),
    baseCommittedAt,
  });
  return result('main-green', verdict.status, verdict.summary, [
    why,
    ...verdict.details,
  ]);
}

// 10 --------------------------------------------------------------------------

async function checkNothingRunning(ctx: Context): Promise<CheckResult> {
  const runs = await ghJson<
    Array<{
      databaseId: number;
      status: string;
      event: string;
      createdAt: string;
      url: string;
    }>
  >(ctx, [
    'run',
    'list',
    '--workflow',
    'eval-refresh.yml',
    '--limit',
    '30',
    '--json',
    'databaseId,status,event,createdAt,url',
  ]);
  const open = unfinishedRuns(runs);
  return result(
    'nothing-running',
    open.length > 0 ? 'fail' : 'pass',
    open.length > 0
      ? `${open.length} eval-refresh run${open.length === 1 ? '' : 's'} not finished`
      : 'no eval-refresh run in progress or pending',
    [
      ...open.map(
        (r) =>
          `${r.databaseId} ${r.status} (${r.event}, ${r.createdAt}) ${r.url}`
      ),
      'the concurrency group cancels a third dispatch, and overlapping merge runs publish against stale results (#127)',
    ]
  );
}

// 11 --------------------------------------------------------------------------

async function checkVariables(ctx: Context): Promise<CheckResult> {
  const vars = new Map(
    (
      await ghJson<Array<{ name: string; value: string }>>(ctx, [
        'variable',
        'list',
        '--json',
        'name,value',
      ])
    ).map((v) => [v.name, v.value])
  );
  const problems: string[] = [];
  const details: string[] = [];

  const publish = vars.get('EVALS_PUBLISH');
  const publishing = publish !== 'false';
  details.push(
    `EVALS_PUBLISH: ${publish === undefined ? 'unset' : JSON.stringify(publish)}, so this run ${publishing ? 'publishes' : 'does not publish'}`
  );
  if (ctx.args.holdPublish && publishing) {
    problems.push('--hold-publish given but EVALS_PUBLISH is not "false"');
  }
  if (!ctx.args.holdPublish && !publishing) {
    problems.push(
      'EVALS_PUBLISH is "false", so this run would not publish; pass --hold-publish if that is intended, or `gh variable delete EVALS_PUBLISH`'
    );
  }

  const fraction = vars.get('EVALS_MAX_MISSING_FRACTION');
  const effective = fraction ?? '0.1';
  details.push(
    `EVALS_MAX_MISSING_FRACTION: ${fraction === undefined ? 'unset (0.1)' : JSON.stringify(fraction)}`
  );
  if (Number(effective) !== Number(ctx.args.maxMissingFraction)) {
    problems.push(
      `EVALS_MAX_MISSING_FRACTION resolves to ${effective}, expected ${ctx.args.maxMissingFraction}`
    );
  }

  for (const name of workflowVariables(ctx.workflow)) {
    if (name === 'EVALS_PUBLISH' || name === 'EVALS_MAX_MISSING_FRACTION')
      continue;
    details.push(
      `${name}: ${vars.has(name) ? JSON.stringify(vars.get(name)) : 'unset'} (read by the workflow)`
    );
  }
  return result(
    'repo-variables',
    problems.length > 0 ? 'fail' : 'pass',
    problems.length > 0
      ? problems.join('; ')
      : 'variables match what the run intends',
    details
  );
}

// 12 --------------------------------------------------------------------------

function describe(r: HookdeckResource): string {
  return `${r.id}${r.name ? ` (${r.name})` : ''}`;
}

async function readKinds(
  reader: GatewayReader
): Promise<Record<string, HookdeckResource[]>> {
  const out: Record<string, HookdeckResource[]> = {};
  for (const kind of RESOURCE_KINDS) out[kind] = await reader.list(kind);
  return out;
}

export async function checkProjects(ctx: Context): Promise<CheckResult> {
  const fails: string[] = [];
  const warns: string[] = [];
  const details: string[] = [];
  const { env } = ctx.deps;

  // evals-ci: nothing but the declared default issue triggers.
  if (!env.HOOKDECK_API_KEY) {
    fails.push('HOOKDECK_API_KEY not set in .env: evals-ci not checked');
  } else {
    const resources = await readKinds(ctx.deps.gateway(env.HOOKDECK_API_KEY));
    fails.push(...evaluateGatewayProject(resources));
    details.push(
      `evals-ci: ${(resources['issue-triggers'] ?? []).length} issue triggers against ${DEFAULT_ISSUE_TRIGGERS.length} declared`
    );
  }

  const outpostKey = env.OUTPOST_API_KEY;
  const outpostNeeded = ctx.evalsRequiringOutpost.length > 0;
  if (!outpostKey) {
    (outpostNeeded ? fails : warns).push(
      `OUTPOST_API_KEY not set in .env: the Outpost project was not checked${outpostNeeded ? `, and ${ctx.evalsRequiringOutpost.length} planned scenarios need it` : ''}`
    );
  } else if (outpostKey === env.HOOKDECK_API_KEY) {
    fails.push(
      'OUTPOST_API_KEY is the evals-ci key: it must belong to a dedicated Outpost project (#111)'
    );
  } else {
    // The Outpost project's Event Gateway side, against its declared baseline.
    const resources = await readKinds(ctx.deps.gateway(outpostKey));
    fails.push(...evaluateOutpostGateway(resources, OUTPOST_GATEWAY_PRISTINE));
    const count = Object.values(resources).reduce((n, r) => n + r.length, 0);
    details.push(
      `Outpost project gateway side: ${count} resources, declared empty`
    );

    const outpost = ctx.deps.outpost(outpostKey);
    const tenants = await outpost.tenants();
    if (tenants.length > 0) {
      fails.push(
        `stray Outpost tenants: ${tenants.map((t) => t.id).join(', ')}`
      );
    }
    details.push(`Outpost tenants: ${tenants.length}`);

    const destinations = await operatorEventDestinations(outpost);
    const enabled = destinations.filter((d) => !d.disabled_at);
    if (enabled.length === 0) {
      fails.push(
        `no enabled operator event destination (${destinations.length} disabled): nothing hears a failure`
      );
    }
    for (const d of enabled) {
      const verdict = await destinationTarget(ctx, d, [
        env.HOOKDECK_API_KEY,
        outpostKey,
      ]);
      const label = `operator event destination ${d.id}`;
      details.push(
        `${label} (${d.type}, ${(d.topics ?? []).join(', ')}): ${verdict.detail}`
      );
      if (verdict.status === 'fail') fails.push(`${label}: ${verdict.detail}`);
      if (verdict.status === 'warn') warns.push(`${label}: ${verdict.detail}`);

      let attempts: Array<{ status?: string }> | undefined;
      try {
        const page = await outpost.get<{
          models?: Array<{ status?: string }>;
        }>(
          `/operator-events/attempts?destination_id=${encodeURIComponent(String(d.id))}&limit=20`
        );
        attempts = page.models ?? [];
      } catch (error) {
        details.push(
          `  could not read attempts: ${(error as Error).message.slice(0, 120)}`
        );
      }
      if (attempts) {
        const failed = attempts.filter(
          (a) => a.status && a.status !== 'success'
        );
        details.push(
          attempts.length === 0
            ? '  no attempts on record'
            : `  last ${attempts.length} attempts: ${attempts.length - failed.length} succeeded, ${failed.length} did not`
        );
        if (failed.length > 0) {
          warns.push(
            `${label}: ${failed.length} recent attempts did not succeed`
          );
        }
      }
    }
  }

  details.push(...warns.map((w) => `warning: ${w}`));
  return result(
    'projects-pristine',
    fails.length > 0 ? 'fail' : warns.length > 0 ? 'warn' : 'pass',
    fails.length > 0
      ? fails.join('; ')
      : warns.length > 0
        ? 'pristine, with something that could not be verified'
        : 'both projects are pristine',
    details
  );
}

async function operatorEventDestinations(
  outpost: OutpostReader
): Promise<OperatorEventDestination[]> {
  try {
    const rows = await outpost.get<
      OperatorEventDestination[] | { models?: OperatorEventDestination[] }
    >('/operator-events/destinations');
    return Array.isArray(rows) ? rows : (rows.models ?? []);
  } catch (error) {
    // A project that has never had one answers 404 "tenant not found".
    if (String((error as Error).message).includes('404')) return [];
    throw error;
  }
}

const HOOKDECK_SOURCE_HOSTS = new Set(['hkdk.events', 'events.hookdeck.com']);

/**
 * Whether a destination's URL is somewhere that exists, without sending it
 * anything: a request to a Hookdeck source URL is ingested and recorded in
 * whichever project owns it, which is a write. The URL is reported with its
 * path masked, because a source URL lets anyone who holds it post events.
 */
async function destinationTarget(
  ctx: Context,
  d: OperatorEventDestination,
  keys: Array<string | undefined>
): Promise<{ status: 'pass' | 'warn' | 'fail'; detail: string }> {
  const raw = d.config?.url;
  if (d.type !== 'webhook' || typeof raw !== 'string') {
    return {
      status: 'warn',
      detail: `type ${d.type}: only webhook destinations are checked`,
    };
  }
  const shown = maskUrlPath(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: 'fail', detail: 'its URL does not parse' };
  }
  if (url.host === 'mock.hookdeck.com') {
    return {
      status: 'fail',
      detail: `delivers to a mock endpoint (${url.host}), which is a scenario's, not an alert destination`,
    };
  }
  if (HOOKDECK_SOURCE_HOSTS.has(url.host)) {
    for (const key of keys) {
      if (!key) continue;
      const sources = await ctx.deps.gateway(key).list('sources');
      const owner = sources.find((s) => s.url === raw);
      if (owner) {
        return {
          status: 'pass',
          detail: `${shown} is Hookdeck source ${describe(owner)}`,
        };
      }
    }
    return {
      status: 'warn',
      detail: `${shown} is a Hookdeck source in a project neither key can see; confirm it exists in the dashboard`,
    };
  }
  return (await ctx.deps.resolveHost(url.hostname))
    ? { status: 'pass', detail: `${shown}: ${url.host} resolves` }
    : { status: 'fail', detail: `${shown}: ${url.host} does not resolve` };
}

// 13 --------------------------------------------------------------------------

async function pinnedSkillFiles(
  ctx: Context
): Promise<Array<{ path: string; text: string }>> {
  const { slug, pin, dirs } = ctx.skills;
  if (!pin) throw new Error('no skills pin at HEAD');
  const sub = join(ctx.deps.root, 'submodules/agent-skills');
  const files: Array<{ path: string; text: string }> = [];
  const textFile = /\.(md|mdx|mdc|txt|ya?ml|json)$/i;

  const hasLocal =
    existsSync(join(sub, '.git')) &&
    (
      await ctx.deps.exec('git', [
        '-C',
        sub,
        'cat-file',
        '-e',
        `${pin}^{commit}`,
      ])
    ).code === 0;
  if (hasLocal) {
    const list = await sh(ctx, 'git', [
      '-C',
      sub,
      'ls-tree',
      '-r',
      '--name-only',
      pin,
      '--',
      ...dirs,
    ]);
    for (const path of list.split('\n').filter((p) => textFile.test(p))) {
      files.push({
        path,
        text: await sh(ctx, 'git', ['-C', sub, 'show', `${pin}:${path}`]),
      });
    }
    return files;
  }

  // Not checked out here: read the pinned tree from GitHub.
  const tree = await ghJson<{ tree: Array<{ path: string; type: string }> }>(
    ctx,
    ['api', `repos/${slug}/git/trees/${pin}?recursive=1`]
  );
  const paths = tree.tree
    .filter((t) => t.type === 'blob' && textFile.test(t.path))
    .map((t) => t.path)
    .filter((p) => dirs.some((d) => p.startsWith(`${d}/`)));
  await pool(paths, 8, async (path) => {
    const res = await ctx.deps.fetch(
      `https://raw.githubusercontent.com/${slug}/${pin}/${path}`
    );
    if (!res.ok) {
      throw new Error(`${path} at ${pin.slice(0, 7)}: HTTP ${res.status}`);
    }
    files.push({ path, text: await res.text() });
  });
  return files;
}

async function pool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await fn(item);
      }
    })
  );
}

async function checkSkillLinks(ctx: Context): Promise<CheckResult> {
  const files = await pinnedSkillFiles(ctx);
  const links = collectLinks(files);
  const bad: Array<{ url: string; status: number; files: string[] }> = [];
  const moved: Array<{ url: string; finalUrl: string; files: string[] }> = [];
  await pool(links, 6, async (link) => {
    const checked = await checkLink(ctx.deps.fetch, link.url, ctx.deps.sleep);
    if (checked.status !== 200) {
      bad.push({ ...link, status: checked.status });
    } else if (checked.finalUrl) {
      moved.push({ ...link, finalUrl: checked.finalUrl });
    }
  });
  bad.sort((a, b) => a.url.localeCompare(b.url));
  moved.sort((a, b) => a.url.localeCompare(b.url));
  const status: CheckStatus =
    bad.length > 0 ? 'fail' : moved.length > 0 ? 'warn' : 'pass';
  return result(
    'skill-links',
    status,
    bad.length > 0
      ? `${bad.length} of ${links.length} docs URLs in the pinned skills do not return 200`
      : moved.length > 0
        ? `all ${links.length} docs URLs return 200, ${moved.length} only after a redirect`
        : `all ${links.length} docs URLs in the pinned skills return 200`,
    [
      `skills ${ctx.skills.names.join(', ')} at ${ctx.skills.pin?.slice(0, 7)}, ${files.length} files`,
      ...bad.map(
        (b) =>
          `${b.status || 'no response'} ${b.url} (in ${b.files.join(', ')})`
      ),
      ...moved.map(
        (m) => `redirected ${m.url} -> ${m.finalUrl} (in ${m.files.join(', ')})`
      ),
    ]
  );
}

// 14 --------------------------------------------------------------------------

async function checkHarnessIssues(ctx: Context): Promise<CheckResult> {
  const issues = await ghJson<Array<{ number: number; title: string }>>(ctx, [
    'issue',
    'list',
    '--label',
    'harness',
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title',
  ]);
  const accepted = new Set(ctx.args.acceptHarness);
  const open = issues.filter((i) => !accepted.has(i.number));
  return result(
    'harness-issues',
    open.length > 0 ? 'fail' : 'pass',
    open.length > 0
      ? `${open.length} open harness issue${open.length === 1 ? '' : 's'} neither fixed nor accepted; accept by name with --accept-harness ${open.map((i) => i.number).join(',')}`
      : `${issues.length} open harness issues, every one accepted for this run`,
    issues.map(
      (i) =>
        `#${i.number} (${i.title})${accepted.has(i.number) ? ': accepted' : ''}`
    )
  );
}

// 15 --------------------------------------------------------------------------

/**
 * What each agent's newest published cells ran under.
 *
 * Per agent rather than per snapshot: a published file merges runs, and the
 * newest of them may carry no cells for an agent at all. Reading that agent's
 * image and pins from it would clear a change no cell of that agent ran under.
 */
export async function publishedInstrument(ctx: Context): Promise<Instrument> {
  const rows = (ctx.latest?.results ?? []) as PublishedRowLike[];
  const agentOf = new Map(ctx.experiments.map((e) => [e.name, e.agent]));
  const runs = newestRunPerAgent(rows, (e) => agentOf.get(e));
  const shas = new Map<string, string>();
  const byAgent: Record<string, AgentInstrument> = {};
  for (const agent of [...ctx.agentsInPlan].sort()) {
    const runId = runs[agent];
    if (!runId) {
      byAgent[agent] = {};
      continue;
    }
    let sha = shas.get(runId);
    if (!sha) {
      sha = (
        await ghJson<{ headSha: string }>(ctx, [
          'run',
          'view',
          runId,
          '--json',
          'headSha',
        ])
      ).headSha;
      shas.set(runId, sha);
    }
    const dockerfile = await fileAt(ctx, sha, 'packages/sandbox/Dockerfile');
    const image = await fileAt(ctx, sha, 'packages/sandbox/src/image.ts');
    const skills = await fileAt(ctx, sha, 'packages/sandbox/src/skills.ts');
    const runner = await fileAt(
      ctx,
      sha,
      `packages/core/src/agents/${agent}/runner.ts`
    );
    byAgent[agent] = {
      imageDefinition: dockerfile
        ? sandboxImageDefinition(dockerfile)
        : undefined,
      hookdeckCli: image ? readPin(image, 'HOOKDECK_CLI_VERSION') : undefined,
      skillsCli: skills ? readPin(skills, 'SKILLS_CLI_VERSION') : undefined,
      agentCli: runner ? readPin(runner, 'defaultCliVersion') : undefined,
      source: `run ${runId} at ${sha.slice(0, 7)}`,
    };
  }
  return { byAgent, models: modelsFromRows(rows) };
}

function currentInstrument(ctx: Context): Instrument {
  const pins = new Map<string, string>(
    registeredAgentPins().map((p) => [p.id, p.defaultCliVersion])
  );
  const imageDefinition = sandboxImageDefinition();
  return {
    byAgent: Object.fromEntries(
      [...ctx.agentsInPlan].map((agent) => [
        agent,
        {
          imageDefinition,
          hookdeckCli: HOOKDECK_CLI_VERSION,
          skillsCli: SKILLS_CLI_VERSION,
          agentCli: pins.get(agent),
        },
      ])
    ),
    models: Object.fromEntries(
      ctx.experiments
        .filter((e) => ctx.experimentsInPlan.has(e.name))
        .map((e) => [e.name, e.model])
    ),
  };
}

export async function checkCanary(ctx: Context): Promise<CheckResult> {
  const published = await publishedInstrument(ctx);
  const changes = diffInstrument(published, currentInstrument(ctx));
  const sources = Object.entries(published.byAgent)
    .map(([agent, i]) => `${agent}: ${i.source ?? 'no published run'}`)
    .join('; ');
  if (changes.length === 0) {
    return result(
      'canary',
      'pass',
      'not required: image, CLI pins and models match the newest published cells of each agent',
      [sources]
    );
  }
  const details = [
    'against the newest published cells of each agent:',
    ...changes.map((c) => `  ${c.what}: ${c.published} -> ${c.current}`),
  ];

  if (ctx.args.canaryRun) {
    const verdict = await verifyCanary(ctx, ctx.args.canaryRun);
    return result(
      'canary',
      verdict.problems.length > 0 ? 'fail' : 'pass',
      verdict.problems.length > 0
        ? `canary run ${ctx.args.canaryRun} does not clear the change: ${verdict.problems.join('; ')}`
        : `canary run ${ctx.args.canaryRun} clears the change`,
      [...details, ...verdict.details]
    );
  }

  // One Claude and one Codex cell, preferring an experiment whose model moved.
  const changed = new Set(
    changes.map((c) => /^(.+) model$/.exec(c.what)?.[1]).filter(Boolean)
  );
  const pick = (agent: string) =>
    ctx.experiments
      .filter((e) => e.agent === agent)
      .sort(
        (a, b) =>
          Number(changed.has(b.name)) - Number(changed.has(a.name)) ||
          Number(b.suites.includes('benchmark')) -
            Number(a.suites.includes('benchmark')) ||
          a.name.localeCompare(b.name)
      )[0];
  const chosen = [pick('claude-code'), pick('codex')].filter(
    (e): e is NonNullable<typeof e> => e !== undefined
  );
  const suites = chosen.map((e) =>
    e.suites.includes('benchmark')
      ? 'benchmark'
      : e.suites.includes('no-skills')
        ? 'no-skills'
        : (e.suites[0] ?? 'benchmark')
  );
  const plan = canaryPlan(
    chosen.map((e) => e.name),
    ctx.args.canaryEval,
    'benchmark',
    suites
  );
  return result(
    'canary',
    'fail',
    'the instrument moved: a two-cell canary with EVALS_PUBLISH=false is required before the matrix',
    [
      ...details,
      'run:',
      ...plan.commands.map((c) => `  ${c}`),
      'it passes when:',
      ...CANARY_CRITERIA.map((c) => `  - ${c}`),
    ]
  );
}

async function verifyCanary(
  ctx: Context,
  runId: string
): Promise<{ problems: string[]; details: string[] }> {
  const problems: string[] = [];
  const details: string[] = [];
  const view = await ghJson<{
    conclusion: string;
    headSha: string;
    jobs: Array<{
      name: string;
      conclusion: string;
      steps: Array<{ name: string; conclusion: string }>;
    }>;
  }>(ctx, ['run', 'view', runId, '--json', 'conclusion,headSha,jobs']);
  if (view.conclusion !== 'success') {
    problems.push(`run concluded ${view.conclusion || 'unfinished'}`);
  }
  if (ctx.dispatchSha && view.headSha !== ctx.dispatchSha) {
    problems.push(
      `ran at ${view.headSha.slice(0, 7)}, not main ${ctx.dispatchSha.slice(0, 7)}`
    );
  }
  const cells = view.jobs.filter((j) => j.name.startsWith('run-evals'));
  for (const agent of ['claude-code', 'codex']) {
    if (!cells.some((j) => j.name.includes(agent))) {
      problems.push(`no ${agent} cell`);
    }
  }
  for (const job of cells) {
    for (const step of ['Run evals', 'Check artifacts for credentials']) {
      const s = job.steps.find((x) => x.name === step);
      if (s?.conclusion !== 'success') {
        problems.push(`${job.name}: ${step} ${s?.conclusion ?? 'did not run'}`);
      }
    }
  }
  const publish = view.jobs.find((j) => j.name.startsWith('publish-results'));
  if (publish && publish.conclusion !== 'skipped') {
    problems.push(
      `publish-results ${publish.conclusion}: publishing was not held`
    );
  }
  const log = await ctx.deps.exec('gh', ['run', 'view', runId, '--log']);
  if (log.stdout.includes(SANDBOX_SELF_CHECK_FAILED)) {
    problems.push('a cell failed the sandbox self-check');
  }

  const dir = mkdtempSync(join(tmpdir(), 'preflight-canary-'));
  try {
    await sh(ctx, 'gh', [
      'run',
      'download',
      runId,
      '-p',
      'raw-results-*',
      '-D',
      dir,
    ]);
    let rows = 0;
    for (const file of walkJson(dir)) {
      const row = JSON.parse(readFileSync(file, 'utf8')) as RowLike & {
        eval?: string;
        experiment?: string;
      };
      if (!row.transcript && !row.toolCalls) continue;
      rows += 1;
      const evidence = pinnedCliEvidence(shellActivity(row));
      const flags = evidence ? pinnedCliFlags(evidence) : [];
      for (const f of flags.filter(
        (f) => f.label === 'PINNED CLI NOT ON PATH'
      )) {
        problems.push(`${row.experiment} x ${row.eval}: ${f.label}`);
      }
    }
    details.push(`read ${rows} raw result rows from the canary's artifacts`);
    if (rows === 0) problems.push('no raw results in the canary artifacts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { problems, details };
}

function* walkJson(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkJson(full);
    else if (entry.endsWith('.json')) yield full;
  }
}

// -----------------------------------------------------------------------------

const RUNNERS: Record<CheckId, (ctx: Context) => Promise<CheckResult>> = {
  'hookdeck-cli-pin': checkHookdeckCli,
  'agent-cli-pins': checkAgentClis,
  'skills-pin': checkSkillsPin,
  'model-ids': checkModelIds,
  'base-prompt': checkBasePrompt,
  'provider-keys': checkProviderKeys,
  spend: checkSpend,
  secrets: checkSecrets,
  'main-green': checkMainGreen,
  'nothing-running': checkNothingRunning,
  'repo-variables': checkVariables,
  'projects-pristine': checkProjects,
  'skill-links': checkSkillLinks,
  'harness-issues': checkHarnessIssues,
  canary: checkCanary,
  'skills-cli-pin': checkSkillsCli,
};

async function guarded(ctx: Context, id: CheckId): Promise<CheckResult> {
  if (ctx.args.skip.includes(id)) {
    return result(id, 'skipped', 'SKIPPED BY --skip: not checked');
  }
  try {
    return await RUNNERS[id](ctx);
  } catch (error) {
    // A check that cannot run has not passed. A decision that cannot run has
    // nothing to decide, so it warns instead.
    return result(
      id,
      DECISIONS.has(id) ? 'warn' : 'fail',
      `could not run: ${(error as Error).message}`
    );
  }
}

export async function runPreflight(
  argv: string[],
  deps: Deps = realDeps
): Promise<{ output: string; code: number }> {
  const args = parsePreflightArgs(argv);
  if (args.help) return { output: USAGE, code: 0 };
  const ctx = await buildContext(deps, args);

  // Spend last and alone, because it may ask a question on the terminal.
  const ids = CHECKS.map((c) => c.id).filter((id) => id !== 'spend');
  const raw = await Promise.all(ids.map((id) => guarded(ctx, id)));
  raw.push(await guarded(ctx, 'spend'));

  const notes: string[] = [];
  if (ctx.dispatchSha && ctx.headSha !== ctx.dispatchSha) {
    notes.push(
      'pins, experiments and the base prompt were read from HEAD, which is not what a dispatch runs; check out main for a preflight that describes the dispatch'
    );
  }
  if (ctx.dirty) notes.push('the working tree has uncommitted changes');
  notes.push(
    `matrix: ${ctx.cells.length} cells (suites ${args.dispatch.suites.join(',')}; experiment suites ${args.dispatch.experimentSuites.join(',')}${args.dispatch.experiments.length ? `; experiments ${args.dispatch.experiments.join(',')}` : ''}${args.dispatch.evalIds.length ? `; evals ${args.dispatch.evalIds.join(',')}` : ''}; runs ${args.dispatch.runs})`
  );

  // Redact every string before it is laid out, so a value is caught whole
  // rather than after JSON escaping or line-wrapping has changed its shape.
  const results = redactArtifactDeep(raw) as CheckResult[];
  const meta = redactArtifactDeep({
    generatedAt: new Date().toISOString(),
    headSha: ctx.headSha,
    dispatchSha: ctx.dispatchSha,
    skipped: args.skip,
    notes,
  }) as Parameters<typeof formatReport>[1];
  const code = exitCodeFor(results);
  const output = args.json
    ? JSON.stringify({ ...meta, exitCode: code, results }, null, 2)
    : formatReport(results, meta);
  return { output, code };
}

async function main() {
  try {
    const { output, code } = await runPreflight(process.argv.slice(2));
    console.log(output);
    process.exitCode = code;
  } catch (error) {
    console.error(
      `preflight: ${redactSecretsForArtifact((error as Error).message)}`
    );
    process.exitCode = 2;
  }
}

// Only when run as a script, so the checks can be imported by tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
