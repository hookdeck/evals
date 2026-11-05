import { describe, expect, it } from 'vitest';
import {
  type AttributableRow,
  classifyMoves,
  onSkillsArm,
  rowSkillsPin,
  skillsPinMoved,
} from '../lib/attribution.js';

/**
 * The mistake these guard against: a skills-pin bump changes what every
 * skills-arm cell reads, and `compare-snapshots` used to report the cells that
 * moved as "attributable to the agent" because nothing in this repository's
 * scoring changed. That is Loop 1's mistake in a new place. See #26.
 */

const OLD = '6ea10a4baf8114d54bdfed8a31c85b9b4d4f91db';
const NEW = 'efe1e0824fac61a1e61cfacfc573e0b62dad4a80';

function row(overrides: Partial<AttributableRow> = {}): AttributableRow {
  return {
    experiment: 'codex-gpt-5.4-mini',
    eval: 'benchmark-localdev-001-listen-locally',
    passed: true,
    skills: { available: ['hookdeck', 'event-gateway'] },
    ...overrides,
  };
}

const baseline = (o: Partial<AttributableRow> = {}) =>
  row({
    experiment: 'codex-gpt-5.4-mini-no-skills',
    skills: { available: [] },
    ...o,
  });

describe('onSkillsArm', () => {
  it('reads the row’s own record of what was installed', () => {
    expect(onSkillsArm(row())).toBe(true);
    expect(onSkillsArm(baseline())).toBe(false);
  });

  it('falls back to the experiment name for rows that predate the record', () => {
    expect(onSkillsArm(row({ skills: undefined }))).toBe(true);
    expect(onSkillsArm(baseline({ skills: undefined }))).toBe(false);
  });
});

describe('rowSkillsPin', () => {
  it('prefers the row’s own pin over the ref’s', () => {
    // A merged snapshot can carry rows from either side of a bump.
    expect(rowSkillsPin(row({ provenance: { skillsPin: OLD } }), NEW)).toBe(
      OLD
    );
  });

  it('falls back to the ref when the row has none, or an unusable one', () => {
    expect(rowSkillsPin(row(), NEW)).toBe(NEW);
    expect(
      rowSkillsPin(
        row({ provenance: { skillsPin: 'skills-pin-unavailable' } }),
        NEW
      )
    ).toBe(NEW);
  });

  it('is undefined when neither is known', () => {
    expect(rowSkillsPin(row(), undefined)).toBeUndefined();
  });
});

describe('skillsPinMoved', () => {
  it('withholds a skills-arm cell when the pin moved between refs', () => {
    expect(skillsPinMoved(row({ passed: false }), row(), OLD, NEW)).toBe(true);
  });

  it('leaves a baseline cell attributable when the pin moved', () => {
    // A -no-skills arm reads no skills, so a bump says nothing about it.
    expect(
      skillsPinMoved(baseline({ passed: false }), baseline(), OLD, NEW)
    ).toBe(false);
  });

  it('does not withhold a skills-arm cell when the pin did not move', () => {
    expect(skillsPinMoved(row({ passed: false }), row(), NEW, NEW)).toBe(false);
  });

  it('uses per-row pins over ref pins, so a carried-forward row is judged by what it ran with', () => {
    // Both refs point at the new pin, but the "before" row was carried forward
    // from a run on the old one.
    const before = row({ passed: false, provenance: { skillsPin: OLD } });
    const after = row({ provenance: { skillsPin: NEW } });
    expect(skillsPinMoved(before, after, NEW, NEW)).toBe(true);
  });

  it('treats an unknown pin as moved rather than unchanged', () => {
    expect(skillsPinMoved(row({ passed: false }), row(), undefined, NEW)).toBe(
      true
    );
  });

  it('treats local uncommitted skill edits as a different pin', () => {
    const before = row({ passed: false, provenance: { skillsPin: NEW } });
    const after = row({ provenance: { skillsPin: `${NEW}+dirty` } });
    expect(skillsPinMoved(before, after, NEW, NEW)).toBe(true);
  });
});

describe('classifyMoves', () => {
  // The flipped pair, as in the review of #102: the same scenario moving on a
  // skills arm and on its -no-skills twin.
  const skillsCell = row({ passed: false });
  const baselineCell = baseline({ passed: false });
  const moved = [skillsCell, baselineCell];
  const beforeOf = (r: AttributableRow) => ({ ...r, passed: !r.passed });

  it('never reports a skills-arm cell as a correction when the pin also moved', () => {
    // From a ref where scoring files changed under every scenario — v0.4.0,
    // after a comment-only edit to the shared runtime — and the pin moved.
    // Letting scoring win put every skills-arm cell in "corrections" and left
    // the skills bucket permanently empty for the release it exists for.
    const b = classifyMoves(moved, beforeOf, () => true, OLD, NEW);
    expect(b.both).toEqual([skillsCell]);
    expect(b.scoring).toEqual([baselineCell]);
    expect(b.skillsPin).toEqual([]);
    expect(b.behaviour).toEqual([]);
  });

  it('puts a skills-arm cell in the skills bucket when only the pin moved', () => {
    const b = classifyMoves(moved, beforeOf, () => false, OLD, NEW);
    expect(b.skillsPin).toEqual([skillsCell]);
    expect(b.behaviour).toEqual([baselineCell]);
    expect(b.both).toEqual([]);
  });

  it('is a scoring change alone when the pin did not move', () => {
    const b = classifyMoves(moved, beforeOf, () => true, NEW, NEW);
    expect(b.scoring).toEqual([skillsCell, baselineCell]);
    expect(b.both).toEqual([]);
  });

  it('attributes to the agent only when nothing else moved', () => {
    const b = classifyMoves(moved, beforeOf, () => false, NEW, NEW);
    expect(b.behaviour).toEqual([skillsCell, baselineCell]);
  });
});
