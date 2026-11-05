/**
 * Whether a published cell that moved between two snapshots can be read as the
 * agent behaving differently.
 *
 * `compare-snapshots` already refuses to attribute a cell to the agent when the
 * scenario's own scorer, prompt or seed changed. This covers the other thing
 * that moves cells without any agent changing: the `submodules/agent-skills`
 * pin. A skills arm reads that content and a baseline arm does not, so a pin
 * move makes every skills-arm cell non-attributable and leaves the baseline
 * arms exactly as readable as before. See #26.
 *
 * Kept free of git and the filesystem so the rules can be tested directly.
 */

export interface AttributableRow {
  experiment: string;
  eval: string;
  passed: boolean;
  /** What the harness offered the agent. Absent on rows from before it was recorded. */
  skills?: { available?: string[] };
  /** Absent on rows from before it was recorded, and on published rows until #96. */
  provenance?: { skillsPin?: string };
}

const UNKNOWN_PINS = new Set(['', 'skills-pin-unavailable']);

/**
 * Did this cell run with any skills installed?
 *
 * The row's own `skills.available` is the record of what was installed, so it
 * wins — it also covers a scenario that adds a skill through `extra_skills`. A
 * row too old to carry it falls back to the naming convention every
 * experiment follows.
 */
export function onSkillsArm(row: AttributableRow): boolean {
  const available = row.skills?.available;
  if (available) return available.length > 0;
  return !row.experiment.endsWith('-no-skills');
}

/**
 * The skills commit a row was measured with.
 *
 * The row's own record first, because a merged snapshot can carry rows from
 * before and after a bump side by side, and only the row knows which it is.
 * Otherwise the pin recorded at the snapshot's git ref, which is right for any
 * row the run at that ref actually produced.
 */
export function rowSkillsPin(
  row: AttributableRow | undefined,
  refPin: string | undefined
): string | undefined {
  const own = row?.provenance?.skillsPin;
  if (own && !UNKNOWN_PINS.has(own)) return own;
  if (refPin && !UNKNOWN_PINS.has(refPin)) return refPin;
  return undefined;
}

/**
 * Should a moved cell be withheld from "attributable to the agent" because the
 * skills it read may have changed?
 *
 * Only for skills arms: a baseline arm reads no skills, so a pin move says
 * nothing about it. An unknown pin on either side counts as moved, following
 * the rule `scoringChanged` already applies — a false caveat costs a sentence,
 * a false "the agent improved" costs a wrong claim in public.
 */
export function skillsPinMoved(
  before: AttributableRow,
  after: AttributableRow,
  fromRefPin: string | undefined,
  toRefPin: string | undefined
): boolean {
  if (!onSkillsArm(before) && !onSkillsArm(after)) return false;
  const a = rowSkillsPin(before, fromRefPin);
  const b = rowSkillsPin(after, toRefPin);
  if (!a || !b) return true;
  return a !== b;
}
