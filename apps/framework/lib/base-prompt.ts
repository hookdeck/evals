import type { EvalMode } from '../harness/types.js';

/**
 * The base prompt is a treatment, not neutral scaffolding.
 *
 * The last sentence was added on 27 August, borrowed verbatim from
 * [clerk/clerk-evals](https://github.com/clerk/clerk-evals), which prepends the
 * same line to every eval prompt on its agentic path — the closest architectural
 * match to ours, running the same two agent CLIs.
 *
 * It exists because this benchmark is single-turn: a question gets no reply, and
 * the agent is scored on whatever state it left, usually nothing. Four cells in
 * the stored runs ended that way, against a skills delta measured at two cells in
 * twenty-four, so the noise was larger than the signal it sat next to.
 *
 * **This is not a claim that asking is wrong.** τ-bench's airline policy requires
 * an agent to "list the action details and obtain explicit user confirmation
 * (yes) to proceed" before any action that updates the booking database — the
 * behaviour penalised here is a *pass requirement* there, because that harness
 * has a user to answer. Ours does not. So the line is a property of our
 * instrument, and a cell that trips `ASKED_AND_STOPPED` must never be published
 * as a capability failure. See the survey on hookdeck/evals#57 for the full
 * option space; four other benchmarks answer this four different ways.
 *
 * Everything measured before this date was measured without it, so results
 * either side are not comparable — the same rule as a scenario or CLI change,
 * and for the same reason.
 *
 * Lives here rather than in `run-eval.ts` so `preflight` can read the prompt a
 * dispatch would use without importing the runner, which executes on import.
 * Keep it a single `return` of concatenated string literals:
 * `extractBasePrompt` reads it back out of the source at an earlier release,
 * where it may still be in `run-eval.ts`.
 */
export function basePromptFor(_mode: EvalMode): string {
  return (
    'You are an agent working on a real Hookdeck project, as a developer would. ' +
    'Use the provided tools to inspect and change the project. ' +
    'When you are done, end your turn with a short summary of what you did ' +
    '(or for investigation tasks, your findings). ' +
    'Do not ask clarifying questions. Complete the task with the information provided.'
  );
}

/**
 * The base prompt as written in a source file, or undefined when the file has
 * no `basePromptFor`.
 *
 * For comparing against a release, where the function may sit in a different
 * file. Reads the string literals of its `return` and joins them, which is what
 * the concatenation evaluates to, so a reflowed line does not read as a change.
 */
export function extractBasePrompt(source: string): string | undefined {
  const start = source.search(/function\s+basePromptFor\s*\(/);
  if (start < 0) return undefined;
  const body = source.slice(start);
  const ret = body.search(/\breturn\b/);
  if (ret < 0) return undefined;
  // The function's closing brace, at the start of a line. Not the first `;`,
  // which a prompt is free to contain.
  const end = body.indexOf('\n}', ret);
  const expression = body.slice(ret, end < 0 ? undefined : end);
  const literals = [
    ...expression.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g),
  ];
  if (literals.length === 0) return undefined;
  return literals
    .map((m) => (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'))
    .join('');
}
