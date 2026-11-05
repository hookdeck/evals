/**
 * Why a JSON file in `.eval-runs/` is not a result row, or `undefined` if it
 * is one.
 *
 * The raw row schema (`rawEvalResultSchema`) is deliberately loose: it needs
 * only `experiment` and `eval` and tolerates anything else, because raw files
 * carry fields the published row does not model. So it cannot tell a result
 * from any other JSON that happens to name a cell, and the exporter turns a
 * missing `passed` into `false`. Anything with those two fields that lands in
 * `.eval-runs/<experiment>/` therefore publishes as a failure against a named
 * agent — the 13 August incident.
 *
 * The case that made this concrete is errored-cell evidence (#97). It lives in
 * `.eval-errored/`, which the exporter does not read, but a downloaded
 * `errored-attempts-*` artifact has the same `<eval>.json` layout as a
 * `raw-results-*` one, so rebuilding `.eval-runs/` from a download can put it
 * where a result belongs. Refusing it here makes location a convenience rather
 * than the only thing standing between evidence and the scoreboard.
 *
 * Kept outside `scripts/export-results.ts` because that file runs `main()` at
 * module scope and so cannot be imported by a test.
 */
export function whyNotAResultRow(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return 'not a JSON object';
  }
  const row = parsed as Record<string, unknown>;
  if (row.errored === true) {
    return (
      'errored-cell evidence, not a result. It belongs in .eval-errored/; ' +
      'an errored cell has no row by design'
    );
  }
  // Every row the harness writes carries a boolean `passed`, because it spreads
  // a `ScoreResult`. A file without one was not written as a result, and
  // reading it as `passed: false` is a wrong row rather than a missing one.
  if (typeof row.passed !== 'boolean') {
    return 'no boolean `passed`, so it was not written as a result';
  }
  return undefined;
}
