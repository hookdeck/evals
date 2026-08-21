import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverEvals, EVALS_ROOT } from '../lib/discovery.js';

/**
 * Read a snapshot and say what kind of failures it contains.
 *
 * A pass rate answers "how did the agents do". It does not answer the question
 * this benchmark exists for, which is **what should we change**. Those come
 * apart because a red cell has two very different causes:
 *
 * - The agent could not find out how. That is ours: a documentation or skills
 *   gap, and fixing it should turn the cell green in a later run.
 * - The agent knew how and chose badly — acted more broadly than asked, or
 *   stopped short. No documentation change moves that, so it is a fact about
 *   running agents rather than a to-do for us.
 *
 * Reported as one number they are indistinguishable, which invites reading
 * model carefulness as a documentation win, or the reverse. `gated_by` in each
 * scenario's frontmatter records which kind it is, and this splits the
 * scoreboard along it.
 *
 * For `mixed` scenarios the classification cannot answer it alone, so the
 * failing check names are printed: they are what says whether the agent could
 * not do the task or did it and broke something adjacent.
 *
 * ```bash
 * pnpm --filter @hookdeck-evals/framework report-results
 * pnpm --filter @hookdeck-evals/framework report-results results/runs/2026-08-21.json
 * ```
 */

type GatedBy = 'discovery' | 'judgement' | 'mixed';

interface Check {
  name?: string;
  passed?: boolean;
}

interface Row {
  experiment: string;
  eval: string;
  passed: boolean;
  gatedBy?: GatedBy;
  suite?: string;
  checks?: Check[];
}

interface Snapshot {
  publishedAt?: string;
  runId?: string;
  results: Row[];
}

const UNCLASSIFIED = 'unclassified';

function load(path: string): Snapshot {
  const full = path.startsWith('/') ? path : join(EVALS_ROOT, path);
  if (!existsSync(full)) throw new Error(`no snapshot at ${full}`);
  return JSON.parse(readFileSync(full, 'utf8'));
}

function main() {
  const [path = 'results/latest.json'] = process.argv.slice(2);
  const snapshot = load(path);

  // Benchmark only. Regression scenarios are meant to pass everywhere, so
  // folding them in moves the rate without meaning anything.
  const rows = snapshot.results.filter(
    (r) => (r.suite ?? 'benchmark') === 'benchmark'
  );
  const failures = rows.filter((r) => !r.passed);

  console.log(`${path}${snapshot.runId ? `  run ${snapshot.runId}` : ''}`);
  console.log(
    `\n  ${rows.filter((r) => r.passed).length}/${rows.length} benchmark cells passed\n`
  );

  // Snapshots exported before `gated_by` existed carry no classification, and
  // the field describes the scenario rather than the run — so fall back to what
  // the scenario says today. That makes this readable against existing
  // snapshots instead of only from the next matrix run onwards.
  //
  // Announced rather than silent: it means a scenario reclassified later will
  // re-label an old run, which is fine for deciding what to work on and wrong
  // for quoting history.
  const current = currentClassifications();
  let inferred = 0;

  const groups = new Map<string, Row[]>();
  for (const row of failures) {
    let key = row.gatedBy;
    if (!key && current.has(row.eval)) {
      key = current.get(row.eval);
      inferred += 1;
    }
    groups.set(key ?? UNCLASSIFIED, [
      ...(groups.get(key ?? UNCLASSIFIED) ?? []),
      row,
    ]);
  }

  if (inferred > 0) {
    console.log(
      `  ${inferred} row(s) carry no classification of their own; using what ` +
        'the scenario says today. Re-export to record it in the snapshot.\n'
    );
  }

  if (failures.length === 0) {
    console.log('  No failures.');
    return;
  }

  report(
    groups.get('discovery') ?? [],
    'Discovery — the agent could not find out how',
    'Ours to fix. A docs or skills change should turn these green in a later run.'
  );

  report(
    groups.get('judgement') ?? [],
    'Judgement — the agent knew how and chose badly',
    'Not moved by documentation. Publish as a floor; do not read as a docs gap.'
  );

  // Printed with their failing checks, because the label alone does not say
  // which half failed and the two have opposite implications.
  const mixed = groups.get('mixed') ?? [];
  if (mixed.length > 0) {
    console.log('\n  Mixed — read the failing check to tell which:');
    for (const row of mixed) {
      const failed = (row.checks ?? [])
        .filter((c) => c.passed === false)
        .map((c) => c.name ?? '(unnamed)');
      console.log(`    ${row.eval} x ${row.experiment}`);
      for (const name of failed) console.log(`        ✗ ${name}`);
      if (failed.length === 0) {
        console.log('        (no per-check detail in this snapshot)');
      }
    }
  }

  const unclassified = groups.get(UNCLASSIFIED) ?? [];
  if (unclassified.length > 0) {
    console.log(
      `\n  Unclassified (${unclassified.length}) — no \`gated_by\` in the scenario's frontmatter,` +
        '\n  so these cannot be read either way. Classify them:'
    );
    for (const id of [...new Set(unclassified.map((r) => r.eval))]) {
      console.log(`    ${id}`);
    }
  }
}

/** What each scenario's frontmatter says right now, by eval id. */
function currentClassifications(): Map<string, GatedBy> {
  const map = new Map<string, GatedBy>();
  for (const ev of discoverEvals()) {
    const gatedBy = (ev.metadata as { gatedBy?: GatedBy } | undefined)?.gatedBy;
    if (gatedBy) map.set(ev.id, gatedBy);
  }
  return map;
}

function report(rows: Row[], title: string, note: string) {
  if (rows.length === 0) return;
  console.log(`\n  ${title} (${rows.length}):`);
  for (const row of rows) console.log(`    ${row.eval} x ${row.experiment}`);
  console.log(`    ${note}`);
}

main();
