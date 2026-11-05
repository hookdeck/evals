/**
 * A sandbox self-check: is the pinned Hookdeck CLI what an agent's shell
 * actually runs?
 *
 * Every experiment is meant to differ from its neighbour by skills and nothing
 * else, and the pinned CLI is part of the baseline both arms share. Nothing
 * checked that it was reachable. It was not, on every Codex arm: Codex runs
 * each command as `/bin/bash -lc`, a login shell, and Debian's `/etc/profile`
 * overwrites PATH with a fixed list that leaves out the npm prefix the CLI is
 * installed into. In release matrix run 42044644850 every Codex attempt that
 * invoked `hookdeck` met `command not found` at least once — 26/26, 18/22,
 * 16/16 and 19/19 across the four Codex arms — and worked around it with an
 * absolute path into the package, `npx hookdeck`, an unpinned
 * `npx -y hookdeck-cli@latest`, or the REST API. Claude Code runs a non-login
 * shell, inherits the harness's PATH, and was unaffected. Those rows were
 * scored and published as though both agents had the same CLI.
 *
 * So this runs both kinds of shell before the agent is installed, and refuses
 * the cell when either does not resolve the pinned version. Throwing is the
 * point: `createAgentEnvironment` throws, `runOne` throws, and the cell lands
 * in `errored` with no result file — the same route as the empty-transcript
 * and dead-process guards in `run-eval.ts`. An agent working without the tool
 * the scenario assumes is not a result about the agent.
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

const PROBE = 'command -v hookdeck && hookdeck --version';

/**
 * The two shells an agent can be handed. `runShell` already runs `bash -c`
 * with the harness's PATH, so the login probe nests a `bash -lc` inside it,
 * which is exactly what Codex does.
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
 * What is wrong with one probe's result, or `undefined` if it resolved the
 * pinned CLI. Pure, so the rule can be tested without Docker.
 */
export function toolchainProblem(
  probe: ToolchainProbeResult,
  expectedVersion: string = HOOKDECK_CLI_VERSION
): string | undefined {
  const { shell, result } = probe;
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!result.ok) {
    return (
      `${shell}: \`hookdeck\` did not resolve or did not run ` +
      `(exit ${result.exitCode ?? 'unknown'}): ${oneLine(output) || 'no output'}`
    );
  }
  // A whole whitespace-delimited token, so 12.5.0 and 2.5.0-beta.1 do not
  // pass for 2.5.0.
  const version = new RegExp(
    `(^|\\s)v?${escapeRegExp(expectedVersion)}(\\s|$)`
  );
  if (!version.test(result.stdout)) {
    return (
      `${shell}: \`hookdeck\` resolved but is not the pinned ${expectedVersion}: ` +
      oneLine(output)
    );
  }
  return undefined;
}

/**
 * Run every probe and throw if any shell would not hand the agent the pinned
 * CLI. Accepts the narrow `runShell` surface so it can be exercised with a
 * fake.
 */
export async function assertPinnedToolchain(sandbox: {
  runShell(
    command: string,
    options?: { timeoutMs?: number }
  ): Promise<SandboxCommandResult>;
}): Promise<void> {
  const problems: string[] = [];
  for (const { shell, command } of TOOLCHAIN_PROBES) {
    const result = await sandbox.runShell(command, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const problem = toolchainProblem({ shell, result });
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    throw new Error(
      'sandbox self-check failed: the pinned Hookdeck CLI is not what an ' +
        `agent's shell runs, so this cell was not started and is not scored. ` +
        `${problems.join('; ')}. The PATH for both shells is set in ` +
        'packages/sandbox/Dockerfile.'
    );
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
