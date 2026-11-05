/**
 * Find credentials still present in run artifacts that should already have
 * been redacted. Used by `scripts/check-artifacts.ts` before upload.
 *
 * Applies the redactor's own passes to each file and reports anything they
 * would still remove: the environment's secret values, the vendor shapes and
 * the assignment layer (`api_key = '…'` and friends). It cannot check a
 * credential that was only ever read out of a sandbox, because the sandbox is
 * gone by now; those were redacted at write time.
 *
 * Findings carry file, kind and count, never a value: they are printed to a
 * public job log.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  findUnredacted,
  type SecretValue,
  secretValues,
} from '../harness/redact.js';

export interface ArtifactFinding {
  path: string;
  name: string;
  count: number;
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) =>
    entry === 'node_modules' ? [] : filesUnder(join(path, entry))
  );
}

/**
 * Check every file under `paths`, resolved against `root`. A path that does
 * not exist contributes no files, so a cell that wrote no result still has
 * whatever evidence it did write checked.
 */
export function checkArtifacts(
  paths: string[],
  root: string,
  secrets: SecretValue[] = secretValues()
): { files: number; findings: ArtifactFinding[] } {
  const files = paths.flatMap((p) => filesUnder(resolve(root, p)));
  const findings: ArtifactFinding[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { name, count } of findUnredacted(text, secrets)) {
      findings.push({ path: relative(root, file), name, count });
    }
  }
  return { files: files.length, findings };
}
