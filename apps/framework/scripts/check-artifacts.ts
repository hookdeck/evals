/**
 * Refuse to upload a run artifact that still contains a credential.
 *
 * Every artifact the harness writes goes through `serializeRedacted`, so this
 * should find nothing. It exists because that is a property of the write paths
 * that exist today, and the artifacts are downloadable by any GitHub account
 * on a public repository: a new writer that forgets, or a credential shape the
 * redactor learned after the file was written, is caught here before upload
 * rather than discovered in a download. See `lib/artifact-check.ts`.
 *
 *   pnpm --filter @hookdeck-evals/framework check-artifacts -- .eval-runs .eval-errored
 *
 * Paths are resolved against the repository root. Exits 1 on any finding,
 * printing file, kind and count and never a value.
 */
import { checkArtifacts } from '../lib/artifact-check.js';
import { EVALS_ROOT } from '../lib/discovery.js';

const paths = process.argv.slice(2).filter((a) => a !== '--');
if (paths.length === 0) {
  console.error('usage: check-artifacts <path>...');
  process.exit(2);
}

const { files, findings } = checkArtifacts(paths, EVALS_ROOT);
if (findings.length > 0) {
  for (const f of findings) {
    console.error(`::error file=${f.path}::${f.count} unredacted ${f.name}`);
  }
  console.error(
    `refusing to upload: ${findings.length} finding(s) across ${files} file(s). ` +
      'A write path is not going through serializeRedacted, or redact.ts has ' +
      'learned a pattern since these files were written.'
  );
  process.exit(1);
}
console.log(`checked ${files} file(s): no unredacted credentials`);
