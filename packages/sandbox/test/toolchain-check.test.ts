import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  classifyToolchainProbe,
  NOT_ON_PATH,
  SANDBOX_SELF_CHECK_FAILED,
  SANDBOX_SELF_CHECK_INCONCLUSIVE,
  TOOLCHAIN_PROBES,
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
/** What the real probe returns when `command -v hookdeck` resolves nothing. */
const notOnPath: SandboxCommandResult = {
  ok: false,
  exitCode: 3,
  stdout: `${NOT_ON_PATH}\n`,
  stderr: '',
};
const resolved = ok(
  `${NPM_BIN}/hookdeck\nhookdeck version ${HOOKDECK_CLI_VERSION}\n`
);
/** coreutils `timeout` firing inside the container. */
const timedOut: SandboxCommandResult = {
  ok: false,
  exitCode: 124,
  stdout: '',
  stderr: '[command timed out after 60s and was terminated]',
};
/** `docker exec` against a container that has gone: exit 1, nothing on stdout. */
const deadContainer: SandboxCommandResult = {
  ok: false,
  exitCode: 1,
  stdout: '',
  stderr: 'Error response from daemon: container abc is not running',
};

/** Run a probe for real, in a local shell with the given PATH. */
function runLocally(command: string, path: string): SandboxCommandResult {
  const result = spawnSync('bash', ['-c', command], {
    env: { PATH: path },
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** A directory holding a stand-in `hookdeck` that prints the given version. */
function fakeCliDir(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hd-fake-cli-'));
  const bin = join(dir, 'hookdeck');
  writeFileSync(
    bin,
    `#!/bin/sh\n[ "$1" = "--version" ] && echo "hookdeck version ${version}"\n`
  );
  chmodSync(bin, 0o755);
  return dir;
}

/**
 * The login probe with `-l` dropped, so it runs here without this machine's
 * own /etc/profile deciding the PATH. What it checks is that the probe
 * survives being nested in single quotes.
 */
const nestedProbe = TOOLCHAIN_PROBES[1].command.replace(
  /^bash -lc /,
  'bash -c '
);

describe('the probe, run for real', () => {
  it('reports a missing CLI with the sentinel and exit 3', () => {
    for (const command of [TOOLCHAIN_PROBES[0].command, nestedProbe]) {
      const result = runLocally(command, '/usr/bin:/bin');
      expect(result.exitCode).toBe(3);
      expect(result.stdout.trim()).toBe(NOT_ON_PATH);
      expect(classifyToolchainProbe({ shell: 's', result }).kind).toBe(
        'not-on-path'
      );
    }
  });

  it('accepts the pin and refuses another version', () => {
    for (const command of [TOOLCHAIN_PROBES[0].command, nestedProbe]) {
      const pinned = runLocally(
        command,
        `${fakeCliDir(HOOKDECK_CLI_VERSION)}:/usr/bin:/bin`
      );
      expect(classifyToolchainProbe({ shell: 's', result: pinned })).toEqual({
        kind: 'ok',
      });
      const other = runLocally(command, `${fakeCliDir('3.1.0')}:/usr/bin:/bin`);
      expect(classifyToolchainProbe({ shell: 's', result: other }).kind).toBe(
        'wrong-version'
      );
    }
  });
});

describe('classifyToolchainProbe', () => {
  it('accepts a shell that resolves the pinned version', () => {
    expect(
      classifyToolchainProbe({ shell: 'login', result: resolved })
    ).toEqual({ kind: 'ok' });
    expect(
      classifyToolchainProbe({
        shell: 'login',
        result: ok(`hookdeck version v${HOOKDECK_CLI_VERSION}\n`),
      })
    ).toEqual({ kind: 'ok' });
  });

  it('calls a missing CLI a fact about the image, which is what Codex got', () => {
    const outcome = classifyToolchainProbe({
      shell: 'login',
      result: notOnPath,
    });
    expect(outcome.kind).toBe('not-on-path');
  });

  it('calls a different version a fact about the image, including one that contains the pin', () => {
    for (const other of ['2.5.1', '12.5.0', '2.5.0-beta.1', '3.1.0']) {
      const outcome = classifyToolchainProbe(
        { shell: 'login', result: ok(`hookdeck version ${other}\n`) },
        '2.5.0'
      );
      expect(outcome.kind).toBe('wrong-version');
    }
  });

  it('reads through colour, so a styled --version does not cancel every run', () => {
    const esc = '\u001b';
    const bel = '\u0007';
    const coloured = (version: string) =>
      ok(
        `${esc}[1mhookdeck${esc}[0m version ${esc}[32m${version}${esc}[0m\r\n`
      );
    expect(
      classifyToolchainProbe({
        shell: 'login',
        result: coloured(HOOKDECK_CLI_VERSION),
      })
    ).toEqual({ kind: 'ok' });
    // An OSC 8 hyperlink around the version, terminated either way.
    for (const end of [bel, `${esc}\\`]) {
      expect(
        classifyToolchainProbe({
          shell: 'login',
          result: ok(
            `hookdeck version ${esc}]8;;https://example.test${end}${HOOKDECK_CLI_VERSION}${esc}]8;;${end}\n`
          ),
        })
      ).toEqual({ kind: 'ok' });
    }
    // Stripping colour must not turn a different version into the pin.
    const other = classifyToolchainProbe(
      { shell: 'login', result: coloured('3.1.0') },
      '2.5.0'
    );
    expect(other.kind).toBe('wrong-version');
    expect(other.kind === 'ok' ? '' : other.detail).not.toContain(esc);
  });

  it('calls a timeout, a dead container or no version line inconclusive', () => {
    for (const result of [
      timedOut,
      deadContainer,
      { ...timedOut, exitCode: 137 },
      { ...timedOut, exitCode: null },
      ok(`${NPM_BIN}/hookdeck\n`),
    ]) {
      expect(classifyToolchainProbe({ shell: 'login', result }).kind).toBe(
        'inconclusive'
      );
    }
  });
});

describe('assertPinnedToolchain', () => {
  const fake = (
    byCommand: (command: string, call: number) => SandboxCommandResult
  ) => {
    const seen: string[] = [];
    return {
      seen,
      runShell: async (command: string) => {
        seen.push(command);
        return byCommand(command, seen.length);
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

  it('cancels-the-run error when only the login shell is missing the CLI', async () => {
    const sandbox = fake((command) =>
      command.startsWith('bash -lc') ? notOnPath : resolved
    );
    const error = await assertPinnedToolchain(sandbox).catch((e) => e);
    expect(error.message).toMatch(
      /^sandbox self-check failed.*not scored.*login \(bash -lc\).*resolved nothing/s
    );
    // A deterministic outcome is not retried.
    expect(sandbox.seen).toHaveLength(2);
  });

  it('retries a transient failure once and passes if the retry does', async () => {
    const sandbox = fake((_, call) => (call === 1 ? timedOut : resolved));
    await assertPinnedToolchain(sandbox);
    expect(sandbox.seen).toHaveLength(3);
  });

  it('errors only this cell when a probe stays inconclusive', async () => {
    const sandbox = fake((command) =>
      command.startsWith('bash -lc') ? deadContainer : resolved
    );
    const error = await assertPinnedToolchain(sandbox).catch((e) => e);
    expect(
      String(error.message).startsWith(SANDBOX_SELF_CHECK_INCONCLUSIVE)
    ).toBe(true);
    // Must not carry the string CI cancels the whole run on.
    expect(error.message).not.toContain(SANDBOX_SELF_CHECK_FAILED);
    expect(sandbox.seen).toHaveLength(3);
  });

  it('treats a probe that throws as inconclusive', async () => {
    const sandbox = {
      runShell: async () => {
        throw new Error('sandbox command timed out after 80000ms');
      },
    };
    const error = await assertPinnedToolchain(sandbox).catch((e) => e);
    expect(
      String(error.message).startsWith(SANDBOX_SELF_CHECK_INCONCLUSIVE)
    ).toBe(true);
  });

  it('fails with the string CI cancels the run on, and CI is wired to it', async () => {
    // `eval-refresh.yml` greps the job log for this prefix to cancel the run
    // and leave a `sandbox-broken` marker that blocks publishing. If the two
    // drift, a broken image goes back to erroring every cell one at a time.
    const workflow = readFileSync(
      new URL('../../../.github/workflows/eval-refresh.yml', import.meta.url),
      'utf8'
    );
    const step = (name: string) => {
      const start = workflow.indexOf(`- name: ${name}\n`);
      expect(start, `step "${name}"`).toBeGreaterThan(-1);
      const next = workflow.indexOf('- name: ', start + 1);
      return workflow.slice(start, next === -1 ? undefined : next);
    };

    expect(workflow).toContain(`sandbox_broken="${SANDBOX_SELF_CHECK_FAILED}"`);
    expect(workflow).toContain('> sandbox-broken.marker');
    expect(workflow).toMatch(/grep -E '\^sandbox-broken-'/);

    const record = step('Record broken sandbox');
    expect(record).toContain("hashFiles('sandbox-broken.marker')");
    expect(record).toContain('path: sandbox-broken.marker');
    expect(record).toContain('name: sandbox-broken-');

    const cancel = step('Cancel the run');
    const cancelIf = cancel.split('\n').find((line) => /^\s+if:/.test(line));
    expect(cancelIf).toContain("'sandbox-broken.marker'");
    expect(cancelIf).toContain("'provider-refused.marker'");

    const sandbox = fake(() => notOnPath);
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
