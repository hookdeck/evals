import { HOOKDECK_CLI_VERSION } from '@hookdeck-evals/sandbox';

/**
 * Whether a cell's agent ran without the pinned Hookdeck CLI, and how it got
 * round that.
 *
 * Every experiment is supposed to get the CLI baked into the sandbox image, so
 * a row differs from its neighbour by skills and nothing else. On the Codex
 * arms it was not on PATH: Codex runs each command in a login shell, and
 * Debian's `/etc/profile` drops the npm prefix the CLI lives in. In release run
 * 42044644850 every Codex attempt that invoked `hookdeck` met
 * `command not found`, and the agents carried on through an absolute path into
 * the package, `npx`, an unpinned `npx -y hookdeck-cli@latest`, or the REST API
 * — all of which score, none of which is the baseline the row claims.
 *
 * The image now fixes the PATH and the sandbox refuses to start a cell whose
 * shells cannot run the pin, so this should not fire on a new run for the
 * first reason. It stays for two: rows already on disk carry it, and the
 * self-check cannot see a CLI the agent fetches for itself mid-run. Flagged
 * whether the cell passed or failed, because a passing row measured on a
 * different CLI is still not comparable.
 *
 * Kept outside `scripts/triage.ts` because that file runs `main()` at module
 * scope and so cannot be imported by a test.
 */
export interface PinnedCliEvidence {
  /** The shell said `hookdeck` does not exist (bash's wording, or dash's). */
  notFound: boolean;
  /** `hookdeck-cli` package specs the agent ran or installed that are not the pin. */
  unpinned: string[];
  /** It ran the platform binary inside the package directly. */
  absolutePath: boolean;
}

const NOT_FOUND = /hookdeck: (command )?not found/;

/**
 * `npx hookdeck-cli@<v>`, `npm install -g hookdeck-cli@<v>`, and the bare
 * `hookdeck-cli@<v>` inside either. A spec with no version is not counted: npx
 * resolved it to the installed 2.5.0 in every case run 42044644850 reported a
 * version.
 */
const PACKAGE_SPEC = /hookdeck-cli@([A-Za-z0-9][\w.-]*)/g;

const BINARY_PATH = /hookdeck-cli\/binaries\/[\w-]+\/hookdeck/;

/** What a cell ran in a shell, and what came back, across every attempt. */
export interface ShellActivity {
  commands: string[];
  outputs: string[];
}

interface TranscriptLike {
  type?: string;
  input?: { command?: unknown };
  output?: unknown;
  error?: unknown;
}

export interface RowLike {
  transcript?: TranscriptLike[];
  toolCalls?: unknown[];
  priorAttempts?: Array<{ transcript?: TranscriptLike[] }>;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Shell commands only, by design. A docs page the agent fetched, or a README
 * it wrote for the user, can say `npx hookdeck-cli@latest` without the agent
 * having run it, and flagging that would make this cry wolf. Outputs are read
 * only for the shell's own `not found`.
 */
export function shellActivity(row: RowLike): ShellActivity {
  const commands: string[] = [];
  const outputs: string[] = [];
  const transcripts = [
    row.transcript ?? [],
    ...(row.priorAttempts ?? []).map((attempt) => attempt.transcript ?? []),
  ];
  for (const transcript of transcripts) {
    for (const part of transcript) {
      if (part?.type !== 'tool_call') continue;
      const command = part.input?.command;
      if (typeof command !== 'string') continue;
      commands.push(command);
      outputs.push(`${asText(part.output)}\n${asText(part.error)}`);
    }
  }
  for (const raw of row.toolCalls ?? []) {
    const call = raw as {
      command?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (typeof call?.command !== 'string') continue;
    commands.push(call.command);
    outputs.push(`${asText(call.result)}\n${asText(call.error)}`);
  }
  return { commands, outputs };
}

export function pinnedCliEvidence(
  activity: ShellActivity,
  pinned: string = HOOKDECK_CLI_VERSION
): PinnedCliEvidence | undefined {
  const notFound = activity.outputs.some((output) => NOT_FOUND.test(output));
  const commands = activity.commands.join('\n');
  const unpinned = [
    ...new Set(
      [...commands.matchAll(PACKAGE_SPEC)]
        .map((match) => match[1])
        .filter((version) => version !== pinned && version !== `v${pinned}`)
        .map((version) => `hookdeck-cli@${version}`)
    ),
  ].sort();
  const absolutePath = BINARY_PATH.test(commands);
  if (!notFound && unpinned.length === 0) return undefined;
  return { notFound, unpinned, absolutePath };
}

/** One line for `triage`. */
export function describePinnedCliEvidence(
  evidence: PinnedCliEvidence,
  pinned: string = HOOKDECK_CLI_VERSION
): string {
  const parts: string[] = [];
  if (evidence.notFound) {
    parts.push('`hookdeck: command not found` in its shell');
  }
  if (evidence.unpinned.length > 0) {
    parts.push(`ran ${evidence.unpinned.join(', ')} instead of ${pinned}`);
  }
  if (evidence.absolutePath) {
    parts.push('called the binary inside the package by absolute path');
  }
  return (
    `${parts.join('; ')}. This row was not measured with the pinned CLI the ` +
    'baseline promises, so do not compare it across agents'
  );
}
