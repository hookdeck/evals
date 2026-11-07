import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { basePromptFor, extractBasePrompt } from '../lib/base-prompt.js';
import { EVALS_ROOT } from '../lib/discovery.js';
import { CHECKS, parsePreflightArgs } from '../lib/preflight/args.js';
import {
  canaryPlan,
  diffInstrument,
  modelsFromRows,
  newestRunPerAgent,
  readPin,
} from '../lib/preflight/canary.js';
import {
  changedSkills,
  checkLink,
  collectLinks,
  extractDocsUrls,
  fetchableUrl,
} from '../lib/preflight/links.js';
import { attemptsFor, planCells } from '../lib/preflight/matrix.js';
import {
  modelFamily,
  modelStanding,
  modelVersion,
} from '../lib/preflight/models.js';
import {
  DECISION_FOOTER,
  exitCodeFor,
  formatReport,
  maskSecrets,
  maskUrlPath,
  type CheckResult,
} from '../lib/preflight/report.js';
import {
  compareSemver,
  describeVersionGap,
  parseSemver,
} from '../lib/preflight/semver.js';
import {
  attemptMultiplier,
  costKey,
  estimateSpend,
  failRatesFromRows,
  parseCostTable,
} from '../lib/preflight/spend.js';
import {
  fillTemplate,
  providerProbes,
  refusalPattern,
  stepScript,
  unfinishedRuns,
  workflowSecrets,
  workflowVariables,
} from '../lib/preflight/workflow.js';

const read = (path: string) => readFileSync(join(EVALS_ROOT, path), 'utf8');
const WORKFLOW = read('.github/workflows/eval-refresh.yml');

describe('semver', () => {
  it('parses plain and prefixed versions and rejects anything else', () => {
    expect(parseSemver('2.5.0')).toEqual({ major: 2, minor: 5, patch: 0 });
    expect(parseSemver('v3.1.0-beta.1')).toEqual({
      major: 3,
      minor: 1,
      patch: 0,
      prerelease: 'beta.1',
    });
    expect(parseSemver('latest')).toBeUndefined();
  });

  it('orders numerically, not lexically, and puts a prerelease first', () => {
    expect(compareSemver('2.1.191', '2.1.319')).toBe(-1);
    expect(compareSemver('0.138.0', '0.67.0')).toBe(1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(() => compareSemver('x', '1.0.0')).toThrow(/not a version/);
  });

  it('orders prerelease identifiers as semver does', () => {
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareSemver('1.0.0-beta', '1.0.0-alpha.9')).toBe(1);
  });

  it('names the largest component that moved', () => {
    expect(describeVersionGap('2.5.0', '3.1.0')).toBe(
      '1 major version behind (2.5.0 -> 3.1.0)'
    );
    expect(describeVersionGap('0.138.0', '0.167.0')).toBe(
      '29 minor versions behind (0.138.0 -> 0.167.0)'
    );
    expect(describeVersionGap('2.1.191', '2.1.319')).toBe(
      '128 patch versions behind (2.1.191 -> 2.1.319)'
    );
    expect(describeVersionGap('2.5.0', '2.5.0')).toBe('up to date (2.5.0)');
    expect(describeVersionGap('3.0.0', '2.9.9')).toMatch(/^ahead of latest/);
  });
});

describe('workflow parsing, against the real eval-refresh.yml', () => {
  it('reads every secret the workflow references, without GITHUB_TOKEN', () => {
    const secrets = workflowSecrets(WORKFLOW);
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'HOOKDECK_API_KEY',
      'HOOKDECK_WEBHOOK_SECRET',
      'OUTPOST_API_KEY',
    ]) {
      expect(secrets).toContain(name);
    }
    expect(secrets).not.toContain('GITHUB_TOKEN');
  });

  it('ignores names that appear only in comments', () => {
    const yaml = [
      '# secrets.ONLY_IN_PROSE is mentioned here',
      '      env:',
      '        A: ${{ secrets.REAL_ONE }}',
      '        B: ${{ vars.SOME_VAR || 1 }}',
      '        T: ${{ secrets.GITHUB_TOKEN }}',
    ].join('\n');
    expect(workflowSecrets(yaml)).toEqual(['REAL_ONE']);
    expect(workflowVariables(yaml)).toEqual(['SOME_VAR']);
  });

  it('reads both repository variables the publish job depends on', () => {
    expect(workflowVariables(WORKFLOW)).toEqual(
      expect.arrayContaining(['EVALS_PUBLISH', 'EVALS_MAX_MISSING_FRACTION'])
    );
  });

  it('extracts the provider preflight requests the workflow makes', () => {
    const probes = providerProbes(WORKFLOW);
    expect(probes.map((p) => p.provider).sort()).toEqual([
      'anthropic',
      'openai',
    ]);
    const openai = probes.find((p) => p.provider === 'openai');
    expect(openai?.url).toBe('https://api.openai.com/v1/responses');
    expect(openai?.headers.Authorization).toBe('Bearer ${OPENAI_API_KEY}');
    expect(openai?.model).toBeTruthy();
    const anthropic = probes.find((p) => p.provider === 'anthropic');
    expect(anthropic?.headers['x-api-key']).toBe('${ANTHROPIC_API_KEY}');
    expect(JSON.parse(anthropic?.body ?? '{}').max_tokens).toBe(1);
  });

  it('bounds a step at the next step', () => {
    const yaml = [
      '    steps:',
      '      - name: First',
      '        run: echo one',
      '      - name: Second',
      '        run: echo two',
    ].join('\n');
    expect(stepScript(yaml, 'First')).toContain('echo one');
    expect(stepScript(yaml, 'First')).not.toContain('echo two');
    expect(stepScript(yaml, 'Missing')).toBeUndefined();
  });

  it('fills placeholders and names the missing ones instead of sending empty', () => {
    expect(fillTemplate('Bearer ${KEY}', { KEY: 'abc' })).toEqual({
      value: 'Bearer abc',
      missing: [],
    });
    expect(fillTemplate('Bearer ${KEY}', {}).missing).toEqual(['KEY']);
  });

  it('recognises a refusal in the words the run cancels on', () => {
    const re = refusalPattern(WORKFLOW);
    expect(re?.test('{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(re?.test('{"ok":true}')).toBe(false);
  });

  it('treats every unfinished status as running', () => {
    const runs = [
      { status: 'completed' },
      { status: 'in_progress' },
      { status: 'queued' },
      { status: 'pending' },
      { status: 'waiting' },
    ];
    expect(unfinishedRuns(runs)).toHaveLength(4);
  });
});

describe('spend', () => {
  it('reads the measured table out of AGENTS.md', () => {
    const table = parseCostTable(read('AGENTS.md'));
    expect(table?.denominator).toBe(15);
    expect(Object.keys(table?.perPass ?? {}).sort()).toEqual([
      'claude-code-sonnet-5',
      'codex-gpt-5.4-mini',
      'codex-gpt-5.6',
    ]);
    expect(table?.judgePerPass).toBeGreaterThan(0);
  });

  it('returns nothing rather than guessing when the table is absent', () => {
    expect(parseCostTable('# no table here')).toBeUndefined();
  });

  it('prices the no-skills twin with its skills arm', () => {
    expect(costKey('codex-gpt-5.6-no-skills')).toBe('codex-gpt-5.6');
  });

  it('pays for a retry only when the attempt before it failed', () => {
    expect(attemptMultiplier(0.5, 1, 1)).toBe(1);
    expect(attemptMultiplier(0.5, 3, 1)).toBeCloseTo(1.75);
    expect(attemptMultiplier(0.5, 3, 3)).toBeCloseTo(3.25);
    expect(attemptMultiplier(0, 5, 3)).toBe(1);
  });

  it('estimates per experiment and names one it cannot price', () => {
    const costs = {
      denominator: 10,
      perPass: { a: 10, b: 20 },
      judgePerPass: 1,
    };
    const estimate = estimateSpend(
      [
        { experiment: 'a', eval: 'x', runs: 1 },
        { experiment: 'a-no-skills', eval: 'x', runs: 1 },
        { experiment: 'mystery', eval: 'x', runs: 1 },
      ],
      costs,
      { a: { rate: 0, source: 't' } }
    );
    const byName = Object.fromEntries(
      estimate.rows.map((r) => [r.experiment, r])
    );
    expect(byName.a?.perAttempt).toBeCloseTo(1.1);
    expect(byName['a-no-skills']?.perAttempt).toBeCloseTo(1.1);
    // Priced at the dearest measured figure, and flagged.
    expect(byName.mystery?.perAttempt).toBeCloseTo(2.1);
    expect(estimate.unpriced).toEqual(['mystery']);
    expect(estimate.low).toBeCloseTo(4.3);
    expect(estimate.high).toBeGreaterThanOrEqual(estimate.low);
  });

  it('derives a fail rate from rows that retried or failed', () => {
    const rates = failRatesFromRows([
      { experiment: 'a', passed: true, attempts: 1 },
      { experiment: 'a', passed: true, attempts: 2 },
      { experiment: 'a', passed: false, attempts: 3 },
      { experiment: 'a', passed: true },
    ]);
    expect(rates.a?.rate).toBe(0.5);
    expect(rates.a?.source).toMatch(/2\/4/);
  });
});

describe('links', () => {
  it('finds absolute and root-relative docs URLs and drops trailing punctuation', () => {
    const text = [
      'See https://hookdeck.com/docs/connections.md.',
      'curl https://hookdeck.com/docs/filters.md',
      '| Sources | `/docs/sources.md` |',
      'and [publish](/docs/api/publish.md#send), or `/docs/sources.md` again',
      'not https://example.com/docs/x or https://hookdeck.com/pricing',
    ].join('\n');
    expect(extractDocsUrls(text)).toEqual([
      'https://hookdeck.com/docs/connections.md',
      'https://hookdeck.com/docs/filters.md',
      'https://hookdeck.com/docs/sources.md',
      'https://hookdeck.com/docs/api/publish.md#send',
    ]);
  });

  it('fetches without the fragment and groups files by what is fetched', () => {
    expect(fetchableUrl('https://hookdeck.com/docs/a.md#x')).toBe(
      'https://hookdeck.com/docs/a.md'
    );
    const links = collectLinks([
      { path: 'one.md', text: 'https://hookdeck.com/docs/a.md#x' },
      { path: 'two.md', text: '`/docs/a.md`' },
    ]);
    expect(links).toEqual([
      { url: 'https://hookdeck.com/docs/a.md', files: ['one.md', 'two.md'] },
    ]);
  });

  const respond = (
    status: number,
    over: { redirected?: boolean; url?: string; retryAfter?: string } = {}
  ) =>
    ({
      status,
      redirected: over.redirected ?? false,
      url: over.url ?? '',
      headers: new Headers(
        over.retryAfter ? { 'retry-after': over.retryAfter } : {}
      ),
      body: null,
    }) as unknown as Response;

  it('reports where a redirect ended', async () => {
    const result = await checkLink(
      async () =>
        respond(200, {
          redirected: true,
          url: 'https://hookdeck.com/docs/api/configure.md',
        }),
      'https://hookdeck.com/docs/api/sources.md'
    );
    expect(result).toEqual({
      url: 'https://hookdeck.com/docs/api/sources.md',
      status: 200,
      finalUrl: 'https://hookdeck.com/docs/api/configure.md',
    });
  });

  it('does not report a trailing-slash redirect as a moved page', async () => {
    const result = await checkLink(
      async () =>
        respond(200, { redirected: true, url: 'https://hookdeck.com/docs' }),
      'https://hookdeck.com/docs/'
    );
    expect(result.finalUrl).toBeUndefined();
  });

  it('backs off once on a 429, honouring Retry-After, then reports what it got', async () => {
    const answers = [respond(429, { retryAfter: '2' }), respond(200)];
    const sleeps: number[] = [];
    const result = await checkLink(
      async () => answers.shift() as Response,
      'https://hookdeck.com/docs/a.md',
      async (ms) => {
        sleeps.push(ms);
      }
    );
    expect(result.status).toBe(200);
    expect(sleeps).toEqual([2000]);

    const limited = await checkLink(
      async () => respond(429),
      'https://hookdeck.com/docs/a.md',
      async () => undefined
    );
    expect(limited.status).toBe(429);
  });

  it('retries a dropped connection once and reports 0 if it stays down', async () => {
    let calls = 0;
    const result = await checkLink(async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    }, 'https://hookdeck.com/docs/a.md');
    expect(calls).toBe(2);
    expect(result.status).toBe(0);
  });

  it('maps changed paths to the skills they belong to', () => {
    expect(
      changedSkills([
        'skills/hookdeck/SKILL.md',
        'skills/hookdeck/references/x.md',
        'skills/inspect/SKILL.md',
        'README.md',
      ])
    ).toEqual(['hookdeck', 'inspect']);
  });
});

describe('models', () => {
  it('groups ids into families by stripping the version', () => {
    expect(modelFamily('claude-sonnet-5')).toBe('claude-sonnet-N');
    expect(modelFamily('claude-sonnet-5-5')).toBe('claude-sonnet-N');
    expect(modelFamily('gpt-5.4-mini')).toBe('gpt-N-mini');
    expect(modelVersion('gpt-5.4-mini-2026-03-17')).toEqual([5, 4]);
  });

  it('reports newer siblings and listed variants, ignoring dated snapshots', () => {
    const listed = [
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4-mini',
      'gpt-5.4-mini-2026-03-17',
    ];
    expect(modelStanding('claude-sonnet-5', listed)).toEqual({
      model: 'claude-sonnet-5',
      listed: true,
      variants: ['claude-sonnet-5-5'],
      newer: ['claude-sonnet-5-5'],
    });
    const codex = modelStanding('gpt-5.6', listed);
    expect(codex.listed).toBe(false);
    expect(codex.variants).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol']);
    expect(codex.newer).toEqual([]);
    expect(modelStanding('gpt-5.4-mini', listed).newer).toEqual([]);
  });
});

describe('canary', () => {
  const agent = {
    imageDefinition: 'aaa',
    hookdeckCli: '2.5.0',
    skillsCli: '1.5.11',
    agentCli: '0.138.0',
  };
  const base = {
    byAgent: { codex: agent },
    models: { 'codex-gpt-5.6': 'gpt-5.6' },
  };

  it('needs nothing when the instrument matches', () => {
    expect(
      diffInstrument(
        { ...base, byAgent: { codex: { ...agent, source: 'run 1 at abc' } } },
        base
      )
    ).toEqual([]);
  });

  it('names each moved part per agent, and counts an unknown published value as moved', () => {
    const changes = diffInstrument(
      {
        byAgent: {
          codex: {
            ...agent,
            imageDefinition: undefined,
            source: 'run 1 at abc',
          },
        },
        models: base.models,
      },
      {
        byAgent: {
          codex: { ...agent, hookdeckCli: '3.1.0', skillsCli: '1.6.0' },
        },
        models: { ...base.models, 'new-experiment': 'gpt-6' },
      }
    );
    expect(changes).toEqual([
      {
        what: 'sandbox image definition (codex cells, run 1 at abc)',
        published: 'unknown',
        current: 'aaa',
        agent: 'codex',
      },
      {
        what: 'Hookdeck CLI pin (codex cells, run 1 at abc)',
        published: '2.5.0',
        current: '3.1.0',
        agent: 'codex',
      },
      {
        what: 'skills CLI pin (codex cells, run 1 at abc)',
        published: '1.5.11',
        current: '1.6.0',
        agent: 'codex',
      },
      { what: 'new-experiment model', published: 'unknown', current: 'gpt-6' },
    ]);
  });

  it('treats an agent with no published cells as entirely unknown', () => {
    const changes = diffInstrument(
      { byAgent: {}, models: {} },
      { byAgent: { codex: agent }, models: {} }
    );
    expect(changes.map((c) => c.published)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(changes[0]?.what).toContain('no published run');
  });

  it('picks, per agent, the newest run that has that agent’s rows', () => {
    const agentOf = (e: string) =>
      e.startsWith('claude') ? 'claude-code' : 'codex';
    const rows = [
      {
        experiment: 'codex-gpt-5.6',
        runId: 'older',
        ranAt: '2026-11-05T10:00:00Z',
      },
      {
        experiment: 'claude-code-sonnet-5',
        runId: 'older',
        ranAt: '2026-11-05T11:00:00Z',
      },
      // A Claude-only partial publish, newer than anything Codex ran in.
      {
        experiment: 'claude-code-sonnet-5',
        runId: 'newest',
        ranAt: '2026-11-06T17:00:00Z',
      },
    ];
    expect(newestRunPerAgent(rows, agentOf)).toEqual({
      'claude-code': 'newest',
      codex: 'older',
    });
  });

  it('takes each experiment’s model from its newest row', () => {
    expect(
      modelsFromRows([
        { experiment: 'a', ranAt: '1', experimentDisplay: { modelId: 'old' } },
        { experiment: 'a', ranAt: '2', experimentDisplay: { modelId: 'new' } },
        { experiment: 'b', ranAt: '1' },
      ])
    ).toEqual({ a: 'new' });
  });

  it('reads pins out of the real sources', () => {
    expect(
      readPin(read('packages/sandbox/src/image.ts'), 'HOOKDECK_CLI_VERSION')
    ).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      readPin(read('packages/sandbox/src/skills.ts'), 'SKILLS_CLI_VERSION')
    ).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      readPin(
        read('packages/core/src/agents/codex/runner.ts'),
        'defaultCliVersion'
      )
    ).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints the exact dispatch for two cells with publishing held', () => {
    const plan = canaryPlan(
      ['claude-code-sonnet-5', 'codex-gpt-5.6'],
      'benchmark-localdev-001-listen-locally',
      'benchmark',
      ['benchmark', 'benchmark']
    );
    expect(plan.commands[0]).toBe('gh variable set EVALS_PUBLISH --body false');
    expect(plan.commands[1]).toBe(
      'gh workflow run eval-refresh.yml -f suite=benchmark -f experiment_suite=benchmark' +
        ' -f experiments=claude-code-sonnet-5,codex-gpt-5.6' +
        ' -f eval=benchmark-localdev-001-listen-locally -f runs=1'
    );
    expect(plan.commands).toContain('gh variable delete EVALS_PUBLISH');
  });
});

describe('matrix planning, mirroring the workflow', () => {
  const evals = [
    { id: 'bm-1', suite: 'benchmark', metadata: {} },
    { id: 'bm-2', suite: 'benchmark', metadata: { minAttempts: 3 } },
    { id: 'reg-1', suite: 'regression', metadata: {} },
  ];
  const experiments = [
    { name: 'skills', suites: ['benchmark', 'regression'] },
    {
      name: 'skills-no-skills',
      suites: ['no-skills', 'regression'],
      skipEval: (ev: { id: string }) => ev.id === 'bm-1',
    },
  ];

  it('runs a benchmark scenario under both arms, honouring skipEval', () => {
    const cells = planCells(evals, experiments as never, {
      suites: ['benchmark'],
      experimentSuites: ['benchmark', 'no-skills'],
      experiments: [],
      evalIds: [],
      runs: 2,
    });
    expect(cells.map((c) => `${c.experiment}/${c.eval}/${c.runs}`)).toEqual([
      'skills/bm-1/2',
      'skills/bm-2/3',
      'skills-no-skills/bm-2/3',
    ]);
  });

  it('lets named evals override the suite filter, as the workflow does', () => {
    const cells = planCells(evals, experiments as never, {
      suites: ['regression'],
      experimentSuites: ['benchmark'],
      experiments: ['skills'],
      evalIds: ['bm-1'],
      runs: 1,
    });
    expect(cells.map((c) => c.eval)).toEqual(['bm-1']);
  });

  it('caps min_attempts at five and never lowers --runs', () => {
    expect(attemptsFor(2, 3)).toBe(3);
    expect(attemptsFor(4, 3)).toBe(4);
    expect(attemptsFor(2, 9)).toBe(5);
  });
});

describe('arguments', () => {
  it('defaults to what a bare workflow_dispatch runs', () => {
    const args = parsePreflightArgs([]);
    expect(args.dispatch).toEqual({
      suites: ['regression'],
      experimentSuites: ['regression'],
      experiments: [],
      evalIds: [],
      runs: 2,
    });
    expect(args.holdPublish).toBe(false);
    expect(args.maxMissingFraction).toBe('0.1');
  });

  it('accepts the dispatch flags and issue numbers in either form', () => {
    const args = parsePreflightArgs([
      '--',
      '--suite',
      'benchmark',
      '--experiment-suite=benchmark,no-skills',
      '--runs',
      '3',
      '--accept-harness',
      '#42,131',
      '--skip',
      'skill-links',
      '--json',
    ]);
    expect(args.dispatch.experimentSuites).toEqual(['benchmark', 'no-skills']);
    expect(args.dispatch.runs).toBe(3);
    expect(args.acceptHarness).toEqual([42, 131]);
    expect(args.skip).toEqual(['skill-links']);
    expect(args.json).toBe(true);
  });

  it('refuses an unknown check, flag or run count', () => {
    expect(() => parsePreflightArgs(['--skip', 'everything'])).toThrow(
      /no check named everything/
    );
    expect(() => parsePreflightArgs(['--yolo'])).toThrow(/unknown flag/);
    expect(() => parsePreflightArgs(['--runs', '0'])).toThrow(/positive/);
  });

  it('numbers the checks as #131 does, with the skills CLI after the canary', () => {
    expect(CHECKS.map((c) => c.number)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1)
    );
    expect(CHECKS[15]?.id).toBe('skills-cli-pin');
  });
});

describe('report', () => {
  const check = (over: Partial<CheckResult>): CheckResult => ({
    id: 'x',
    number: 1,
    title: 'X',
    kind: 'assertion',
    status: 'pass',
    summary: 'ok',
    details: [],
    ...over,
  });

  it('fails only on a failed assertion', () => {
    expect(exitCodeFor([check({ kind: 'decision', status: 'decide' })])).toBe(
      0
    );
    expect(exitCodeFor([check({ status: 'skipped' })])).toBe(0);
    expect(exitCodeFor([check({ status: 'warn' })])).toBe(0);
    expect(exitCodeFor([check({ status: 'fail' })])).toBe(1);
  });

  it('says where a decision is recorded and shouts about a skip', () => {
    const text = formatReport(
      [
        check({
          id: 'pin',
          kind: 'decision',
          status: 'decide',
          summary: 'behind',
        }),
        check({
          id: 'links',
          number: 13,
          status: 'skipped',
          summary: 'skipped',
        }),
        check({ id: 'spend', number: 7, status: 'fail', summary: 'no' }),
      ],
      {
        generatedAt: 'now',
        skipped: ['links'],
        notes: [],
      }
    );
    expect(text).toContain(DECISION_FOOTER);
    expect(text).toContain('!!! SKIPPED BY REQUEST: links !!!');
    expect(text).toContain(
      'Result: 1 assertion failed: spend. Do not dispatch.'
    );
    expect(text).toContain('1 decision to record in the release notes: pin');
    expect(text.indexOf('Decisions')).toBeLessThan(text.indexOf('Assertions'));
  });

  it('masks secret values, longest first', () => {
    expect(
      maskSecrets('key sk-abcdefgh123 and sk-abcdefgh', [
        'sk-abcdefgh',
        'sk-abcdefgh123',
        'short',
      ])
    ).toBe('key **** and ****');
  });

  it('masks a delivery URL down to its host', () => {
    expect(maskUrlPath('https://hkdk.events/hV1wGFnIHOex')).toBe(
      'https://hkdk.events/****'
    );
    expect(maskUrlPath('https://example.com/?token=abc')).toBe(
      'https://example.com/****'
    );
    expect(maskUrlPath('https://example.com/')).toBe('https://example.com/');
    expect(maskUrlPath('not a url')).toBe('****');
  });
});

describe('base prompt', () => {
  it('reads back what basePromptFor returns from its own source', () => {
    expect(extractBasePrompt(read('apps/framework/lib/base-prompt.ts'))).toBe(
      basePromptFor('tools')
    );
  });

  it('reads the older shape inside run-eval.ts, including a semicolon', () => {
    const source = [
      'function other() { return 1; }',
      'function basePromptFor(_mode: EvalMode): string {',
      '  return (',
      "    'First sentence; with a semicolon. ' +",
      '    "Second, double-quoted. " +',
      "    'It\\'s escaped.'",
      '  );',
      '}',
      'function buildSystemPrompt() {}',
    ].join('\n');
    expect(extractBasePrompt(source)).toBe(
      "First sentence; with a semicolon. Second, double-quoted. It's escaped."
    );
    expect(extractBasePrompt('no prompt here')).toBeUndefined();
  });
});
