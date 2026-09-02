import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverEvals, EVALS_ROOT } from '../lib/discovery.js';

/**
 * Whether each benchmark scenario meets the criteria CONTRIBUTING.md sets, and
 * what the suite covers.
 *
 * Both rules were written down before any scenario existed and neither has ever
 * been checked. Measured on 29 August: **no** scenario's `motivation:` carries a
 * citation, and four of the five Outpost scenarios entered the published
 * benchmark without any agent ever having failed them (#47). A convention that
 * nothing reports on is a convention that gets skipped — the same lesson
 * `triage.ts` exists for, arrived at twice.
 *
 * This reports; it does not gate. Retro-fitting citations onto twenty-two
 * existing scenarios is not work a script should force, and a red build for
 * history nobody can reconstruct teaches people to disable the check. What it
 * makes possible is the sentence CONTRIBUTING.md now carries: a new benchmark
 * scenario should appear clean here before it is proposed.
 *
 * ```bash
 * pnpm --filter @hookdeck-evals/framework scenario-criteria
 * ```
 */

const RESULTS_DIR = join(EVALS_ROOT, 'results', 'runs');

/**
 * What counts as a citation.
 *
 * Deliberately loose, because this repository is public and CONTRIBUTING.md
 * requires motivations that carry evidence *without* disclosing it: an internal
 * ticket URL is exactly what must not appear. "Support ticket, June 2026" is
 * the sanctioned form and has to pass, so this cannot demand a link.
 *
 * What it rejects is the shape every current motivation has — an assertion
 * about what users probably do, with nothing behind it that anyone could check.
 */
const CITATION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'url', re: /https?:\/\/\S+/ },
  { name: 'issue', re: /\b[\w.-]+\/[\w.-]+#\d+\b|(?:^|\s)#\d+\b/ },
  {
    name: 'dated report',
    re: /\b(?:support ticket|support request|incident|community thread|forum post|customer report)s?,?\s+(?:[A-Z][a-z]+\s+)?20\d\d/i,
  },
  { name: 'run', re: /\brun\s+[\w.-]{6,}/i },
];

function citationOf(motivation: string): string | undefined {
  return CITATION_PATTERNS.find((p) => p.re.test(motivation))?.name;
}

function motivationOf(promptPath: string): string {
  const text = readFileSync(promptPath, 'utf8');
  const end = text.indexOf('\n---', 3);
  const frontmatter = end === -1 ? '' : text.slice(0, end);
  const match = frontmatter.match(
    /^motivation:\s*(?:>-)?\s*([\s\S]*?)(?=\n[a-z_]+:|$)/m
  );
  return (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

interface Observed {
  /** Distinct executions, not (scenario, experiment) pairs. */
  cells: number;
  failures: number;
}

/**
 * Every (scenario, experiment) pair ever published, and how many of them failed.
 *
 * Read across every snapshot rather than the latest one, because the latest is
 * a merge: a scenario that discriminated in July and has passed since would look
 * untested. Deduplicated by `sourcePath` *and* `ranAt` so a row republished
 * into seven snapshots counts once (#60) while a genuine re-execution still
 * counts: `sourcePath` alone is stable per (scenario, experiment), so on its
 * own it collapses every measurement a pair has ever had into one.
 */
function observedByEval(): Map<string, Observed> {
  const seen = new Map<string, Set<string>>();
  const failed = new Map<string, Set<string>>();

  let files: string[] = [];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return new Map();
  }

  for (const file of files) {
    const snapshot = JSON.parse(
      readFileSync(join(RESULTS_DIR, file), 'utf8')
    ) as {
      results?: {
        eval: string;
        passed?: boolean;
        sourcePath?: string;
        ranAt?: string;
        experiment: string;
      }[];
    };
    for (const row of snapshot.results ?? []) {
      const pair = row.sourcePath ?? `${row.eval}::${row.experiment}`;
      const id = `${pair}@${row.ranAt ?? 'unknown'}`;
      if (!seen.has(row.eval)) seen.set(row.eval, new Set());
      seen.get(row.eval)?.add(id);
      if (row.passed === false) {
        if (!failed.has(row.eval)) failed.set(row.eval, new Set());
        failed.get(row.eval)?.add(id);
      }
    }
  }

  const out = new Map<string, Observed>();
  for (const [evalId, ids] of seen) {
    out.set(evalId, {
      cells: ids.size,
      failures: failed.get(evalId)?.size ?? 0,
    });
  }
  return out;
}

function main(): void {
  const evals = discoverEvals();
  const observed = observedByEval();
  const benchmark = evals.filter((ev) => ev.suite === 'benchmark');

  const rows = benchmark.map((ev) => {
    const motivation = motivationOf(ev.promptPath);
    const seen = observed.get(ev.id);
    return {
      id: ev.id,
      citation: motivation ? citationOf(motivation) : undefined,
      hasMotivation: Boolean(motivation),
      cells: seen?.cells ?? 0,
      failures: seen?.failures ?? 0,
    };
  });

  const uncited = rows.filter((r) => !r.citation);
  const neverFailed = rows.filter((r) => r.cells > 0 && r.failures === 0);
  const neverRun = rows.filter((r) => r.cells === 0);

  console.log(
    `${benchmark.length} benchmark scenario(s); ${uncited.length} without a citation, ` +
      `${neverFailed.length} never failed by any agent, ${neverRun.length} with no published rows.\n`
  );

  const width = Math.max(...rows.map((r) => r.id.length));
  console.log(`${'scenario'.padEnd(width)}  citation      measured  failed`);
  for (const row of rows) {
    const citation =
      row.citation ?? (row.hasMotivation ? 'ASSERTION' : 'MISSING');
    console.log(
      `${row.id.padEnd(width)}  ${citation.padEnd(12)}  ${String(row.cells).padStart(8)}  ${String(row.failures).padStart(6)}`
    );
  }

  if (neverFailed.length) {
    console.log(
      '\nNever failed by any agent in any published snapshot. CONTRIBUTING.md asks\n' +
        'for at least one failure before a scenario joins the benchmark; these are\n' +
        'floors unless hardened, and a floor is worth publishing only deliberately:'
    );
    for (const row of neverFailed)
      console.log(`  ${row.id} (${row.cells} measurements)`);
  }

  console.log(
    '\nCoverage, so a gap is visible before the next scenario is chosen:'
  );
  for (const axis of ['product', 'stage'] as const) {
    const counts = new Map<string, number>();
    for (const ev of benchmark) {
      const values = axis === 'product' ? ev.product : [ev.stage];
      for (const value of values)
        counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
    }
    const line = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    console.log(`  ${axis}: ${line}`);
  }
}

main();
