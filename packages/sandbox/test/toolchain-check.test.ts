import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOOKDECK_CLI_VERSION,
  SANDBOX_DOCKERFILE_PATH,
  sandboxImageTag,
} from '../src/image.js';
import {
  assertPinnedToolchain,
  SANDBOX_SELF_CHECK_FAILED,
  TOOLCHAIN_PROBES,
  toolchainProblem,
} from '../src/toolchain-check.js';
import type { SandboxCommandResult } from '../src/types.js';

const NPM_BIN = '/home/node/.npm-global/bin';
/** What Debian's /etc/profile sets for a non-root login shell. */
const DEBIAN_LOGIN_PATH =
  '/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games';

const ok = (stdout: string): SandboxCommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});
const notFound: SandboxCommandResult = {
  ok: false,
  exitCode: 127,
  stdout: '',
  stderr: '/bin/bash: line 1: hookdeck: command not found\n',
};
const resolved = ok(
  `${NPM_BIN}/hookdeck\nhookdeck version ${HOOKDECK_CLI_VERSION}\n`
);

describe('toolchainProblem', () => {
  it('accepts a shell that resolves the pinned version', () => {
    expect(
      toolchainProblem({ shell: 'login', result: resolved })
    ).toBeUndefined();
    expect(
      toolchainProblem({
        shell: 'login',
        result: ok(`hookdeck version v${HOOKDECK_CLI_VERSION}\n`),
      })
    ).toBeUndefined();
  });

  it('refuses the shell that cannot find it, which is what Codex got', () => {
    const problem = toolchainProblem({ shell: 'login', result: notFound });
    expect(problem).toMatch(/^login: /);
    expect(problem).toContain('command not found');
    expect(problem).toContain('exit 127');
  });

  it('refuses a different version, including one that contains the pin', () => {
    for (const other of ['2.5.1', '12.5.0', '2.5.0-beta.1', '3.1.0']) {
      expect(
        toolchainProblem(
          { shell: 'login', result: ok(`hookdeck version ${other}\n`) },
          '2.5.0'
        )
      ).toContain('not the pinned 2.5.0');
    }
  });
});

describe('assertPinnedToolchain', () => {
  const fake = (byCommand: (command: string) => SandboxCommandResult) => {
    const seen: string[] = [];
    return {
      seen,
      runShell: async (command: string) => {
        seen.push(command);
        return byCommand(command);
      },
    };
  };

  it('probes a non-login shell and a nested login shell', async () => {
    const sandbox = fake(() => resolved);
    await assertPinnedToolchain(sandbox);
    expect(sandbox.seen).toEqual(TOOLCHAIN_PROBES.map((p) => p.command));
    expect(sandbox.seen.some((c) => c.startsWith('bash -lc '))).toBe(true);
    // `--version` is answered before the CLI initialises, so the probe
    // creates no config file and makes no network call. `hookdeck version`
    // would do both inside the agent's sandbox.
    for (const command of sandbox.seen) {
      expect(command).toContain('hookdeck --version');
      expect(command).not.toMatch(/hookdeck version/);
    }
  });

  it('throws when only the login shell is broken, naming it', async () => {
    const sandbox = fake((command) =>
      command.startsWith('bash -lc') ? notFound : resolved
    );
    await expect(assertPinnedToolchain(sandbox)).rejects.toThrow(
      /sandbox self-check failed.*not scored.*login \(bash -lc\).*command not found/s
    );
  });

  it('fails with the string CI cancels the run on', async () => {
    // `eval-refresh.yml` greps the job log for this prefix to cancel the run
    // and leave a `sandbox-broken` marker that blocks publishing. If the two
    // drift, a broken image goes back to erroring every cell one at a time.
    const workflow = readFileSync(
      new URL('../../../.github/workflows/eval-refresh.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain(`sandbox_broken="${SANDBOX_SELF_CHECK_FAILED}"`);
    expect(workflow).toContain('> sandbox-broken.marker');
    expect(workflow).toMatch(/grep -E '\^sandbox-broken-'/);

    const sandbox = fake(() => notFound);
    const error = await assertPinnedToolchain(sandbox).catch((e) => e);
    expect(String(error.message).startsWith(SANDBOX_SELF_CHECK_FAILED)).toBe(
      true
    );
  });
});

/**
 * The /etc/profile.d entry, extracted from the Dockerfile and run under `sh`
 * the way Debian's /etc/profile sources it: after PATH has been reset to the
 * login list. Docker is not needed, so this runs in CI on every pull request,
 * where the image itself is only built by an eval run.
 */
describe('sandbox Dockerfile PATH for login shells', () => {
  const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8');

  const profileScript = () => {
    const start = dockerfile.indexOf("RUN printf '%s\\n' \\");
    const end = dockerfile.indexOf('> /etc/profile.d/npm-global.sh', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const lines = dockerfile
      .slice(start, end)
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("'"))
      .map((line) => line.replace(/^'/, '').replace(/' \\$/, ''));
    expect(lines.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'hd-profile-'));
    const path = join(dir, 'npm-global.sh');
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  };

  const sourced = (script: string, times: number) => {
    const body = Array.from({ length: times }, () => '. "$1"').join('; ');
    const result = spawnSync(
      'sh',
      ['-c', `${body}; printf %s "$PATH"`, 'sh', script],
      {
        env: { PATH: DEBIAN_LOGIN_PATH },
        encoding: 'utf8',
      }
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };

  it('puts the npm prefix back in front of the login PATH', () => {
    expect(sourced(profileScript(), 1)).toBe(`${NPM_BIN}:${DEBIAN_LOGIN_PATH}`);
  });

  it('adds it once however often it is sourced', () => {
    expect(sourced(profileScript(), 3)).toBe(`${NPM_BIN}:${DEBIAN_LOGIN_PATH}`);
  });

  it('writes it as root, before the image switches to the node user', () => {
    expect(dockerfile.indexOf('/etc/profile.d/npm-global.sh')).toBeLessThan(
      dockerfile.indexOf('USER node')
    );
  });

  it('covers non-login shells through the image environment as well', () => {
    expect(dockerfile).toContain(`ENV PATH=${NPM_BIN}:$PATH`);
    expect(dockerfile).toContain(
      'ENV NPM_CONFIG_PREFIX=/home/node/.npm-global'
    );
  });
});

describe('sandboxImageTag', () => {
  it('changes when the Dockerfile does, so an edit reaches a cached machine', () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8');
    expect(sandboxImageTag(dockerfile)).not.toBe(
      sandboxImageTag(`${dockerfile}\n# edit\n`)
    );
    expect(sandboxImageTag(dockerfile)).toBe(sandboxImageTag(dockerfile));
    expect(sandboxImageTag(dockerfile)).toContain(
      `hookdeck-${HOOKDECK_CLI_VERSION}`
    );
  });
});
