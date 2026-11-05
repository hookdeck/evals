/**
 * A sandbox self-check: is the pinned Hookdeck CLI what an agent's shell
 * actually runs?
 *
 * Every experiment is meant to differ from its neighbour by skills and nothing
 * else, and the pinned CLI is part of the baseline both arms share. Nothing
 * checked that it was reachable, and for most Codex commands it was not. Codex
 * runs most commands in a login shell (`/bin/bash -lc`), and Debian's
 * `/etc/profile` overwrites PATH with a fixed list that leaves out the npm
 * prefix the CLI is installed into. In release matrix run 42044644850, 2,233 of
 * Codex's 2,456 shell commands were `bash -lc`. Of the Codex attempts that
 * invoked `hookdeck`, 26/26, 18/22, 16/16 and 19/19 across the four arms met
 * `command not found`; the four that did not ran it only through `bash -c`.
 * The agents worked around it with an absolute path into the package,
 * `npx hookdeck`, an unpinned `npx -y hookdeck-cli@latest`, or the REST API.
 * Claude Code runs a non-login shell, inherits the harness's PATH, and was
 * unaffected. Those rows were scored and published as though both agents had
 * the same CLI on PATH.
 *
 * So this runs both kinds of shell before the agent is installed, and refuses
 * the cell when either does not resolve the pinned version. Throwing is the
 * point: `createAgentEnvironment` throws, `runOne` throws, and the cell lands
 * in `errored` with no result file — the same route as the empty-transcript
 * and dead-process guards in `run-eval.ts`. An agent working without the tool
 * the scenario assumes is not a result about the agent.
 *
 * Two kinds of failure, and only one of them cancels the run. A shell that
 * resolves no `hookdeck`, or resolves the wrong version, is a fact about the
 * image, so every cell will see it: that throws {@link SANDBOX_SELF_CHECK_FAILED},
 * which CI treats as a run-level failure. Anything else — an in-container
 * timeout, a `docker exec` the daemon refused, a container that died — could
 * be one cell's bad minute. That probe is retried once and, if it still says
 * nothing conclusive, throws {@link SANDBOX_SELF_CHECK_INCONCLUSIVE}, which
 * errors this cell and leaves the rest of the matrix running. Cancelling five
 * hours of work for a transient hiccup is the opposite mistake.
 *
 * `--version` rather than `hookdeck version`, deliberately. Cobra answers the
 * flag before any of the CLI's own initialisation runs, so it creates no
 * config file and makes no network call. `hookdeck version` does both — it
 * initialises (and if absent, creates) `~/.config/hookdeck/config.toml` and
 * asks GitHub for the latest release — which would change the state the agent
 * finds and add a dependency that can fail a cell for reasons no agent caused.
 */

import { HOOKDECK_CLI_VERSION } from './image.js';
import type { SandboxCommandResult } from './types.js';

/**
 * Printed, with exit 3, when `command -v` resolves nothing. A sentinel on
 * stdout rather than an exit status alone, because `docker exec` itself exits
 * 1 when the container has gone, and that must not read as a missing CLI.
 */
export const NOT_ON_PATH = 'HOOKDECK_NOT_ON_PATH';
const NOT_ON_PATH_EXIT = 3;

// No single quotes: the login probe wraps this in them.
const PROBE =
  `if ! command -v hookdeck; then echo ${NOT_ON_PATH}; exit ${NOT_ON_PATH_EXIT}; fi; ` +
  'hookdeck --version';

/**
 * The prefix of the error thrown when the image itself is wrong. The
 * `Run evals` step in `eval-refresh.yml` greps the job log for it, treats it as
 * a run-level failure like a provider refusal, leaves a `sandbox-broken` marker
 * that `publish-results` refuses on, and cancels the run: every job builds the
 * same image, so one broken sandbox means all of them are. A test fails if the
 * workflow and this string drift apart.
 */
export const SANDBOX_SELF_CHECK_FAILED = 'sandbox self-check failed';

/**
 * The prefix of the error thrown when the check could not get an answer. Must
 * not contain {@link SANDBOX_SELF_CHECK_FAILED}, or a transient error would
 * cancel the whole matrix; a test holds it to that.
 */
export const SANDBOX_SELF_CHECK_INCONCLUSIVE =
  'sandbox self-check could not complete';

/**
 * The two shells an agent can be handed. `runShell` already runs `bash -c`
 * with the harness's PATH, so the login probe nests a `bash -lc` inside it,
 * which is what Codex does for most commands.
 */
export const TOOLCHAIN_PROBES = [
  { shell: 'non-login (bash -c)', command: PROBE },
  { shell: 'login (bash -lc)', command: `bash -lc '${PROBE}'` },
] as const;

const PROBE_TIMEOUT_MS = 60_000;

export interface ToolchainProbeResult {
  shell: string;
  result: SandboxCommandResult;
}

/**
 * What one probe says. `not-on-path` and `wrong-version` are facts about the
 * image; `inconclusive` is anything that could be this cell's bad luck.
 */
export type ToolchainOutcome =
  | { kind: 'ok' }
  | { kind: 'not-on-path' | 'wrong-version' | 'inconclusive'; detail: string };

/** Classify one probe's result. Pure, so the rule can be tested without Docker. */
export function classifyToolchainProbe(
  probe: ToolchainProbeResult,
  expectedVersion: string = HOOKDECK_CLI_VERSION
): ToolchainOutcome {
  const { shell, result } = probe;
  // Colour is stripped before anything is matched. A CLI release that styles
  // `--version` would otherwise put an escape code against the version
  // number, fail the whole-token match on every cell of a working image, and
  // cancel the run.
  const stdout = stripAnsi(result.stdout);
  const output =
    oneLine(`${stdout}\n${stripAnsi(result.stderr)}`) || 'no output';
  const stdoutLines = stdout.split('\n').map((line) => line.trim());

  if (
    result.exitCode === NOT_ON_PATH_EXIT &&
    stdoutLines.includes(NOT_ON_PATH)
  ) {
    return {
      kind: 'not-on-path',
      detail: `${shell}: \`command -v hookdeck\` resolved nothing`,
    };
  }
  if (!result.ok) {
    return {
      kind: 'inconclusive',
      detail: `${shell}: probe exited ${result.exitCode ?? 'without a status'}: ${output}`,
    };
  }
  // A whole whitespace-delimited token, so 12.5.0 and 2.5.0-beta.1 do not
  // pass for 2.5.0.
  const pinned = new RegExp(`(^|\\s)v?${escapeRegExp(expectedVersion)}(\\s|$)`);
  if (pinned.test(stdout)) return { kind: 'ok' };
  // Only a recognisable version line counts as the wrong version. Output that
  // says nothing about a version is not evidence about the image.
  if (/\bversion\s+\S+/.test(stdout)) {
    return {
      kind: 'wrong-version',
      detail: `${shell}: \`hookdeck\` is not the pinned ${expectedVersion}: ${output}`,
    };
  }
  return {
    kind: 'inconclusive',
    detail: `${shell}: \`hookdeck --version\` printed no version: ${output}`,
  };
}

interface ShellRunner {
  runShell(
    command: string,
    options?: { timeoutMs?: number }
  ): Promise<SandboxCommandResult>;
}

async function runProbe(
  sandbox: ShellRunner,
  shell: string,
  command: string
): Promise<ToolchainOutcome> {
  try {
    const result = await sandbox.runShell(command, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return classifyToolchainProbe({ shell, result });
  } catch (err) {
    // `dockerCli` throws rather than returning when its own client times out.
    return {
      kind: 'inconclusive',
      detail: `${shell}: probe threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run every probe and throw if any shell would not hand the agent the pinned
 * CLI. Accepts the narrow `runShell` surface so it can be exercised with a
 * fake.
 */
export async function assertPinnedToolchain(
  sandbox: ShellRunner
): Promise<void> {
  const broken: string[] = [];
  const unknown: string[] = [];
  for (const { shell, command } of TOOLCHAIN_PROBES) {
    let outcome = await runProbe(sandbox, shell, command);
    if (outcome.kind === 'inconclusive') {
      outcome = await runProbe(sandbox, shell, command);
    }
    if (outcome.kind === 'ok') continue;
    (outcome.kind === 'inconclusive' ? unknown : broken).push(outcome.detail);
  }
  if (broken.length > 0) {
    throw new Error(
      `${SANDBOX_SELF_CHECK_FAILED}: the pinned Hookdeck CLI is not what an ` +
        `agent's shell runs, so this cell was not started and is not scored. ` +
        `${[...broken, ...unknown].join('; ')}. The PATH for both shells is ` +
        'set in packages/sandbox/Dockerfile.'
    );
  }
  if (unknown.length > 0) {
    throw new Error(
      `${SANDBOX_SELF_CHECK_INCONCLUSIVE}: the probe for the pinned Hookdeck ` +
        'CLI got no answer after a retry, so this cell was not started and is ' +
        `not scored. ${unknown.join('; ')}. Not a verdict on the image: re-run ` +
        'the cell.'
    );
  }
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/**
 * ANSI escape sequences: CSI (`ESC [ … final`, which covers SGR colour) and
 * OSC (`ESC ] … BEL` or `ESC ] … ESC \`, which covers hyperlinks). Built from
 * character codes so the source carries no literal control characters.
 */
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  'g'
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
