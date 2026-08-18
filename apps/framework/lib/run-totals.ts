import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cumulative totals across every snapshot ever published.
 *
 * The page's top counter is a claim about the whole record, not the latest run:
 * "this many runs are on file and none were removed". `latest.json` cannot
 * answer that, because it holds one snapshot, and summing `rows` across
 * snapshots answers it wrongly — snapshots overlap heavily. `--merge` means a
 * published file carries rows from several workflow runs, and a targeted re-run
 * republishes rows it did not re-execute. Summing gives 600 for a record that
 * contains 180 distinct runs.
 *
 * So count distinct runs rather than rows. A run is identified by which
 * workflow produced it, which pairing it scored, and when it finished:
 * `ranAt` is per row and set at execution, so the same run republished into a
 * later snapshot carries the same timestamp and collapses, while a genuine
 * re-run of the same pairing does not.
 */
export interface RunTotals {
  /** Distinct scored runs across every published snapshot. */
  runsRecorded: number;
  /** How many snapshots those runs are spread across. */
  snapshots: number;
  /** Distinct workflow runs represented. */
  workflowRuns: number;
}

interface SnapshotRow {
  runId?: string;
  experiment: string;
  eval: string;
  ranAt?: string;
}

/**
 * Identity is the pairing plus when it finished. `ranAt` is stamped at
 * execution and copied verbatim when a row is republished, so the same run
 * appearing in four snapshots collapses to one, while a genuine re-run of the
 * same pairing keeps its own timestamp and counts separately.
 *
 * Deliberately not keyed on `runId`. Only 6 of the 600 rows on record carry
 * one, because the field was added late, so including it splits every older row
 * by whichever snapshot it came from and turns 180 runs into 600. A field
 * absent from 99% of the data cannot be part of its identity.
 *
 * The `file` fallback covers rows predating `ranAt`. There are none today; if
 * any appear they over-count rather than collapsing unrelated runs together,
 * which is the wrong direction for a credibility counter but the only one
 * available without a timestamp.
 */
function rowKey(row: SnapshotRow, file: string): string {
  return [row.experiment, row.eval, row.ranAt ?? `unknown:${file}`].join(' ');
}

export function computeRunTotals(runsDir: string): RunTotals {
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  const runs = new Set<string>();
  const workflowRuns = new Set<string>();

  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(join(runsDir, file), 'utf8')) as {
      results?: SnapshotRow[];
    };
    for (const row of snapshot.results ?? []) {
      runs.add(rowKey(row, file));
      if (row.runId) workflowRuns.add(row.runId);
    }
  }

  return {
    runsRecorded: runs.size,
    snapshots: files.length,
    workflowRuns: workflowRuns.size,
  };
}
