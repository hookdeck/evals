import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sandboxImageDefinition } from '@hookdeck-evals/sandbox';
import {
  harnessFingerprint,
  SKILLS_PIN_DIRTY_SUFFIX,
  SKILLS_PIN_UNAVAILABLE,
  scenarioFingerprint,
  skillsPin,
} from '../lib/provenance.js';

/**
 * The defect these guard against shipped for weeks: `--merge` carried forward
 * every cell a run did not re-execute, with no notion of a row going out of
 * date. One published snapshot held rows from six execution dates spanning
 * thirteen days, measured across a CLI bump, several scorer corrections and a
 * base-prompt change, and said none of it. See hookdeck/evals#60.
 */

const dirs: string[] = [];

function scenario(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('scenarioFingerprint', () => {
  it('is stable for identical content', () => {
    const a = scenario({ 'EVAL.ts': 'export default 1', 'PROMPT.md': 'do it' });
    const b = scenario({ 'EVAL.ts': 'export default 1', 'PROMPT.md': 'do it' });
    expect(scenarioFingerprint(a)).toBe(scenarioFingerprint(b));
  });

  it('changes when a scorer changes', () => {
    const before = scenario({ 'EVAL.ts': 'export default 1' });
    const after = scenario({ 'EVAL.ts': 'export default 2' });
    expect(scenarioFingerprint(before)).not.toBe(scenarioFingerprint(after));
  });

  it('changes when a prompt changes', () => {
    // The case that matters most: a reworded ticket measures a different task,
    // and every published run of the old wording is describing something else.
    const before = scenario({ 'EVAL.ts': 'x', 'PROMPT.md': 'stop cancels' });
    const after = scenario({ 'EVAL.ts': 'x', 'PROMPT.md': 'stop everything' });
    expect(scenarioFingerprint(before)).not.toBe(scenarioFingerprint(after));
  });

  it('covers files added later, without being told about them', () => {
    // Walked rather than listed, so a scenario growing a SOLUTION.ts or a
    // local/ workspace is covered without anyone remembering to update it.
    const before = scenario({ 'EVAL.ts': 'x' });
    const after = scenario({ 'EVAL.ts': 'x', 'local/INFRA.md': 'seeded' });
    expect(scenarioFingerprint(before)).not.toBe(scenarioFingerprint(after));
  });

  it('ignores dotfiles and node_modules', () => {
    // A stray .DS_Store or an installed dependency is not a change to what the
    // scenario measures, and treating it as one would mark every row stale.
    const plain = scenario({ 'EVAL.ts': 'x' });
    const noisy = scenario({
      'EVAL.ts': 'x',
      '.DS_Store': 'junk',
      'node_modules/pkg/index.js': 'whatever',
    });
    expect(scenarioFingerprint(plain)).toBe(scenarioFingerprint(noisy));
  });
});

describe('skillsPin', () => {
  // A throwaway superproject with the submodule path laid out as the harness
  // expects. Commits carry an inline identity so the test does not depend on
  // the machine's git config.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

  function superproject(): string {
    const root = mkdtempSync(join(tmpdir(), 'prov-pin-'));
    dirs.push(root);
    git(root, 'init', '-q');
    writeFileSync(join(root, 'README.md'), 'super');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'super');
    mkdirSync(join(root, 'submodules/agent-skills'), { recursive: true });
    return root;
  }

  function initSkills(root: string): string {
    const dir = join(root, 'submodules/agent-skills');
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'SKILL.md'), 'skill');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'skills');
    return git(dir, 'rev-parse', 'HEAD');
  }

  it('records the commit the skills are checked out at', () => {
    const root = superproject();
    const sha = initSkills(root);
    expect(skillsPin(root)).toBe(sha);
  });

  it('marks uncommitted edits, because those are what gets installed', () => {
    const root = superproject();
    const sha = initSkills(root);
    writeFileSync(join(root, 'submodules/agent-skills/SKILL.md'), 'edited');
    expect(skillsPin(root)).toBe(`${sha}${SKILLS_PIN_DIRTY_SUFFIX}`);
  });

  it('does not report the superproject commit for an uninitialised submodule', () => {
    // The trap: an empty submodule directory sits inside the superproject's
    // repository, so a naive rev-parse there answers with the wrong commit.
    const root = superproject();
    expect(skillsPin(root)).toBe(SKILLS_PIN_UNAVAILABLE);
    expect(skillsPin(root)).not.toBe(git(root, 'rev-parse', 'HEAD'));
  });
});

describe('harnessFingerprint', () => {
  // A root with no skills submodule, so the pin is constant across calls.
  const root = () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-root-'));
    dirs.push(dir);
    return dir;
  };

  it('changes when the sandbox image definition does', () => {
    // The login-shell PATH fix changed only the Dockerfile, and gave Codex a
    // CLI it had not had. Rows either side of it must not share a harness.
    const r = root();
    expect(harnessFingerprint('prompt', r, 'aaaaaaaaaaaa')).not.toBe(
      harnessFingerprint('prompt', r, 'bbbbbbbbbbbb')
    );
  });

  it('reads the real Dockerfile by default, and is stable', () => {
    const r = root();
    expect(harnessFingerprint('prompt', r)).toBe(
      harnessFingerprint('prompt', r, sandboxImageDefinition())
    );
    expect(harnessFingerprint('prompt', r)).toBe(
      harnessFingerprint('prompt', r)
    );
  });
});
