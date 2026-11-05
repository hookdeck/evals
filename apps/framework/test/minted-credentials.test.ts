import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSandbox } from '@hookdeck-evals/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAttemptRecord } from '../harness/attempts.js';
import {
  cellSecrets,
  credentialsDiscovered,
  newAttemptLoopState,
  writeErroredEvidence,
} from '../harness/errored-cell.js';
import {
  ASSIGNED_CREDENTIAL,
  assignedCredentialValues,
  findUnredacted,
  redactText,
  serializeRedacted,
} from '../harness/redact.js';
import {
  credentialsFromConfigText,
  DISCOVER_COMMAND,
  discoverSandboxCredentials,
} from '../harness/sandbox-credentials.js';
import { checkArtifacts } from '../lib/artifact-check.js';
import type {
  DocsResult,
  SkillResult,
  TranscriptPart,
} from '../harness/types.js';

/**
 * Credentials the harness never injected: the key `hookdeck ci` mints inside
 * the sandbox and writes to the CLI config, which an agent then `cat`s. No env
 * var holds it, so redaction by value alone let it through.
 *
 * Every value here is fake and says so. The shape matches what the CLI writes
 * (fifty lowercase letters and digits), because the point is to prove the
 * patterns catch that shape in the context it actually appears in.
 */
const MINTED = `fakeminted0${'x'.repeat(39)}`;
const MINTED_TWO = `fakeminted1${'y'.repeat(39)}`;
const GUEST_URL = 'https://dashboard.hookdeck.com/guest/fake0guest0token0000';

/** What `cat ~/.config/hookdeck/config.toml` prints after `hookdeck ci`. */
function cliConfig(key = MINTED, extra = '') {
  return [
    "profile = 'default'",
    '',
    '[default]',
    `api_key = '${key}'`,
    "project_id = 'tm_fakeproject0'",
    "project_mode = 'inbound'",
    "project_type = 'gateway'",
    extra,
  ].join('\n');
}

function toolResult(output: string): TranscriptPart {
  return {
    type: 'tool_result',
    tool: { name: 'bash', originalName: 'exec_command' },
    output,
  } as unknown as TranscriptPart;
}

const skills: SkillResult = { available: [], loaded: [] };
const docs: DocsResult = { calls: [] };

describe('redaction by assignment', () => {
  it('removes the key from a CLI config the agent printed', () => {
    const out = serializeRedacted({ output: cliConfig() }, []);
    expect(out).not.toContain(MINTED);
    expect(out).toContain(`<redacted:${ASSIGNED_CREDENTIAL}-1>`);
    // Everything that is not a credential stays readable.
    expect(out).toContain('tm_fakeproject0');
    expect(out).toContain("project_mode = 'inbound'");
  });

  /**
   * "Configured the source with the wrong secret" is a failure the benchmark
   * exists to catch, and reading why needs to see whether two places held the
   * same value.
   */
  it('keeps distinct values distinguishable and equal values equal', () => {
    const out = redactText(
      [
        `STRIPE_WEBHOOK_SECRET=${MINTED}`,
        `--webhook-secret ${MINTED_TWO}`,
        `--webhook-secret ${MINTED}`,
      ].join('\n'),
      []
    );
    expect(out).toBe(
      [
        `STRIPE_WEBHOOK_SECRET=<redacted:${ASSIGNED_CREDENTIAL}-1>`,
        `--webhook-secret <redacted:${ASSIGNED_CREDENTIAL}-2>`,
        `--webhook-secret <redacted:${ASSIGNED_CREDENTIAL}-1>`,
      ].join('\n')
    );
  });

  it('covers the other forms the same key turns up in', () => {
    const forms = [
      `api_key = "${MINTED}"`, // TOML with double quotes, JSON-escaped below
      `api_key = '${MINTED}'$`, // cat -A
      `export HOOKDECK_CLI_TOKEN=${MINTED}`,
      `hookdeck ci --api-key ${MINTED}`,
      `hookdeck ci --api-key=${MINTED}`,
      `{"api_key": "${MINTED}"}`,
      `curl -H "Authorization: Bearer ${MINTED}" https://api.hookdeck.com`,
    ];
    for (const form of forms) {
      expect(serializeRedacted({ form }, [])).not.toContain(MINTED);
    }
  });

  it('removes the key where it later appears bare, once it was seen assigned', () => {
    const artifact = {
      transcript: [
        toolResult(cliConfig()),
        // No credential-marking name anywhere near it.
        toolResult(`hookdeck whoami # ${MINTED}`),
      ],
      agentReport: `Configured the CLI with ${MINTED}.`,
    };
    // Bare, the key is not caught on its own...
    expect(redactText(`hookdeck whoami # ${MINTED}`, [])).toContain(MINTED);
    // ...but it is once the same artifact also shows it assigned.
    expect(serializeRedacted(artifact, [])).not.toContain(MINTED);
  });

  it('leaves references, placeholders and non-credential settings alone', () => {
    const benign = [
      "api_key = '${HOOKDECK_API_KEY}'",
      'const apiKey = process.env.HOOKDECK_API_KEY',
      'HOOKDECK_API_KEY=$HOOKDECK_API_KEY',
      "api_key = 'your_api_key_goes_here'",
      '--destination-auth-method api_key',
      '{"key": "x-hookdeck-signature-header-name"}',
      "project_id = 'tm_fakeproject0'",
    ].join('\n');
    expect(assignedCredentialValues(benign)).toEqual([]);
    expect(redactText(benign, [])).toBe(benign);
  });

  it('is idempotent, so the upload check passes on what the harness wrote', () => {
    const once = serializeRedacted(
      {
        transcript: [
          toolResult(cliConfig()),
          toolResult(`token=${MINTED_TWO}`),
        ],
        env: 'HOOKDECK_API_KEY=fakeenvkey0000000000',
      },
      [{ name: 'HOOKDECK_API_KEY', value: 'fakeenvkey0000000000' }]
    );
    expect(redactText(once, [])).toBe(once);
    expect(
      findUnredacted(once, [
        { name: 'HOOKDECK_API_KEY', value: 'fakeenvkey0000000000' },
      ])
    ).toEqual([]);
  });

  it('reports kind and count without the value', () => {
    const found = findUnredacted(
      JSON.stringify({ a: cliConfig(), b: cliConfig(MINTED_TWO) }),
      []
    );
    expect(found).toEqual([{ name: ASSIGNED_CREDENTIAL, count: 2 }]);
    expect(JSON.stringify(found)).not.toContain(MINTED);
  });
});

describe('credentialsFromConfigText', () => {
  it('reads the key and guest link from a CLI config, and nothing else', () => {
    const found = credentialsFromConfigText(
      cliConfig(MINTED, `guest_url = '${GUEST_URL}'`)
    );
    expect(found).toEqual([
      { name: 'hookdeck-cli-config:api_key', value: MINTED },
      { name: 'hookdeck-cli-config:guest_url', value: GUEST_URL },
    ]);
  });

  it('reads every profile, since each `hookdeck ci` can write one', () => {
    const text = `${cliConfig()}\n[other]\napi_key = "${MINTED_TWO}"\n`;
    expect(credentialsFromConfigText(text).map((s) => s.value)).toEqual([
      MINTED,
      MINTED_TWO,
    ]);
  });
});

describe('discoverSandboxCredentials', () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'evals-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'evals-ws-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * Runs the real command in a real shell against both places the CLI writes:
   * the global config under `$HOME`, and a project-local `.hookdeck/` in the
   * workspace. A sandbox whose `exec` is this shell is what the harness has.
   */
  function shellSandbox(): AgentSandbox {
    return {
      workspace,
      exec: async (command) => {
        const stdout = execFileSync('bash', ['-c', command], {
          cwd: workspace,
          env: { PATH: process.env.PATH, HOME: home },
          encoding: 'utf8',
        });
        return { ok: true, exitCode: 0, stdout, stderr: '' };
      },
      readFile: async (path) => readFileSync(path, 'utf8'),
    };
  }

  it('finds keys in the global and the project-local CLI config', async () => {
    mkdirSync(join(home, '.config', 'hookdeck'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'hookdeck', 'config.toml'),
      cliConfig()
    );
    mkdirSync(join(workspace, 'app', '.hookdeck'), { recursive: true });
    writeFileSync(
      join(workspace, 'app', '.hookdeck', 'config.toml'),
      cliConfig(MINTED_TWO)
    );
    // Not a CLI config, so not read.
    writeFileSync(
      join(workspace, 'config.toml'),
      `api_key = 'unrelated0000000000'`
    );

    const found = await discoverSandboxCredentials(shellSandbox());
    expect(found.map((s) => s.value).sort()).toEqual(
      [MINTED, MINTED_TWO].sort()
    );
  });

  it('finds nothing, without failing, when the agent never ran the CLI', async () => {
    expect(await discoverSandboxCredentials(shellSandbox())).toEqual([]);
  });

  it('never throws: a cell the agent finished is not failed by discovery', async () => {
    const broken: AgentSandbox = {
      workspace,
      exec: async () => {
        throw new Error('container is gone');
      },
      readFile: async () => '',
    };
    expect(await discoverSandboxCredentials(broken)).toEqual([]);
  });

  it('is a single shell command, so it runs through `exec` unchanged', () => {
    expect(DISCOVER_COMMAND).toContain('.config/hookdeck/config.toml');
    expect(DISCOVER_COMMAND).toContain('HOOKDECK_CONFIG_FILE');
  });
});

/**
 * The value read out of the sandbox is what catches a key printed with no
 * assignment around it, so it has to reach every artifact the cell writes.
 */
describe('discovered credentials reach every artifact', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'evals-minted-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Printed with nothing around it that marks it as a credential, so only the
  // value read out of the sandbox can catch it.
  const bare = `hookdeck whoami # ${MINTED}`;

  it('the result file, including a superseded attempt', () => {
    const loop = newAttemptLoopState();
    credentialsDiscovered(loop, credentialsFromConfigText(cliConfig()));
    const prior = buildAttemptRecord({
      attempt: 1,
      result: { passed: false, checks: [] },
      stoppedReason: 'end_turn',
      agentReport: 'done',
      transcript: [toolResult(bare)],
      skills,
      docs,
    });
    const out = serializeRedacted(
      { agentReport: bare, priorAttempts: [prior] },
      cellSecrets(loop, [])
    );
    expect(out).not.toContain(MINTED);
    expect(out).toContain('<redacted:hookdeck-cli-config:api_key>');
  });

  it('accumulates across attempts, each of which mints its own key', () => {
    const loop = newAttemptLoopState();
    credentialsDiscovered(loop, credentialsFromConfigText(cliConfig()));
    credentialsDiscovered(
      loop,
      credentialsFromConfigText(cliConfig(MINTED_TWO))
    );
    const out = serializeRedacted(
      { a: `k ${MINTED}`, b: `k ${MINTED_TWO}` },
      cellSecrets(loop, [])
    );
    expect(out).not.toContain(MINTED);
    expect(out).not.toContain(MINTED_TWO);
  });

  it('errored-cell evidence: earlier attempts and the attempt that errored', () => {
    const state = newAttemptLoopState();
    credentialsDiscovered(state, credentialsFromConfigText(cliConfig()));
    state.priorAttempts.push(
      buildAttemptRecord({
        attempt: 1,
        result: { passed: false, checks: [] },
        stoppedReason: 'end_turn',
        agentReport: bare,
        transcript: [toolResult(bare)],
        skills,
        docs,
      })
    );
    state.current = {
      attempt: 2,
      stoppedReason: 'error_exit_255',
      agentReport: '',
      // Printed with no assignment, and a second key only the pattern sees.
      transcript: [toolResult(bare), toolResult(cliConfig(MINTED_TWO))],
      skills,
      docs,
    };
    const out = writeErroredEvidence(
      root,
      {
        experiment: 'e',
        evalId: 'v',
        error: new Error(`died holding ${MINTED}`),
        state,
      },
      []
    );
    const text = readFileSync(out!, 'utf8');
    expect(text).not.toContain(MINTED);
    expect(text).not.toContain(MINTED_TWO);
    expect(JSON.parse(text).erroredAttempt.attempt).toBe(2);
  });
});

describe('checkArtifacts', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'evals-check-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes what the harness wrote', () => {
    mkdirSync(join(root, '.eval-runs', 'exp'), { recursive: true });
    writeFileSync(
      join(root, '.eval-runs', 'exp', 'a.json'),
      serializeRedacted({ transcript: [toolResult(cliConfig())] }, [])
    );
    expect(
      checkArtifacts(['.eval-runs/exp', '.eval-errored/exp'], root, [])
    ).toEqual({ files: 1, findings: [] });
  });

  it('fails a file a write path left unredacted, naming it but not the value', () => {
    mkdirSync(join(root, '.eval-runs', 'exp'), { recursive: true });
    mkdirSync(join(root, '.eval-errored', 'exp'), { recursive: true });
    writeFileSync(join(root, '.eval-runs', 'exp', 'ok.json'), '{"a": 1}');
    writeFileSync(
      join(root, '.eval-errored', 'exp', 'leak.json'),
      JSON.stringify({ transcript: [toolResult(cliConfig())] })
    );
    const { findings } = checkArtifacts(
      ['.eval-runs/exp', '.eval-errored/exp'],
      root,
      []
    );
    expect(findings).toEqual([
      {
        path: join('.eval-errored', 'exp', 'leak.json'),
        name: ASSIGNED_CREDENTIAL,
        count: 1,
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(MINTED);
  });

  it('checks the environment values too, in any file type', () => {
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(join(root, 'logs', 'run.log'), 'key fakeenvkey0000000000');
    const { findings } = checkArtifacts(['logs'], root, [
      { name: 'HOOKDECK_API_KEY', value: 'fakeenvkey0000000000' },
    ]);
    expect(findings).toEqual([
      { path: join('logs', 'run.log'), name: 'HOOKDECK_API_KEY', count: 1 },
    ]);
  });
});
