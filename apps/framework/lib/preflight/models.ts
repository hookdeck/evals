/**
 * Comparing a pinned model id against a provider's models list.
 *
 * Providers name models `<family>-<version>[-<variant>]` with a dated snapshot
 * suffix on some, and do not mark which is newest, so "is there something newer
 * in this family" is answered from the version numbers in the id. That is a
 * heuristic and the report says so; the decision belongs to a person.
 */

const DATED = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/;

/** `claude-sonnet-5-5` and `claude-sonnet-5` share `claude-sonnet-N`. */
export function modelFamily(id: string): string {
  return id.replace(DATED, '').replace(/\d+(?:[.-]\d+)*/, 'N');
}

/** `[5, 5]` for `claude-sonnet-5-5`, `[5, 4]` for `gpt-5.4-mini`. */
export function modelVersion(id: string): number[] {
  const m = /\d+(?:[.-]\d+)*/.exec(id.replace(DATED, ''));
  return m ? m[0].split(/[.-]/).map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface ModelStanding {
  model: string;
  listed: boolean;
  /** Listed ids that extend this one, e.g. `gpt-5.6-sol` for `gpt-5.6`. */
  variants: string[];
  /** Same family, higher version, excluding dated snapshots. */
  newer: string[];
}

export function modelStanding(model: string, listed: string[]): ModelStanding {
  const family = modelFamily(model);
  const version = modelVersion(model);
  return {
    model,
    listed: listed.includes(model),
    variants: listed.filter((id) => id.startsWith(`${model}-`)).sort(),
    newer: listed
      .filter(
        (id) =>
          !DATED.test(id) &&
          modelFamily(id) === family &&
          compareVersions(modelVersion(id), version) > 0
      )
      .sort((a, b) => compareVersions(modelVersion(b), modelVersion(a))),
  };
}
