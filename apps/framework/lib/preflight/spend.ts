/**
 * What a requested matrix is likely to cost, from the figures AGENTS.md
 * records as measured.
 *
 * Read from AGENTS.md rather than copied here, because that table is where the
 * measurements live and where they get corrected; a second copy is how the
 * judge came to be reported at twenty-eight times its real cost. The figures
 * are per full pass at a stated denominator, and AGENTS.md is explicit that
 * scaling them is arithmetic rather than measurement, so the estimate says
 * which figures it scaled.
 *
 * Neither provider exposes a credit balance to a project key, so this never
 * claims to know one. It prints the estimate and a person confirms the balance
 * covers it.
 */

export interface CostTable {
  /** Scenarios in the pass the figures were measured over. */
  denominator: number;
  /** Dollars per full pass, keyed by experiment name without `-no-skills`. */
  perPass: Record<string, number>;
  /** Dollars per full pass for the LLM judge. */
  judgePerPass?: number;
}

const WORD_NUMBERS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/**
 * The per-pass cost table in AGENTS.md, or undefined when it cannot be found.
 * Undefined is a failure for the caller: an estimate with no figures behind it
 * is worse than none.
 */
export function parseCostTable(agentsMd: string): CostTable | undefined {
  const heading =
    /Measured per full pass of \*{0,2}([a-z]+|\d+)\*{0,2} scenarios/i.exec(
      agentsMd
    );
  if (!heading) return undefined;
  const word = (heading[1] as string).toLowerCase();
  const denominator = /^\d+$/.test(word) ? Number(word) : WORD_NUMBERS[word];
  if (!denominator) return undefined;

  const after = agentsMd.slice(heading.index);
  const perPass: Record<string, number> = {};
  let judgePerPass: number | undefined;
  let inTable = false;
  for (const line of after.split('\n').slice(1)) {
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const m = /^\|\s*(.+?)\s*\|\s*about \$([\d.]+)\s*\|/.exec(line);
    if (!m) continue;
    const label = m[1] as string;
    const dollars = Number(m[2]);
    if (/full matrix/i.test(label)) continue;
    if (/judge/i.test(label)) {
      judgePerPass = dollars;
      continue;
    }
    const name = /`([^`]+)`/.exec(label)?.[1];
    if (name) perPass[name] = dollars;
  }
  if (Object.keys(perPass).length === 0) return undefined;
  return { denominator, perPass, judgePerPass };
}

export interface PlannedCell {
  experiment: string;
  eval: string;
  /** Attempts allowed for this cell: `--runs`, raised by `min_attempts`. */
  runs: number;
}

export interface SpendRow {
  experiment: string;
  cells: number;
  /** Dollars for one attempt of one cell, agent plus judge. */
  perAttempt: number;
  /** Probability an attempt fails, which is what buys a retry. */
  failRate: number;
  failRateSource: string;
  /** Every cell run exactly once. */
  firstAttempts: number;
  low: number;
  high: number;
  /** False when no measured figure covers this experiment. */
  priced: boolean;
}

export interface SpendEstimate {
  rows: SpendRow[];
  firstAttempts: number;
  low: number;
  high: number;
  unpriced: string[];
  assumptions: string[];
}

export function costKey(experiment: string): string {
  return experiment.replace(/-no-skills$/, '');
}

/**
 * Expected cost of one cell relative to one typical attempt.
 *
 * `--runs` stops at the first pass, so attempt `i` (counting from 0) runs only
 * when the `i` before it failed: probability `f^i`. Each of those costs `k`
 * times a typical attempt, because the attempts that repeat are by construction
 * the failed ones and a failing cell tends to run to its timeout. AGENTS.md
 * writes the three-attempt case as `1 + 0.114k`.
 */
export function attemptMultiplier(
  failRate: number,
  runs: number,
  k: number
): number {
  let extra = 0;
  for (let i = 1; i < runs; i++) extra += failRate ** i;
  return 1 + k * extra;
}

/** `k` is unmeasured (#6). AGENTS.md brackets it with 1 and 3. */
export const FAILED_ATTEMPT_COST = { low: 1, high: 3 };

/** Used when the published results carry no rows for an experiment. */
export const DEFAULT_FAIL_RATE = 0.25;

export function estimateSpend(
  cells: PlannedCell[],
  costs: CostTable,
  failRates: Record<string, { rate: number; source: string }>
): SpendEstimate {
  const judgePerCell = (costs.judgePerPass ?? 0) / costs.denominator;
  const priced = Object.values(costs.perPass).map((v) => v / costs.denominator);
  // An experiment with no measured figure is priced at the dearest one we have,
  // and named, so an estimate never quietly drops a model it cannot price.
  const fallback = Math.max(...priced);

  const byExperiment = new Map<string, PlannedCell[]>();
  for (const cell of cells) {
    const list = byExperiment.get(cell.experiment) ?? [];
    list.push(cell);
    byExperiment.set(cell.experiment, list);
  }

  const rows: SpendRow[] = [];
  const unpriced: string[] = [];
  for (const [experiment, list] of [...byExperiment].sort()) {
    const perPass = costs.perPass[costKey(experiment)];
    const isPriced = perPass !== undefined;
    if (!isPriced) unpriced.push(experiment);
    const perAttempt =
      (isPriced ? perPass / costs.denominator : fallback) + judgePerCell;
    const fail = failRates[experiment] ?? {
      rate: DEFAULT_FAIL_RATE,
      source: 'no published rows; assumed',
    };
    let low = 0;
    let high = 0;
    for (const cell of list) {
      low +=
        perAttempt *
        attemptMultiplier(fail.rate, cell.runs, FAILED_ATTEMPT_COST.low);
      high +=
        perAttempt *
        attemptMultiplier(fail.rate, cell.runs, FAILED_ATTEMPT_COST.high);
    }
    rows.push({
      experiment,
      cells: list.length,
      perAttempt,
      failRate: fail.rate,
      failRateSource: fail.source,
      firstAttempts: perAttempt * list.length,
      low,
      high,
      priced: isPriced,
    });
  }

  const sum = (key: 'firstAttempts' | 'low' | 'high') =>
    rows.reduce((acc, r) => acc + r[key], 0);
  return {
    rows,
    firstAttempts: sum('firstAttempts'),
    low: sum('low'),
    high: sum('high'),
    unpriced,
    assumptions: [
      `per-pass figures from AGENTS.md, measured over ${costs.denominator} scenarios and divided by ${costs.denominator}: scaled, not re-measured`,
      `a failed attempt costs ${FAILED_ATTEMPT_COST.low}x to ${FAILED_ATTEMPT_COST.high}x a typical one; unmeasured (#6)`,
      'fail rates are per attempt, from the published rows that needed more than one attempt or failed',
    ],
  };
}

/**
 * Per-attempt fail rate for each experiment, from published rows.
 *
 * A row that took more than one attempt, or failed, had at least one failed
 * attempt. A row that failed every attempt is still counted once, so where
 * failures repeat this understates the rate; the source string says how it was
 * derived so nobody reads it as a measurement of attempts.
 */
export function failRatesFromRows(
  rows: Array<{ experiment?: string; passed?: boolean; attempts?: number }>
): Record<string, { rate: number; source: string }> {
  const tally = new Map<string, { failed: number; total: number }>();
  for (const row of rows) {
    if (!row.experiment) continue;
    const t = tally.get(row.experiment) ?? { failed: 0, total: 0 };
    t.total += 1;
    if (row.passed === false || (row.attempts ?? 1) > 1) t.failed += 1;
    tally.set(row.experiment, t);
  }
  const out: Record<string, { rate: number; source: string }> = {};
  for (const [experiment, t] of tally) {
    out[experiment] = {
      rate: t.failed / t.total,
      source: `${t.failed}/${t.total} published rows needed a retry or failed`,
    };
  }
  return out;
}

export function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}
