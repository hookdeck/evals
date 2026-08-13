/**
 * Publish a run's results to the stable public path, and keep the history.
 *
 * `apps/web/src/data/eval-results.json` is the preview app's input: an
 * implementation detail of this repo that happens to be readable. Anything
 * outside this repo consuming it is coupled to where our own app keeps its
 * fixtures, and would break the day that app moves. `results/` is the
 * contract instead.
 *
 *   results/latest.json          the most recent successful run
 *   results/runs/<stamp>.json    that run, kept
 *   results/index.json           what exists, newest first
 *
 * History is kept because it cannot be reconstructed later. A row records
 * whether an agent passed, not what it did, so once `latest.json` is
 * overwritten the previous answer is gone. Keeping snapshots is what makes
 * "did this get better or worse" answerable at all, and at roughly 200KB a run
 * that is cheap next to the cost of producing one.
 *
 * The published shape wraps the rows rather than being a bare array, so a
 * consumer can see when a snapshot was published and which run produced it
 * without inspecting its contents. Provenance has been the recurring problem
 * here: results that looked authoritative and were not.
 *
 *   pnpm --filter @hookdeck-evals/framework exec tsx scripts/publish-snapshot.ts \
 *     --run-id 123 --published-at 2026-08-13T18:00:00.000Z
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const SOURCE = resolve(ROOT, 'apps/web/src/data/eval-results.json');
const PUBLISHED_DIR = resolve(ROOT, 'results');
const RUNS_DIR = join(PUBLISHED_DIR, 'runs');

/** Bumped only when the shape changes in a way a consumer must notice. */
const SCHEMA_VERSION = 1;

interface Row {
  experiment: string;
  eval: string;
  passed: boolean;
  ranAt?: string;
}

interface IndexEntry {
  file: string;
  publishedAt: string;
  runId?: string;
  rows: number;
  experiments: number;
  evals: number;
  passed: number;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

/** Filesystem-safe and sorts chronologically as a plain string. */
function stampFor(publishedAt: string): string {
  return publishedAt.replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

async function main() {
  const args = process.argv.slice(2);
  const runId = readFlag(args, 'run-id');
  const publishedAt =
    readFlag(args, 'published-at') ?? new Date().toISOString();

  if (Number.isNaN(new Date(publishedAt).getTime())) {
    console.error(`Not a date this can parse: ${publishedAt}`);
    process.exit(1);
  }

  const rows: Row[] = JSON.parse(await readFile(SOURCE, 'utf8'));
  if (rows.length === 0) {
    // Publishing an empty snapshot would overwrite a good `latest.json` with
    // nothing, and the page would render its empty state to the public.
    console.error('Refusing to publish an empty result set.');
    process.exit(1);
  }

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    publishedAt,
    ...(runId ? { runId } : {}),
    counts: {
      rows: rows.length,
      experiments: new Set(rows.map((r) => r.experiment)).size,
      evals: new Set(rows.map((r) => r.eval)).size,
      passed: rows.filter((r) => r.passed).length,
    },
    results: rows,
  };

  await mkdir(RUNS_DIR, { recursive: true });

  const file = `runs/${stampFor(publishedAt)}.json`;
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(join(PUBLISHED_DIR, file), serialized);
  await writeFile(join(PUBLISHED_DIR, 'latest.json'), serialized);

  const indexPath = join(PUBLISHED_DIR, 'index.json');
  const existing: IndexEntry[] = existsSync(indexPath)
    ? JSON.parse(await readFile(indexPath, 'utf8'))
    : [];

  const entry: IndexEntry = {
    file,
    publishedAt,
    ...(runId ? { runId } : {}),
    ...snapshot.counts,
  };

  // Newest first, and de-duplicated by file so re-running a publish for the
  // same snapshot updates its entry rather than appending a second one.
  const index = [entry, ...existing.filter((e) => e.file !== entry.file)].sort(
    (a, b) => b.publishedAt.localeCompare(a.publishedAt)
  );

  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  console.log(
    `Published ${rows.length} rows to results/latest.json and results/${file}\n` +
      `  ${snapshot.counts.passed}/${rows.length} passed across ` +
      `${snapshot.counts.experiments} experiments and ${snapshot.counts.evals} evals\n` +
      `  index now lists ${index.length} snapshot(s)`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
