/**
 * Stamp `ranAt` on exported rows that predate the harness recording it.
 *
 * `export-results` falls back to a result file's mtime, but that only reaches
 * rows it actually re-exports. A `--merge` run carries older rows through from
 * the existing file untouched, so those keep no timestamp at all and the page
 * has nothing to say about their age.
 *
 * This is a one-off for that gap, not part of a refresh. It takes the date
 * explicitly rather than defaulting to now, because "when the export ran" and
 * "when the eval ran" are different questions and quietly conflating them is
 * exactly the thing the timestamp exists to prevent. Rows that already carry
 * `ranAt` are left alone.
 *
 *   pnpm --filter @hookdeck-evals/framework exec tsx scripts/backfill-ran-at.ts --date 2026-08-13
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_TARGET = resolve(ROOT, 'apps/web/src/data/eval-results.json');

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const date = readFlag(args, 'date');
  const target = readFlag(args, 'file') ?? DEFAULT_TARGET;

  if (!date) {
    console.error(
      'Pass --date <ISO date>, e.g. --date 2026-08-13. Refusing to guess: a\n' +
        'wrong timestamp is worse than none, because it reads as measured.'
    );
    process.exit(1);
  }

  const stamp = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(stamp.getTime())) {
    console.error(`Not a date this can parse: ${date}`);
    process.exit(1);
  }

  const rows: Array<Record<string, unknown>> = JSON.parse(
    await readFile(target, 'utf8')
  );

  let stamped = 0;
  for (const row of rows) {
    if (typeof row.ranAt === 'string' && row.ranAt) continue;
    row.ranAt = stamp.toISOString();
    stamped += 1;
  }

  if (stamped === 0) {
    console.log(`Every row already carries ranAt. Nothing to do.`);
    return;
  }

  await writeFile(target, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(
    `Stamped ${stamped} of ${rows.length} rows with ranAt=${stamp.toISOString()}.\n` +
      'Approximate by construction: these rows record the day their run\n' +
      'completed, not the hour.'
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
