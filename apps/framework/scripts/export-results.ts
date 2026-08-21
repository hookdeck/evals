#!/usr/bin/env tsx
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

const OUTPUT_FLAG = readRepeatedFlag(rawArgs, 'output')[0];
const outputPath = OUTPUT_FLAG ? resolve(ROOT, OUTPUT_FLAG) : OUTPUT_PATH;

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

async function main() {
  const newResults = await loadEvalResults();
  const hasFilters =
    EXPERIMENT_FILTERS.length > 0 ||
    EVAL_FILTERS.length > 0 ||
    SUITE_FILTERS.length > 0 ||
    EXPERIMENT_SUITE_FILTERS.length > 0;

  if (hasFilters && newResults.length === 0) {
    throw new Error('no result files matched the requested export filters');
  }

  let results = newResults;
  if (MERGE && existsSync(outputPath)) {
    const existing: EvalResult[] = JSON.parse(
      await readFile(outputPath, 'utf8')
    );
    const replaced = new Set(
      newResults.map((r) => `${r.experiment}::${r.eval}`)
    );
    results = [
      ...existing.filter((r) => !replaced.has(`${r.experiment}::${r.eval}`)),
      ...newResults,
    ].sort(
      (a, b) =>
        a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval)
    );
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
