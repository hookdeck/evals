import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
 * That earns its place — the `-no-skills` twins refresh monthly and everything
 * else weekly, so without it a weekly snapshot would have holes. What it lacks
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
}

const SHORT = 12;

function short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, SHORT);
}

/**
 * The pinned skills commit.
 *
 * Read from git rather than from `.gitmodules`, because the pin is the recorded
 * commit and not the branch — #26 is open precisely because that pin can move
 * without anything in the results saying so. Absent outside a git checkout,
 * which is honest: an unknown pin should not hash to the same value as a known
 * one, so it contributes a distinct marker rather than an empty string.
 */
function skillsPin(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD:submodules/agent-skills'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'skills-pin-unavailable';
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
