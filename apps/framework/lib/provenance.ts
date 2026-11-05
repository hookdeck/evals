import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOOKDECK_CLI_VERSION,
  SKILLS_CLI_VERSION,
} from '@hookdeck-evals/sandbox';

/**
 * What a published row was measured under, so a stale one can be told apart
 * from a current one.
 *
 * `export-results --merge` carries forward any cell a run did not re-execute.
 * That earns its place — a dispatched run covers the experiments that run asked
 * for, so without it a partial run's snapshot would have holes. What it lacks
 * is any notion of a row going *out of date*. On 25 August the published file
 * held 114 rows across six execution dates spanning thirteen days, 22 of them
 * from 13 August: measured before the sandbox CLI moved to 2.5.0, before fixed
 * sleeps were replaced with polling, before several scorer corrections, and
 * before the base prompt gained "Do not ask clarifying questions". Nothing in
 * the file said so. See hookdeck/evals#60.
 *
 * Two hashes rather than one, following
 * [vercel-labs/agent-eval](https://github.com/vercel-labs/agent-eval), which
 * separates a `contentFingerprint` over the eval's own files from a combined
 * fingerprint over run-affecting config. The split is what makes the report
 * useful rather than alarming: "this scenario was rewritten" and "the harness
 * moved under every scenario at once" want different responses, and a single
 * hash cannot distinguish them.
 *
 * Deliberately *not* a correctness gate. Nothing here drops a row on its own —
 * `--drop-stale` is opt-in and prints what it removed. A snapshot with holes and
 * a snapshot with silent thirteen-day-old rows are both wrong, and which is less
 * wrong depends on what the snapshot is for. This makes the choice visible
 * instead of making it by default.
 */
export interface Provenance {
  /** The harness every scenario shares: base prompt, CLI pin, skills pin. */
  harness: string;
  /** The scenario's own files. Changes when its prompt, seed or scorer does. */
  scenario: string;
  /**
   * The `hookdeck/agent-skills` commit the skills came from, readable rather
   * than hashed. It is already one input to `harness`, but a hash can only say
   * *that* something shared moved, and a skills-pin move needs a different
   * response from a base-prompt change: it alters what a skills arm reads and
   * nothing a baseline arm sees. `compare-snapshots` reads this to stop
   * attributing a moved skills-arm cell to the agent. See #26.
   *
   * Recorded on every row, baseline arms included, so a row never has to be
   * interpreted to know which skills commit was checked out when it ran.
   */
  skillsPin: string;
}

const SHORT = 12;

function short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, SHORT);
}

export const SKILLS_PIN_UNAVAILABLE = 'skills-pin-unavailable';

/** Appended when the submodule has uncommitted changes. */
export const SKILLS_PIN_DIRTY_SUFFIX = '+dirty';

/**
 * The skills commit a run actually installs from.
 *
 * Read from git rather than from `.gitmodules`, because the pin is a commit and
 * not a branch — #26 was opened precisely because that pin can move without
 * anything in the results saying so.
 *
 * The submodule's checked-out commit rather than the superproject's recorded
 * gitlink, because the sandbox copies whatever is on disk. In CI the two are
 * the same commit. Locally they diverge exactly when someone is iterating on a
 * skill, which is when a row claiming the recorded pin would be wrong; for the
 * same reason uncommitted edits are marked rather than hidden.
 *
 * Unavailable when the submodule is not initialised, which is honest: an
 * unknown pin should not read or hash the same as a known one. The `.git`
 * check matters — an empty, uninitialised submodule directory sits inside the
 * superproject's repository, so `git rev-parse HEAD` there would quietly answer
 * with the *superproject's* commit.
 */
export function skillsPin(root: string): string {
  const dir = join(root, 'submodules/agent-skills');
  if (!existsSync(join(dir, '.git'))) return SKILLS_PIN_UNAVAILABLE;
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const sha = git(['rev-parse', 'HEAD']);
    const dirty = git(['status', '--porcelain']).length > 0;
    return dirty ? `${sha}${SKILLS_PIN_DIRTY_SUFFIX}` : sha;
  } catch {
    return SKILLS_PIN_UNAVAILABLE;
  }
}

/**
 * Everything shared across scenarios that changes what a run measures.
 *
 * The base prompt is in here because it is the one string every cell in every
 * experiment sees, so a word added to it moves every number at once — which is
 * exactly what happened on 27 August and is why this module exists now rather
 * than later. The skill *context* is deliberately excluded: that varies by arm
 * and is the treatment being measured, not a change to the instrument.
 */
export function harnessFingerprint(basePrompt: string, root: string): string {
  return short(
    [
      `base-prompt:${basePrompt}`,
      `hookdeck-cli:${HOOKDECK_CLI_VERSION}`,
      `skills-cli:${SKILLS_CLI_VERSION}`,
      `skills-pin:${skillsPin(root)}`,
    ].join('\n')
  );
}

/**
 * The scenario's own files: prompt, scorer, seed, solution, fixtures.
 *
 * Walked rather than listed, so a scenario that grows a `local/` directory or a
 * `SOLUTION.ts` is covered without anyone remembering to update this. Sorted, so
 * the hash does not depend on directory order.
 */
export function scenarioFingerprint(evalDir: string): string {
  const parts: string[] = [];

  const walk = (dir: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
        continue;
      }
      parts.push(`${rel}:${short(readFileSync(full, 'utf8'))}`);
    }
  };

  walk(evalDir, '');
  return short(parts.join('\n'));
}
