import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverEvals, EVALS_ROOT } from '../lib/discovery.js';
import {
  DOCS_REACH_MEANING,
  docsReach,
  type DocsReach,
} from '../lib/docs-reach.js';

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
 * pnpm --filter @hookdeck-evals/framework report-results --queries
 * ```
 */

type GatedBy = 'discovery' | 'judgement' | 'mixed';

interface Check {
  name?: string;
  passed?: boolean;
}

interface DocsCall {
  source?: string;
  // Whichever field was the call's "ask": a search term, a url, a shell command.
  // For a hosted search this is the only part we ever see, which is why
  // `--queries` exists.
  query?: string;
  pages?: unknown[];
  // False when the result was a list of links rather than page text.
  hasContent?: boolean;
  // Omitted when the trace exposed no result at all, which is what separates a
  // hosted search we cannot see from one that genuinely returned nothing.
  resultChars?: number;
}

interface Row {
  experiment: string;
  eval: string;
  passed: boolean;
  gatedBy?: GatedBy;
  suite?: string;
  checks?: Check[];
  docs?: { calls?: DocsCall[] };
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
  const args = process.argv.slice(2);
  const showQueries = args.includes('--queries');
  const [path = 'results/latest.json'] = args.filter(
    (a) => !a.startsWith('--')
  );
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

  reportDocsReach(snapshot.results);
  if (showQueries) reportDocsQueries(snapshot.results);
}

/**
 * How each arm reached the documentation, and how often it failed to.
 *
 * A skill's job here is to point at the docs rather than restate them, so an
 * agent fetching a docs URL *because a skill named it* is the skill working —
 * not a confound, and not something to design out. That distinction is the whole
 * reason this prints two numbers instead of one.
 *
 * What is worth watching is the other half, and it has to be split four ways.
 * Only `read` means page text reached the agent. `hits` is a list of links,
 * `none` is a result we saw that carried nothing, and `unobserved` is a hosted
 * search whose results never reach us at all — see `lib/docs-reach.ts` for which
 * agent produces which, and why the two-bucket version was wrong in both
 * directions.
 *
 * So read this per row, never pooled. `read` is signal about the docs and the
 * skills. The other three are mostly facts about how a given agent goes looking,
 * and a delta that moves when they move is not a skills effect.
 *
 * `--queries` prints what was actually searched for. For a hosted search the
 * query is the only observable there is, so it is the only way to ask what an
 * agent was trying to find out — which is the question a skills delta usually
 * turns out to be about. See #83, and #61 for the number that rested on the old
 * bucket.
 */
const DOCS_REACH_ORDER: DocsReach[] = ['read', 'hits', 'none', 'unobserved'];

function reportDocsReach(rows: Row[]) {
  const arms = new Map<
    string,
    { counts: Map<DocsReach, number>; bySource: Map<string, number> }
  >();

  for (const row of rows) {
    const calls = row.docs?.calls ?? [];
    if (calls.length === 0) continue;
    const arm = arms.get(row.experiment) ?? {
      counts: new Map<DocsReach, number>(),
      bySource: new Map<string, number>(),
    };
    for (const call of calls) {
      const reach = docsReach(call);
      arm.counts.set(reach, (arm.counts.get(reach) ?? 0) + 1);
      const source = call.source ?? 'unknown';
      arm.bySource.set(source, (arm.bySource.get(source) ?? 0) + 1);
    }
    arms.set(row.experiment, arm);
  }

  if (arms.size === 0) return;

  console.log('\n  How each arm reached the docs:');
  for (const [experiment, arm] of [...arms].sort()) {
    const total = [...arm.counts.values()].reduce((a, b) => a + b, 0);
    const read = arm.counts.get('read') ?? 0;
    const pct = Math.round((100 * read) / total);
    const buckets = DOCS_REACH_ORDER.map(
      (reach) => `${reach} ${String(arm.counts.get(reach) ?? 0).padStart(3)}`
    ).join('  ');
    const mix = [...arm.bySource]
      .sort((a, b) => b[1] - a[1])
      .map(([source, n]) => `${source} ${n}`)
      .join(', ');
    console.log(
      `    ${experiment.padEnd(32)} ${String(total).padStart(4)} calls  ` +
        `${buckets}   ${String(pct).padStart(3)}% read  [${mix}]`
    );
  }
  for (const reach of DOCS_REACH_ORDER) {
    console.log(`    ${reach.padEnd(11)} ${DOCS_REACH_MEANING[reach]}`);
  }
  console.log(
    '    Only `read` is signal about the docs or the skills. Do not read a delta\n' +
      '    that moves with the other three as one. `--queries` shows what was asked.'
  );
}

/**
 * What each arm went looking for, and what came back.
 *
 * The query is the one part of a hosted search we always see, so for Codex it is
 * the only evidence of what the agent was trying to find out. That turns out to
 * be the interesting half: `verification-002`'s baseline searched twice for an
 * ElevenLabs source type, got nothing it could use, and built a generic `WEBHOOK`
 * source with hand-rolled HMAC — while the arm with the skill named the preset
 * and passed. A pass rate cannot show that. Two queries and their outcome can.
 *
 * Off by default because it is long. Grouped by scenario rather than by arm, so
 * the two arms of a pair sit next to each other and the diff is readable.
 */
function reportDocsQueries(rows: Row[]) {
  const byEval = new Map<string, Row[]>();
  for (const row of rows) {
    if ((row.docs?.calls ?? []).length === 0) continue;
    byEval.set(row.eval, [...(byEval.get(row.eval) ?? []), row]);
  }
  if (byEval.size === 0) {
    console.log('\n  No docs calls recorded in this snapshot.');
    return;
  }

  console.log('\n  What each arm asked the docs:');
  for (const [evalId, evalRows] of [...byEval].sort()) {
    console.log(`\n    ${evalId}`);
    for (const row of [...evalRows].sort((a, b) =>
      a.experiment.localeCompare(b.experiment)
    )) {
      const calls = row.docs?.calls ?? [];
      console.log(
        `      ${row.experiment}  ${row.passed ? 'passed' : 'FAILED'}  ${calls.length} calls`
      );
      for (const call of calls) {
        const query = (call.query ?? '').replace(/\s+/g, ' ').trim();
        console.log(
          `        ${docsReach(call).padEnd(11)} ${call.source ?? 'unknown'}  ${query}`
        );
      }
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
