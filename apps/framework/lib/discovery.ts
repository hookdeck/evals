import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEvalMarkdown } from '@hookdeck-evals/core/eval-markdown';
import type { EvalManifest, ExperimentConfig } from '../harness/types.js';

/**
 * Finding the scenarios and experiments on disk.
 *
 * Extracted from `run-eval.ts` so `score-only.ts` uses the same discovery
 * rather than a second copy that drifts. Both need to answer "which scenarios
 * exist and where are their parts", and a scorer harness that disagreed with
 * the runner about that would be measuring something else.
 */

export const EVALS_ROOT = join(
  new URL('.', import.meta.url).pathname,
  '..',
  '..',
  '..'
);

/**
 * Every run is what upstream called tools mode. The local-stack branch went
 * with the Supabase runtime, so the distinction no longer exists.
 */
function resolveEvalMode() {
  return 'tools' as const;
}

export function discoverEvals(root: string = EVALS_ROOT): EvalManifest[] {
  const dir = join(root, 'evals');
  if (!existsSync(dir)) return [];
  const out: EvalManifest[] = [];
  for (const id of readdirSync(dir)) {
    const evalDir = join(dir, id);
    if (!statSync(evalDir).isDirectory()) continue;
    const localDir = join(evalDir, 'local');
    const promptPath = join(evalDir, 'PROMPT.md');
    const evalPath = join(evalDir, 'EVAL.ts');
    const metadata = parseEvalMarkdown(
      readFileSync(promptPath, 'utf8'),
      `evals/${id}/PROMPT.md`
    ).metadata;
    const hasLocal = existsSync(localDir) && statSync(localDir).isDirectory();
    out.push({
      id,
      mode: resolveEvalMode(),
      metadata,
      stage: metadata.stage,
      product: metadata.product,
      suite: metadata.suite,
      topic: metadata.topic,
      dir: evalDir,
      localDir: hasLocal ? localDir : undefined,
      promptPath,
      evalPath,
      remoteDir: join(evalDir, 'remote'),
      solutionPath: existsSync(join(evalDir, 'SOLUTION.ts'))
        ? join(evalDir, 'SOLUTION.ts')
        : undefined,
    });
  }
  return out;
}

/**
 * Seed arguments for a session, matching what the runner passes.
 *
 * Only `remoteDir` seeds the project. `localDir` is the sandbox working
 * directory an agent gets and has nothing to do with project state — passing it
 * here instead leases a pristine project with none of the scenario's starting
 * data, so every scorer that reads seeded history fails for a reason that has
 * nothing to do with the scorer.
 */
export function readSessionSeedArgs(ev: EvalManifest) {
  return {
    remoteDir: existsSync(ev.remoteDir) ? ev.remoteDir : undefined,
  };
}

export async function loadExperiments(
  root: string = EVALS_ROOT
): Promise<Array<{ name: string; config: ExperimentConfig }>> {
  const dir = join(root, 'experiments');
  const out: Array<{ name: string; config: ExperimentConfig }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    out.push({ name: f.replace(/\.ts$/, ''), config: mod.default });
  }
  return out;
}
