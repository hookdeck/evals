/**
 * The shape of a preflight result and how it is printed.
 *
 * Two kinds of check, because #131 separates them and the difference decides
 * the exit code. An **assertion** is a fact that has to hold before a matrix is
 * worth paying for, and a failed one fails the script. A **decision** is a gap
 * somebody has to choose about — a pin behind `latest`, a prompt that moved — and
 * it never fails, because staying on an old pin is a legitimate choice. What is
 * not legitimate is making it silently, so a decision with a gap says so and
 * says where the choice is recorded.
 */

export type CheckKind = 'decision' | 'assertion';

/**
 * - `pass`: nothing to do.
 * - `fail`: an assertion that does not hold. Fails the script.
 * - `decide`: a decision with a gap. Never fails the script.
 * - `warn`: holds, or could not be decided, with something worth reading.
 * - `skipped`: the operator passed `--skip`. Printed loudly, never silently.
 */
export type CheckStatus = 'pass' | 'fail' | 'decide' | 'warn' | 'skipped';

export interface CheckResult {
  /** The id `--skip` takes. */
  id: string;
  /** Its number in #131, so the report and the issue can be read side by side. */
  number: number;
  title: string;
  kind: CheckKind;
  status: CheckStatus;
  summary: string;
  details: string[];
}

export const DECISION_FOOTER = 'decision required: record in the release notes';

export interface ReportMeta {
  generatedAt: string;
  headSha?: string;
  dispatchSha?: string;
  skipped: string[];
  notes: string[];
}

const LABEL: Record<CheckStatus, string> = {
  pass: 'PASS  ',
  fail: 'FAIL  ',
  decide: 'DECIDE',
  warn: 'WARN  ',
  skipped: 'SKIP  ',
};

/** Non-zero when any assertion failed. Decisions and skips never fail. */
export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.kind === 'assertion' && r.status === 'fail')
    ? 1
    : 0;
}

export function summarise(results: CheckResult[]): {
  failed: CheckResult[];
  decisions: CheckResult[];
  skipped: CheckResult[];
  warnings: CheckResult[];
} {
  return {
    failed: results.filter(
      (r) => r.kind === 'assertion' && r.status === 'fail'
    ),
    decisions: results.filter((r) => r.status === 'decide'),
    skipped: results.filter((r) => r.status === 'skipped'),
    warnings: results.filter((r) => r.status === 'warn'),
  };
}

function section(title: string, results: CheckResult[]): string[] {
  if (results.length === 0) return [];
  const lines = ['', title, '-'.repeat(title.length)];
  for (const r of [...results].sort((a, b) => a.number - b.number)) {
    lines.push(
      `${LABEL[r.status]} ${String(r.number).padStart(2)}. ${r.title}: ${r.summary}`
    );
    for (const d of r.details) lines.push(`             ${d}`);
    if (r.status === 'decide') lines.push(`             -> ${DECISION_FOOTER}`);
  }
  return lines;
}

export function formatReport(results: CheckResult[], meta: ReportMeta): string {
  const lines: string[] = [`Preflight, ${meta.generatedAt}`];
  if (meta.headSha) lines.push(`  checked at HEAD ${meta.headSha}`);
  if (meta.dispatchSha)
    lines.push(`  a dispatch runs main ${meta.dispatchSha}`);
  for (const note of meta.notes) lines.push(`  NOTE: ${note}`);
  if (meta.skipped.length > 0) {
    lines.push(
      '',
      '!!! SKIPPED BY REQUEST: ' + meta.skipped.join(', ') + ' !!!',
      '!!! Nothing below says these hold. Name them in the release notes. !!!'
    );
  }

  lines.push(
    ...section(
      'Decisions',
      results.filter((r) => r.kind === 'decision')
    ),
    ...section(
      'Assertions',
      results.filter((r) => r.kind === 'assertion')
    )
  );

  const { failed, decisions, skipped } = summarise(results);
  lines.push('');
  lines.push(
    failed.length === 0
      ? 'Result: every assertion that ran holds.'
      : `Result: ${failed.length} assertion${failed.length === 1 ? '' : 's'} failed: ` +
          failed.map((r) => r.id).join(', ') +
          '. Do not dispatch.'
  );
  if (decisions.length > 0) {
    lines.push(
      `${decisions.length} decision${decisions.length === 1 ? '' : 's'} to record in the release notes: ` +
        decisions.map((r) => r.id).join(', ')
    );
  }
  if (skipped.length > 0) {
    lines.push(`Skipped by request: ${skipped.map((r) => r.id).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Remove secret values from text before it is printed.
 *
 * Belt and braces: no check prints a credential on purpose, but a provider's
 * error body or a URL can echo one back, and the report gets pasted into issues.
 */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < 8) continue;
    out = out.split(secret).join('****');
  }
  return out;
}
