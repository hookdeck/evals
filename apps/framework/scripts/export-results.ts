#!/usr/bin/env tsx
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { parseEvalMarkdown } from '@hookdeck-evals/core/eval-markdown';
import { rawEvalResultSchema } from '@hookdeck-evals/core/eval-metadata';
import {
  getExperimentDisplayMetadata,
  type ExperimentConfig,
  type ExperimentDisplayMetadata,
} from '@hookdeck-evals/core';
import type {
  EvalResult,
  EvalSuite,
  ExperimentSuite,
} from '@hookdeck-evals/core/eval-metadata';
import { collectEnvSecretValues } from '@hookdeck-evals/hookdeck';
import {
  normalizeExperimentName,
  readExperimentSuiteFilters,
  readRepeatedFlag,
  readSuiteFilters,
} from '../lib/cli-args.js';
import {
  assessCoverage,
  type Coverage,
  pairKey,
  type Provenanced,
  readExpectedPairs,
  sanitizeCarried,
  splitStale,
} from '../lib/merge-results.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
// Raw per-run output. Gitignored working state, not the published
// contract, which lives in `results/`.
const RESULTS_DIR = join(ROOT, '.eval-runs');
const EVALS_DIR = join(ROOT, 'evals');
const EXPERIMENTS_DIR = join(ROOT, 'experiments');
const OUTPUT_PATH = join(
  ROOT,
  'apps',
  'web',
  'src',
  'data',
  'eval-results.json'
);

type ExperimentExportMetadata = {
  display: ExperimentDisplayMetadata;
  experimentSuite?: ExperimentSuite;
};

async function loadExperimentMetadata(): Promise<
  Map<string, ExperimentExportMetadata>
> {
  const map = new Map<string, ExperimentExportMetadata>();
  for (const f of (await readdir(EXPERIMENTS_DIR)).filter((f) =>
    f.endsWith('.ts')
  )) {
    const mod = await import(pathToFileURL(join(EXPERIMENTS_DIR, f)).href);
    const config = mod.default as ExperimentConfig;
    map.set(f.replace(/\.ts$/, ''), {
      display: getExperimentDisplayMetadata(config),
      experimentSuite: config.suite?.[0],
    });
  }
  return map;
}
const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, 'experiment').map(
  normalizeExperimentName
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, 'eval');
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const EXPERIMENT_SUITE_FILTERS = readExperimentSuiteFilters(rawArgs);
const MERGE = rawArgs.includes('--merge');
/**
 * Drop carried-forward rows measured under a different harness or a different
 * version of their own scenario, instead of publishing them.
 *
 * Opt-in, because a snapshot with holes and a snapshot with silent thirteen-day-
 * old rows are both wrong and which is less wrong depends on what the snapshot
 * is for. A release cut to report a measured change wants this on; a partial
 * run keeping the page populated probably does not. Without it the report
 * below still prints, so the staleness is visible either way — which is the
 * actual defect in #60. Nothing was ever *said*.
 */
const DROP_STALE = rawArgs.includes('--drop-stale');

const OUTPUT_FLAG = readRepeatedFlag(rawArgs, 'output')[0];
const outputPath = OUTPUT_FLAG ? resolve(ROOT, OUTPUT_FLAG) : OUTPUT_PATH;

/**
 * The cells this run was asked to measure: the `pairs` JSON the workflow's
 * `prepare` job emits, written to a file. With it, the export says which of
 * them produced no result and what is published in their place, and refuses
 * to write anything if too many are missing. Without it (a local export) there
 * is nothing to compare against and the check does not run.
 */
const EXPECTED_PAIRS_FLAG = readRepeatedFlag(rawArgs, 'expected-pairs')[0];
/**
 * How much of the run may be missing before the export refuses, as a fraction
 * of the expected cells, rounded down: 0.1 lets 11 of 114 benchmark cells or 1
 * of 18 regression cells go missing. See `assessCoverage` for why it is not
 * zero.
 */
const MAX_MISSING_FRACTION = (() => {
  const raw = readRepeatedFlag(rawArgs, 'max-missing-fraction')[0];
  if (raw === undefined) return 0.1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `--max-missing-fraction must be between 0 and 1, got "${raw}"`
    );
  }
  return value;
})();

/**
 * Refuse to publish anything containing a credential.
 *
 * The exported artifact is the published one, so this is the last point where
 * a secret can be stopped. Today it carries no transcripts and so no secrets,
 * but the site is meant to gain per-run drill-down, and an agent WILL echo its
 * key into a transcript: it happened on the first real run. A guard that fails
 * the export is more durable than remembering to redact.
 */
function assertNoSecrets(serialized: string): void {
  const found = collectEnvSecretValues().filter((v) => serialized.includes(v));
  if (found.length > 0) {
    throw new Error(
      `refusing to write results: output contains ${found.length} credential value(s) from the environment. ` +
        'Redact transcripts before export.'
    );
  }
  // Catch keys that are not in this process's env, e.g. a key from an earlier
  // run still sitting in a results file.
  const shapes = [/\bhd_[A-Za-z0-9_-]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/];
  for (const shape of shapes) {
    const hit = serialized.match(shape);
    if (hit) {
      throw new Error(
        `refusing to write results: output contains something shaped like a credential (${hit[0].slice(0, 6)}…).`
      );
    }
  }
}

async function readPrompt(evalId: string) {
  const promptPath = resolve(EVALS_DIR, evalId, 'PROMPT.md');
  const normalizedEvalsDir = resolve(EVALS_DIR);

  if (!promptPath.startsWith(`${normalizedEvalsDir}${sep}`)) {
    return undefined;
  }

  if (!existsSync(promptPath)) {
    return undefined;
  }

  const parsed = parseEvalMarkdown(
    await readFile(promptPath, 'utf8'),
    promptPath
  );

  return {
    ...parsed.metadata,
    prompt: parsed.body,
    promptSourcePath: relative(ROOT, promptPath).split(sep).join('/'),
  };
}

/**
 * Backfill for result files written before the harness recorded `ranAt`.
 *
 * A file's mtime is when the run wrote it, which is the right answer for
 * anything produced locally or restored from a CI artifact in the same job.
 * It is wrong if a file is ever copied or rewritten by something other than a
 * run, so it is a fallback rather than the source of truth. Returns undefined
 * rather than a guess when the file cannot be stat'd, so the page can render
 * "unknown" instead of implying freshness it cannot support.
 */
async function fileModifiedAt(filePath: string): Promise<string | undefined> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

async function readResultFile(
  filePath: string,
  sourcePath: string,
  experimentMetadata: Map<string, ExperimentExportMetadata>
): Promise<EvalResult | null> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  const result = rawEvalResultSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  const parsedResult = result.data;
  const experimentData = experimentMetadata.get(parsedResult.experiment);

  const promptData = await readPrompt(parsedResult.eval);
  const experimentSuite =
    parsedResult.experimentSuite ??
    parsedResult.profile ??
    experimentData?.experimentSuite;

  return {
    experiment: parsedResult.experiment,
    experimentSuite,
    experimentDisplay:
      parsedResult.experimentDisplay ?? experimentData?.display,
    eval: parsedResult.eval,
    // Falls back to the result file's own mtime for rows written before the
    // harness recorded this. Approximate, but a real date beats nothing: the
    // page's alternative is describing the refresh schedule, which answers a
    // different question from how old a cell is.
    ranAt: parsedResult.ranAt ?? (await fileModifiedAt(filePath)),
    runId: parsedResult.runId,
    stage: promptData?.stage ?? parsedResult.stage,
    product: promptData?.product ?? parsedResult.product,
    topic: promptData?.topic ?? parsedResult.topic,
    suite: promptData?.suite ?? parsedResult.suite,
    gatedBy: promptData?.gatedBy ?? parsedResult.gatedBy,
    interface: promptData?.interface ?? parsedResult.interface,
    cliVersion: promptData?.cliVersion ?? parsedResult.cliVersion,
    passed: parsedResult.passed === true,
    checks: parsedResult.checks,
    skills: parsedResult.skills,
    docs: parsedResult.docs,
    prompt: promptData?.prompt,
    promptSourcePath: promptData?.promptSourcePath,
    attempts: parsedResult.attempts,
    // Without this the staleness check in `--merge` cannot work: every carried
    // row reads as "no provenance recorded", because no published row ever
    // had any. The harness wrote it from 28 August; this whitelist dropped it
    // until #96.
    provenance: parsedResult.provenance,
    sourcePath,
  };
}

function shouldIncludeExperiment(experiment: string): boolean {
  if (EXPERIMENT_FILTERS.length === 0) {
    return true;
  }

  return EXPERIMENT_FILTERS.includes(normalizeExperimentName(experiment));
}

function shouldIncludeEval(evalId: string): boolean {
  if (EVAL_FILTERS.length === 0) {
    return true;
  }

  return EVAL_FILTERS.includes(evalId);
}

function shouldIncludeSuite(suite: EvalSuite | undefined): boolean {
  if (SUITE_FILTERS.length === 0) {
    return true;
  }

  return suite !== undefined && SUITE_FILTERS.includes(suite);
}

function shouldIncludeExperimentSuite(
  experimentSuite: ExperimentSuite | undefined
): boolean {
  if (EXPERIMENT_SUITE_FILTERS.length === 0) {
    return true;
  }

  return (
    experimentSuite !== undefined &&
    EXPERIMENT_SUITE_FILTERS.includes(experimentSuite)
  );
}

async function loadEvalResults(): Promise<EvalResult[]> {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }

  const experimentMetadata = await loadExperimentMetadata();
  const results: EvalResult[] = [];
  const experiments = await readdir(RESULTS_DIR);

  for (const experiment of experiments) {
    if (experiment.startsWith('.') || experiment.startsWith('_')) {
      continue;
    }

    if (!shouldIncludeExperiment(experiment)) {
      continue;
    }

    const experimentDir = join(RESULTS_DIR, experiment);
    if (!(await stat(experimentDir)).isDirectory()) {
      continue;
    }

    // Skip results whose experiment no longer exists. `.eval-runs/` is a local
    // scratch directory that outlives renames, so a rename leaves a full set of
    // results under the old name and every one of them would otherwise be
    // published: rows for an experiment nobody can run, carrying no display
    // metadata, describing scenarios that may also have been renamed. Loud,
    // because silently dropping results is how you lose a run you meant to keep.
    if (!experimentMetadata.has(experiment)) {
      console.warn(
        `skipping .eval-runs/${experiment}: no experiments/${experiment}.ts. ` +
          'Delete the directory if it is left over from a rename.'
      );
      continue;
    }

    for (const entry of await readdir(experimentDir)) {
      const entryPath = join(experimentDir, entry);
      const entryStat = await stat(entryPath);
      const relativeEntryPath = relative(RESULTS_DIR, entryPath)
        .split(sep)
        .join('/');

      if (entryStat.isFile() && entry.endsWith('.json')) {
        const evalId = entry.replace(/\.json$/, '');
        if (!shouldIncludeEval(evalId)) {
          continue;
        }

        const result = await readResultFile(
          entryPath,
          relativeEntryPath,
          experimentMetadata
        );
        if (
          result &&
          shouldIncludeSuite(result.suite) &&
          shouldIncludeExperimentSuite(result.experimentSuite)
        ) {
          results.push(result);
        }
        continue;
      }

      if (!entryStat.isDirectory()) {
        continue;
      }

      if (!shouldIncludeEval(entry)) {
        continue;
      }

      const summaryPath = join(entryPath, 'summary.json');
      if (!existsSync(summaryPath)) {
        continue;
      }

      const result = await readResultFile(
        summaryPath,
        `${relativeEntryPath}/summary.json`,
        experimentMetadata
      );
      if (
        result &&
        shouldIncludeSuite(result.suite) &&
        shouldIncludeExperimentSuite(result.experimentSuite)
      ) {
        results.push(result);
      }
    }
  }

  return results.sort(
    (a, b) =>
      a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval)
  );
}

/** Says what the merge is about to publish that this run did not measure. */
function reportCarried(
  carried: Provenanced[],
  stale: Array<{ row: Provenanced; why: string }>
) {
  if (carried.length === 0) return;

  const dates = new Map<string, number>();
  for (const row of carried) {
    const day = (row.ranAt ?? 'unknown').slice(0, 10);
    dates.set(day, (dates.get(day) ?? 0) + 1);
  }
  const spread = [...dates]
    .sort()
    .map(([day, n]) => `${day} ${n}`)
    .join(', ');
  console.log(
    `\ncarrying ${carried.length} row(s) this run did not measure — by date: ${spread}`
  );

  if (stale.length === 0) {
    console.log('  all current: same harness, same scenario files.');
    return;
  }

  const byReason = new Map<string, number>();
  for (const { why } of stale) byReason.set(why, (byReason.get(why) ?? 0) + 1);
  console.log(
    `  ${stale.length} measured under something else — ` +
      [...byReason].map(([why, n]) => `${why}: ${n}`).join(', ')
  );
  for (const { row, why } of stale.slice(0, 10)) {
    console.log(`    ${row.eval} x ${row.experiment}  (${why})`);
  }
  if (stale.length > 10) console.log(`    …and ${stale.length - 10} more`);
  console.log(
    DROP_STALE
      ? '  --drop-stale: removing these rather than publishing them.'
      : '  publishing them anyway. Pass --drop-stale to leave the cells absent instead.'
  );
}

/**
 * Says which cells this run was meant to measure and did not, and what stands
 * in for each. Printed whether or not the export goes ahead, because a refusal
 * that does not name the missing cells sends somebody to the job logs of a
 * hundred matrix jobs to find them.
 */
function reportCoverage(
  coverage: Coverage<EvalResult>,
  droppedAsStale: Set<string>
) {
  console.log(
    `\ncoverage: ${coverage.measured} of ${coverage.expected} expected cell(s) produced a result this run`
  );
  if (coverage.missing.length === 0) return;

  const carried = coverage.missing.filter((m) => m.carried);
  const absent = coverage.missing.filter((m) => !m.carried);
  console.log(
    `  ${coverage.missing.length} missing (floor allows ${coverage.allowedMissing}): ` +
      `${carried.length} published from an earlier run, ${absent.length} absent from the output`
  );
  for (const m of coverage.missing) {
    const stand = m.carried
      ? `carried: ran ${m.carried.ranAt?.slice(0, 10) ?? 'date unknown'}, run ${m.carried.runId ?? 'unknown'}`
      : droppedAsStale.has(pairKey(m))
        ? 'absent: earlier row dropped by --drop-stale'
        : MERGE
          ? 'absent: no earlier row to carry'
          : 'absent: --merge not set';
    console.log(`    ${m.eval} x ${m.experiment}  (${stand})`);
  }
}

/**
 * The same facts for the job summary, which is where somebody reading a run
 * actually looks. A carried cell on the page and a missing one look identical
 * to a reader; this is the one place they are told apart.
 */
async function writeStepSummary(
  coverage: Coverage<EvalResult> | undefined,
  carriedCount: number,
  stale: Array<{ row: Provenanced; why: string }>,
  rejected: Array<{ key: string; reason: string }>
) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const lines = [`### ${relative(ROOT, outputPath)}`, ''];
  if (coverage) {
    lines.push(
      `${coverage.measured} of ${coverage.expected} expected cells produced a result this run. ` +
        `${coverage.missing.length} missing; the floor allows ${coverage.allowedMissing}.` +
        (coverage.refuse ? ' **Refused to publish.**' : ''),
      ''
    );
    if (coverage.missing.length > 0) {
      lines.push(
        '| Scenario | Experiment | Published in its place |',
        '|---|---|---|'
      );
      for (const m of coverage.missing) {
        const stand = m.carried
          ? `row from ${m.carried.ranAt?.slice(0, 10) ?? 'unknown date'} (run ${m.carried.runId ?? 'unknown'})`
          : 'nothing: cell absent';
        lines.push(`| \`${m.eval}\` | \`${m.experiment}\` | ${stand} |`);
      }
      lines.push('');
    }
  }
  if (MERGE) {
    lines.push(
      `${carriedCount} row(s) carried forward from the previous file; ` +
        `${stale.length} measured under something else` +
        (stale.length > 0
          ? DROP_STALE
            ? ' and dropped (`--drop-stale`).'
            : ' and published anyway.'
          : '.'),
      ''
    );
  }
  if (rejected.length > 0) {
    lines.push(
      `**${rejected.length} previously published row(s) dropped** because they no longer parse as a published row:`,
      '',
      ...rejected.map(({ key, reason }) => `- \`${key}\`: ${reason}`),
      ''
    );
  }
  await appendFile(target, `${lines.join('\n')}\n`);
}

async function main() {
  const newResults = await loadEvalResults();
  const hasFilters =
    EXPERIMENT_FILTERS.length > 0 ||
    EVAL_FILTERS.length > 0 ||
    SUITE_FILTERS.length > 0 ||
    EXPERIMENT_SUITE_FILTERS.length > 0;

  // With expected pairs this waits until after the coverage report, so a run
  // that produced nothing still names every cell it was meant to produce.
  if (hasFilters && newResults.length === 0 && !EXPECTED_PAIRS_FLAG) {
    throw new Error('no result files matched the requested export filters');
  }

  let results = newResults;
  let carriedCount = 0;
  let staleRows: Array<{ row: Provenanced; why: string }> = [];
  let rejectedRows: Array<{ key: string; reason: string }> = [];
  if (MERGE && existsSync(outputPath)) {
    const existing: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
    if (!Array.isArray(existing)) {
      throw new Error(
        `${relative(ROOT, outputPath)} is not a JSON array of rows`
      );
    }
    const replaced = new Set(newResults.map(pairKey));
    const { rows: previous, rejected } = sanitizeCarried(existing);
    rejectedRows = rejected;
    if (rejected.length > 0) {
      // An annotation as well as the log line: a row leaving the published
      // file is a change to what the page shows, and nobody reads export logs.
      if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(
          `::warning::dropping ${rejected.length} previously published row(s) from ` +
            `${relative(ROOT, outputPath)} that no longer parse as a published row; see the job summary`
        );
      }
      console.warn(
        `\ndropping ${rejected.length} previously published row(s) that no longer parse as a published row:`
      );
      for (const { key, reason } of rejected) {
        console.warn(`    ${key}  (${reason})`);
      }
    }
    const carried = previous.filter((r) => !replaced.has(pairKey(r)));

    const { current, stale } = splitStale(carried, newResults);
    reportCarried(carried, stale);
    carriedCount = carried.length;
    staleRows = stale;

    results = [...(DROP_STALE ? current : carried), ...newResults].sort(
      (a, b) =>
        a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval)
    );
  }

  let coverage: Coverage<EvalResult> | undefined;
  if (EXPECTED_PAIRS_FLAG) {
    const expected = readExpectedPairs(
      JSON.parse(await readFile(resolve(ROOT, EXPECTED_PAIRS_FLAG), 'utf8')),
      (pair) =>
        shouldIncludeExperiment(pair.experiment) &&
        shouldIncludeEval(pair.eval) &&
        (SUITE_FILTERS.length === 0 ||
          SUITE_FILTERS.includes(pair.evalSuite as EvalSuite)) &&
        (EXPERIMENT_SUITE_FILTERS.length === 0 ||
          EXPERIMENT_SUITE_FILTERS.includes(
            pair.experimentSuite as ExperimentSuite
          ))
    );
    coverage = assessCoverage(
      expected,
      newResults,
      results,
      MAX_MISSING_FRACTION
    );
    reportCoverage(
      coverage,
      new Set(DROP_STALE ? staleRows.map(({ row }) => pairKey(row)) : [])
    );
  }

  await writeStepSummary(coverage, carriedCount, staleRows, rejectedRows);

  if (coverage?.refuse) {
    throw new Error(
      `refusing to write ${relative(ROOT, outputPath)}: ${coverage.missing.length} of ` +
        `${coverage.expected} expected cells produced no result, and the floor allows ` +
        `${coverage.allowedMissing} (--max-missing-fraction ${MAX_MISSING_FRACTION}). ` +
        'Read the missing cells above first. If publishing is still right, raise the ' +
        'EVALS_MAX_MISSING_FRACTION repository variable and re-run only the publish job: ' +
        'the matrix has already been paid for.'
    );
  }

  if (hasFilters && newResults.length === 0) {
    throw new Error('no result files matched the requested export filters');
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const serialized = `${JSON.stringify(results, null, 2)}\n`;
  assertNoSecrets(serialized);
  await writeFile(outputPath, serialized);

  const passed = results.filter((result) => result.passed).length;
  console.log(
    `Exported ${results.length} result(s) to ${relative(ROOT, outputPath)} ` +
      `(${passed} pass, ${results.length - passed} fail)`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
