/**
 * What a published snapshot is made of, stated at the top of the file.
 *
 * A snapshot is not a run. `export-results --merge` carries forward every cell
 * a run did not re-execute, so one file can hold rows measured weeks apart,
 * under different scorers and CLI pins. Every row has carried its own `runId`
 * and `ranAt` since #65, which makes a snapshot decomposable — but only to a
 * reader who goes looking. The header names one run and one publish date, and
 * the page rendered "Results from 14 September" over 38 rows measured on 1
 * September (#60).
 *
 * This puts the answer where a reader looks first: whether the snapshot mixes
 * runs, which runs, how many rows each, and how many rows the publishing run
 * did not measure itself.
 */

export interface CompositionRow {
  runId?: string;
  ranAt?: string;
}

export interface RunShare {
  /** Null for rows with no `runId`: produced locally, or before 17 August. */
  runId: string | null;
  rows: number;
  /** Earliest and latest `ranAt` among this run's rows, when known. */
  earliest?: string;
  latest?: string;
}

export interface Composition {
  /**
   * True when the rows came from more than one run, or when some rows carry no
   * `runId` at all. The second case is unknowable rather than known to be
   * mixed, and is reported as mixed because "one run" would be a claim the
   * file cannot support.
   */
  mixed: boolean;
  /** Earliest and latest `ranAt` across every row. */
  ranAt: { earliest?: string; latest?: string };
  /**
   * Rows the publishing run did not measure: carried forward from an earlier
   * run by `--merge`. Only present when the publishing run is known, because
   * without a `runId` in the header there is nothing to compare against.
   */
  carried?: number;
  /** One entry per run represented, newest first by its latest `ranAt`. */
  runs: RunShare[];
}

function widen(
  range: { earliest?: string; latest?: string },
  ranAt: string | undefined
) {
  if (!ranAt) return;
  if (!range.earliest || ranAt < range.earliest) range.earliest = ranAt;
  if (!range.latest || ranAt > range.latest) range.latest = ranAt;
}

export function describeComposition(
  rows: CompositionRow[],
  publishingRunId?: string
): Composition {
  const byRun = new Map<string | null, RunShare>();
  const overall: { earliest?: string; latest?: string } = {};

  for (const row of rows) {
    const id = row.runId || null;
    let share = byRun.get(id);
    if (!share) {
      share = { runId: id, rows: 0 };
      byRun.set(id, share);
    }
    share.rows += 1;
    widen(share, row.ranAt);
    widen(overall, row.ranAt);
  }

  const runs = [...byRun.values()].sort(
    (a, b) =>
      (b.latest ?? '').localeCompare(a.latest ?? '') ||
      String(a.runId).localeCompare(String(b.runId))
  );

  return {
    mixed: runs.length > 1 || (runs.length === 1 && runs[0].runId === null),
    ranAt: overall,
    ...(publishingRunId
      ? {
          carried: rows.filter((r) => r.runId !== publishingRunId).length,
        }
      : {}),
    runs,
  };
}

/** One line for a log: "2 runs: 36386178039 76 rows (2026-09-28), ...". */
export function summarizeComposition(c: Composition): string {
  const parts = c.runs.map((r) => {
    const day = r.latest?.slice(0, 10) ?? 'date unknown';
    const first = r.earliest?.slice(0, 10);
    const span = first && first !== day ? `${first} to ${day}` : day;
    return `${r.runId ?? 'no runId'} ${r.rows} rows (${span})`;
  });
  const head = c.mixed ? `mixed: ${c.runs.length} source(s)` : 'single run';
  const carried =
    c.carried === undefined ? '' : `, ${c.carried} carried from earlier runs`;
  return `${head}${carried} — ${parts.join('; ')}`;
}
