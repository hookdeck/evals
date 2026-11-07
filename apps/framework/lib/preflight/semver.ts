/**
 * Just enough semver to say how far a pin is behind `latest`.
 *
 * Not a dependency: the inputs are npm `latest` tags and our own pins, both of
 * which are plain `MAJOR.MINOR.PATCH`, and a prerelease only needs to sort
 * before its release.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export function parseSemver(version: string): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    version.trim()
  );
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    ...(m[4] ? { prerelease: m[4] } : {}),
  };
}

/** -1, 0 or 1. Throws on input that is not a version, rather than guessing. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === undefined) return 1;
  if (y.prerelease === undefined) return -1;
  return comparePrerelease(x.prerelease, y.prerelease);
}

/**
 * Semver's prerelease order: dot-separated identifiers, numeric ones compared
 * as numbers and sorting before alphanumeric ones, and a shorter list first
 * when one is a prefix of the other. So `rc.2` < `rc.10`.
 */
function comparePrerelease(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * "2 major versions behind (2.5.0 -> 3.1.0)", or "up to date".
 *
 * Names the largest component that moved, because that is the one that decides
 * how much reading the bump needs: a major is a changelog to read, a patch
 * usually is not.
 */
export function describeVersionGap(current: string, latest: string): string {
  const x = parseSemver(current);
  const y = parseSemver(latest);
  if (!x || !y) return `cannot compare ${current} with ${latest}`;
  const order = compareSemver(current, latest);
  if (order === 0) return `up to date (${current})`;
  if (order > 0) return `ahead of latest (${current} > ${latest})`;
  const plural = (n: number, word: string) =>
    `${n} ${word} version${n === 1 ? '' : 's'} behind`;
  let gap: string;
  if (y.major !== x.major) gap = plural(y.major - x.major, 'major');
  else if (y.minor !== x.minor) gap = plural(y.minor - x.minor, 'minor');
  else if (y.patch !== x.patch) gap = plural(y.patch - x.patch, 'patch');
  else gap = 'prerelease behind';
  return `${gap} (${current} -> ${latest})`;
}
