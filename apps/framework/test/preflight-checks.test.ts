import {
  DEFAULT_ISSUE_TRIGGERS,
  type HookdeckResource,
} from '@hookdeck-evals/hookdeck';
import {
  HOOKDECK_CLI_VERSION,
  SKILLS_CLI_VERSION,
  sandboxImageDefinition,
} from '@hookdeck-evals/sandbox';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVALS_ROOT } from '../lib/discovery.js';
import { parsePreflightArgs } from '../lib/preflight/args.js';
import {
  classifyMissingSecrets,
  evaluateChecksRun,
  evaluateGatewayProject,
  evaluateOutpostGateway,
} from '../lib/preflight/evaluate.js';
import {
  checkCanary,
  checkMainGreen,
  checkProjects,
  checkSecrets,
  publishedInstrument,
  type Context,
  type Deps,
} from '../scripts/preflight.js';

/**
 * The checks themselves, run against fakes. Everything they reach goes through
 * `Deps`, so nothing here touches a network, a project or GitHub.
 */

const read = (path: string) => readFileSync(join(EVALS_ROOT, path), 'utf8');

type Exec = Deps['exec'];

function fakeDeps(over: Partial<Deps> = {}): Deps {
  return {
    root: EVALS_ROOT,
    env: {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'not faked' }),
    fetch: (async () => {
      throw new Error('fetch not faked');
    }) as unknown as typeof fetch,
    resolveHost: async () => true,
    gateway: () => ({ list: async () => [] }),
    outpost: () => ({
      tenants: async () => [],
      get: async () => {
        throw new Error('outpost not faked');
      },
    }),
    sleep: async () => undefined,
    ...over,
  };
}

function fakeContext(over: Partial<Context> = {}): Context {
  return {
    deps: fakeDeps(),
    args: parsePreflightArgs([]),
    repo: 'hookdeck/evals',
    headSha: 'h'.repeat(40),
    dirty: false,
    dispatchSha: 'm'.repeat(40),
    lastRelease: 'v0.4.0',
    workflow: read('.github/workflows/eval-refresh.yml'),
    experiments: [
      {
        name: 'claude-code-sonnet-5',
        agent: 'claude-code',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        suites: ['benchmark', 'regression'],
      },
      {
        name: 'codex-gpt-5.6',
        agent: 'codex',
        provider: 'openai',
        model: 'gpt-5.6',
        suites: ['benchmark', 'regression'],
      },
    ],
    cells: [],
    experimentsInPlan: new Set(['claude-code-sonnet-5', 'codex-gpt-5.6']),
    agentsInPlan: new Set(['claude-code', 'codex']),
    evalsRequiringOutpost: [],
    skills: { slug: 'hookdeck/agent-skills', names: [], dirs: [] },
    ...over,
  };
}

/** An `exec` that answers by matching the joined command line. */
function scriptedExec(
  answers: Array<[RegExp, string | { code: number; stdout?: string }]>
): Exec {
  return async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    for (const [re, answer] of answers) {
      if (!re.test(line)) continue;
      return typeof answer === 'string'
        ? { code: 0, stdout: answer, stderr: '' }
        : { code: answer.code, stdout: answer.stdout ?? '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected: ${line}` };
  };
}

// Finding 1: the canary compares each agent against its own newest cells -----

describe('canary run selection', () => {
  const currentDockerfile = read('packages/sandbox/Dockerfile');
  const runner = (agent: string) =>
    read(`packages/core/src/agents/${agent}/runner.ts`);

  /**
   * Two published runs: `old-run` had Codex and Claude cells on an older
   * Dockerfile; `new-run`, newer, was a Claude-only partial publish on the
   * current one. A Codex cell has never run on the current image.
   */
  const rows = [
    {
      experiment: 'codex-gpt-5.6',
      runId: 'old-run',
      ranAt: '2026-11-05T10:00:00Z',
      experimentDisplay: { agent: 'codex', modelId: 'gpt-5.6' },
    },
    {
      experiment: 'claude-code-sonnet-5',
      runId: 'old-run',
      ranAt: '2026-11-05T11:00:00Z',
      experimentDisplay: { agent: 'claude-code', modelId: 'claude-sonnet-5' },
    },
    {
      experiment: 'claude-code-sonnet-5',
      runId: 'new-run',
      ranAt: '2026-11-06T17:00:00Z',
      experimentDisplay: { agent: 'claude-code', modelId: 'claude-sonnet-5' },
    },
  ];

  const exec = scriptedExec([
    [
      /gh run view old-run --json headSha/,
      JSON.stringify({ headSha: 'oldsha' }),
    ],
    [
      /gh run view new-run --json headSha/,
      JSON.stringify({ headSha: 'newsha' }),
    ],
    // The old run's image is a different Dockerfile; everything else matches.
    [
      /git show oldsha:packages\/sandbox\/Dockerfile/,
      `${currentDockerfile}\n# older\n`,
    ],
    [/git show newsha:packages\/sandbox\/Dockerfile/, currentDockerfile],
    [
      /git show \w+:packages\/sandbox\/src\/image.ts/,
      read('packages/sandbox/src/image.ts'),
    ],
    [
      /git show \w+:packages\/sandbox\/src\/skills.ts/,
      read('packages/sandbox/src/skills.ts'),
    ],
    [
      /git show \w+:packages\/core\/src\/agents\/codex\/runner.ts/,
      runner('codex'),
    ],
    [
      /git show \w+:packages\/core\/src\/agents\/claude-code\/runner.ts/,
      runner('claude-code'),
    ],
  ]);

  const ctx = () =>
    fakeContext({
      deps: fakeDeps({ exec }),
      latest: { results: rows },
    });

  it('reads Codex from the newest run that had Codex cells, not the newest run', async () => {
    const published = await publishedInstrument(ctx());
    expect(published.byAgent['claude-code']?.source).toBe(
      'run new-run at newsha'
    );
    expect(published.byAgent.codex?.source).toBe('run old-run at oldsha');
    expect(published.byAgent['claude-code']?.imageDefinition).toBe(
      sandboxImageDefinition()
    );
    expect(published.byAgent.codex?.imageDefinition).not.toBe(
      sandboxImageDefinition()
    );
    expect(published.byAgent.codex?.hookdeckCli).toBe(HOOKDECK_CLI_VERSION);
    expect(published.byAgent.codex?.skillsCli).toBe(SKILLS_CLI_VERSION);
  });

  it('requires a canary for Codex after a Claude-only publish on a new image', async () => {
    const result = await checkCanary(ctx());
    expect(result.status).toBe('fail');
    const moved = result.details.filter(
      (d) => d.includes('->') && d.startsWith('  ')
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain(
      'sandbox image definition (codex cells, run old-run at oldsha)'
    );
    expect(result.details.join('\n')).toContain(
      'gh workflow run eval-refresh.yml'
    );
    expect(result.details.join('\n')).toContain('codex-gpt-5.6');
  });

  it('requires nothing when every agent last ran on the current instrument', async () => {
    const same = scriptedExec([
      [/gh run view \S+ --json headSha/, JSON.stringify({ headSha: 'newsha' })],
      [/git show newsha:packages\/sandbox\/Dockerfile/, currentDockerfile],
      [
        /git show newsha:packages\/sandbox\/src\/image.ts/,
        read('packages/sandbox/src/image.ts'),
      ],
      [
        /git show newsha:packages\/sandbox\/src\/skills.ts/,
        read('packages/sandbox/src/skills.ts'),
      ],
      [
        /git show newsha:packages\/core\/src\/agents\/codex\/runner.ts/,
        runner('codex'),
      ],
      [
        /git show newsha:packages\/core\/src\/agents\/claude-code\/runner.ts/,
        runner('claude-code'),
      ],
    ]);
    const result = await checkCanary(
      fakeContext({ deps: fakeDeps({ exec: same }), latest: { results: rows } })
    );
    expect(result.status).toBe('pass');
  });
});

// Finding 3: main-green from a pull request's Checks run ----------------------

describe('main is green, from a pull request', () => {
  const steps = [
    { name: 'Check formatting', conclusion: 'success' },
    { name: 'Typecheck', conclusion: 'success' },
    { name: 'Unit tests', conclusion: 'success' },
    { name: 'Build', conclusion: 'success' },
  ];
  const evidence = {
    mainSha: 'm'.repeat(40),
    prNumber: 130,
    runId: 1,
    runCreatedAt: '2026-11-06T12:00:00Z',
    conclusion: 'success',
    steps,
  };

  it('passes when the base was committed before the run started', () => {
    expect(
      evaluateChecksRun({
        ...evidence,
        baseCommittedAt: '2026-11-06T11:00:00Z',
      }).status
    ).toBe('pass');
  });

  it('fails when the base moved after the run started', () => {
    const verdict = evaluateChecksRun({
      ...evidence,
      baseCommittedAt: '2026-11-06T13:00:00Z',
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toMatch(/base moved after #130's Checks started/);
  });

  it('fails when the base cannot be read, or a step did not pass', () => {
    expect(evaluateChecksRun(evidence).status).toBe('fail');
    expect(
      evaluateChecksRun({
        ...evidence,
        baseCommittedAt: '2026-11-06T11:00:00Z',
        steps: steps.map((s) =>
          s.name === 'Typecheck' ? { ...s, conclusion: 'failure' } : s
        ),
      }).status
    ).toBe('fail');
  });

  it('reads main, its pull request, the run and the base through Deps', async () => {
    const main = 'm'.repeat(40);
    const exec = scriptedExec([
      [
        /commits\/m+\/pulls/,
        JSON.stringify([
          { number: 130, merge_commit_sha: main, head: { sha: 'prhead' } },
        ]),
      ],
      [
        /gh run list --workflow biome.yml --commit prhead/,
        JSON.stringify([
          {
            databaseId: 7,
            conclusion: 'success',
            headSha: 'prhead',
            event: 'pull_request',
            createdAt: '2026-11-06T12:00:00Z',
          },
        ]),
      ],
      [
        /gh run view 7 --json conclusion,jobs/,
        JSON.stringify({ conclusion: 'success', jobs: [{ steps }] }),
      ],
      [/commits\/base --jq/, '2026-11-06T13:30:00Z\n'],
      [
        /repos\/hookdeck\/evals\/commits\/m+$/,
        JSON.stringify({ parents: [{ sha: 'base' }] }),
      ],
    ]);
    const result = await checkMainGreen(
      fakeContext({ deps: fakeDeps({ exec }) })
    );
    expect(result.status).toBe('fail');
    expect(result.details.join('\n')).toContain(
      'base committed 2026-11-06T13:30:00Z'
    );
  });
});

// Secrets ---------------------------------------------------------------------

describe('secrets', () => {
  const agents = [
    { id: 'claude-code', apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
    { id: 'codex', apiKeyEnvVar: 'OPENAI_API_KEY' },
    { id: 'opencode', apiKeyEnvVar: 'AI_GATEWAY_API_KEY' },
  ];

  it('excuses only the key of an agent no experiment uses', () => {
    expect(
      classifyMissingSecrets(
        ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'OUTPOST_API_KEY'],
        new Set(),
        agents,
        new Set(['claude-code', 'codex'])
      )
    ).toEqual({
      fatal: ['OPENAI_API_KEY', 'OUTPOST_API_KEY'],
      unneeded: ['AI_GATEWAY_API_KEY'],
    });
  });

  it('does not excuse a key once an experiment uses its agent', () => {
    expect(
      classifyMissingSecrets(
        ['AI_GATEWAY_API_KEY'],
        new Set(),
        agents,
        new Set(['opencode'])
      ).fatal
    ).toEqual(['AI_GATEWAY_API_KEY']);
  });

  it('fails the check on a needed secret the repository lacks', async () => {
    const exec = scriptedExec([
      [
        /gh secret list/,
        JSON.stringify([
          { name: 'ANTHROPIC_API_KEY' },
          { name: 'OPENAI_API_KEY' },
        ]),
      ],
    ]);
    const result = await checkSecrets(
      fakeContext({ deps: fakeDeps({ exec }) })
    );
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('HOOKDECK_API_KEY');
    expect(result.summary).not.toContain('AI_GATEWAY_API_KEY');
  });
});

// Projects are pristine -------------------------------------------------------

const defaults = (): HookdeckResource[] =>
  DEFAULT_ISSUE_TRIGGERS.map((d, i) => ({
    id: `it_${i}`,
    type: d.type,
    configs: d.configs,
    channels: {},
    disabled_at: null,
    name: null,
    created_at: '2026-08-07T00:00:00Z',
  }));

describe('projects are pristine', () => {
  it('accepts exactly the declared default triggers and nothing else', () => {
    expect(
      evaluateGatewayProject({ 'issue-triggers': defaults(), sources: [] })
    ).toEqual([]);
  });

  it('names a leftover, a duplicate, a rewritten default and an undeclared type', () => {
    const triggers = defaults();
    triggers[0] = {
      ...triggers[0],
      channels: { email: {} },
    } as HookdeckResource;
    triggers.push({
      id: 'it_dup',
      type: DEFAULT_ISSUE_TRIGGERS[1]?.type,
      configs: {},
    });
    triggers.push({ id: 'it_new', type: 'mystery' });
    const fails = evaluateGatewayProject({
      'issue-triggers': triggers,
      sources: [{ id: 'src_1', name: 'stripe' }],
    });
    expect(fails.join('\n')).toContain(
      'evals-ci holds 1 sources: src_1 (stripe)'
    );
    expect(fails.join('\n')).toContain(`differs from DEFAULT_ISSUE_TRIGGERS`);
    expect(fails.join('\n')).toContain(
      `2 ${DEFAULT_ISSUE_TRIGGERS[1]?.type} issue triggers`
    );
    expect(fails.join('\n')).toContain(
      'undeclared mystery issue trigger it_new'
    );
  });

  it('compares the Outpost gateway side by id against its baseline', () => {
    const baseline = { capturedAt: 'declared', ids: { sources: ['src_ok'] } };
    expect(
      evaluateOutpostGateway(
        { sources: [{ id: 'src_ok' }, { id: 'src_left' }], connections: [] },
        baseline
      )
    ).toEqual([
      "the Outpost project's gateway side holds 1 sources its baseline does not declare: src_left",
    ]);
  });

  it('passes both projects, and masks the destination URL, through Deps', async () => {
    const sourceUrl = 'https://hkdk.events/secretpath123';
    const deps = fakeDeps({
      env: { HOOKDECK_API_KEY: 'gateway-key', OUTPOST_API_KEY: 'outpost-key' },
      gateway: (key) => ({
        list: async (kind) => {
          if (key === 'gateway-key' && kind === 'issue-triggers')
            return defaults();
          if (key === 'gateway-key' && kind === 'sources') return [];
          return [];
        },
      }),
      outpost: () => ({
        tenants: async () => [],
        get: async <T>(path: string) => {
          if (path === '/operator-events/destinations') {
            return [
              {
                id: 'des_1',
                type: 'webhook',
                topics: ['*'],
                config: { url: sourceUrl },
              },
            ] as T;
          }
          throw new Error('Outpost GET failed: 500');
        },
      }),
    });
    const result = await checkProjects(fakeContext({ deps }));
    // The source is in neither project these keys see, so it cannot be verified.
    expect(result.status).toBe('warn');
    const text = [result.summary, ...result.details].join('\n');
    expect(text).toContain('https://hkdk.events/****');
    expect(text).not.toContain('secretpath123');
    expect(text).toContain('could not read attempts');
    expect(text).not.toContain('0 attempts');
  });

  it('fails on a stray tenant and on a mock endpoint as the alert destination', async () => {
    const deps = fakeDeps({
      env: { HOOKDECK_API_KEY: 'gateway-key', OUTPOST_API_KEY: 'outpost-key' },
      gateway: (key) => ({
        list: async (kind) =>
          key === 'gateway-key' && kind === 'issue-triggers' ? defaults() : [],
      }),
      outpost: () => ({
        tenants: async () => [{ id: 'acme' }],
        get: async <T>(path: string) =>
          (path === '/operator-events/destinations'
            ? [
                {
                  id: 'des_1',
                  type: 'webhook',
                  config: { url: 'https://mock.hookdeck.com/x' },
                },
              ]
            : { models: [] }) as T,
      }),
    });
    const result = await checkProjects(fakeContext({ deps }));
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('stray Outpost tenants: acme');
    expect(result.summary).toContain('mock endpoint');
  });

  it('refuses an Outpost key that is the gateway key', async () => {
    const deps = fakeDeps({
      env: { HOOKDECK_API_KEY: 'same', OUTPOST_API_KEY: 'same' },
      gateway: () => ({
        list: async (kind) => (kind === 'issue-triggers' ? defaults() : []),
      }),
    });
    const result = await checkProjects(fakeContext({ deps }));
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('#111');
  });
});
