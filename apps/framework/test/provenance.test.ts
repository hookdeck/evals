import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scenarioFingerprint } from '../lib/provenance.js';

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
