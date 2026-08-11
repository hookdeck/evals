# Eval results format

What the published scoreboard reads. Written for anyone designing or building
against the results, including people outside this repo.

`results-sample.json` beside this file is a valid four-row example covering the
states the UI has to render. It is checked against the same schema the site uses
(`packages/core/src/results-sample.test.ts`), so it cannot drift silently.

## Where the data is

Two files, both a JSON array of run rows, one row per (experiment × eval) pair:

| File | Suite | Rendered |
|---|---|---|
| `apps/web/src/data/eval-results.json` | benchmark | Yes, this is the scoreboard |
| `apps/web/src/data/regression-eval-results.json` | regression | No, not read by the app today |

Both are currently `[]`. Nothing has been published yet, so `results-sample.json`
is the thing to mock against.

**The exported row is narrower than the raw run file.** Each run also writes
`results/<experiment>/<eval>.json`, which carries the transcript, tool calls,
token usage and cost. `export-results.ts` deliberately does not copy those
through. Anything not listed below is unavailable to the UI, whatever a raw
result file happens to contain.

## The row

| Field | Type | Notes |
|---|---|---|
| `experiment` | string | Config name, e.g. `claude-code-sonnet-5` |
| `experimentSuite` | enum, optional | `benchmark` \| `no-skills` \| `regression` |
| `experimentDisplay` | object, optional | See below |
| `eval` | string | Scenario id, e.g. `benchmark-filtering-001-enterprise-orders` |
| `stage` | enum, optional | `build` \| `investigate` \| `resolve` |
| `product` | array, optional | `event-gateway` \| `outpost` \| `console` |
| `topic` | array, optional | See taxonomy below |
| `suite` | enum, optional | `benchmark` \| `regression` \| `other` |
| `interface` | enum, optional | `mcp` \| `cli` |
| `cliVersion` | string, optional | Semver, when the scenario pins one |
| `passed` | boolean | True only if every check passed |
| `checks` | array, optional | See below |
| `attempts` | number, optional | Tries before the final grade; >1 means it was retried |
| `skills` | object, optional | See below |
| `docs` | object, optional | Documentation the agent read |
| `prompt` | string, optional | The scenario prompt body, for drill-down |
| `promptSourcePath` | string, optional | Repo path of the `PROMPT.md` |
| `sourcePath` | string | Unique per row; the app uses it to deep-link one run |

`experimentDisplay`: `{ agent, modelProvider, modelId, reasoningEffort? }` where
`agent` is `ai-sdk` | `claude-code` | `codex` | `opencode`, `modelProvider` is
`anthropic` | `openai` | `moonshotai`, and `reasoningEffort` is `minimal` |
`low` | `medium` | `high` | `max`.

`checks`: `{ name, passed, notes?, judgeNotes? }`. **Both note fields matter and
they are not interchangeable.** `notes` comes from a deterministic check and
usually states the expectation and the reality ("expected 200, got 401").
`judgeNotes` is an LLM judge's reasoning in prose. A red cell without its note is
unexplainable, so the design needs somewhere to surface them.

`skills`: `{ available, loaded, selfInstalled? }`, all arrays of skill names.
`available` is what the harness offered, `loaded` is what the agent actually
opened, and they differ often: an agent that thinks it knows the answer opens
nothing. `selfInstalled` is skills the agent fetched from the network itself.
**A `no-skills` row with a product skill in `selfInstalled` is not a valid
baseline** and should be visually distinct rather than averaged in silently.

`docs`: `{ calls: [...] }`, each call `{ source, query, hasContent?, resultChars?, pages }`
where `source` is `search_docs` | `web_fetch` | `web_search` | `shell_fetch` and
each page is `{ url, title? }`. `resultChars` approximates how much text the call
pulled into context; divide by about four for tokens.

## Taxonomy

| Dimension | Values |
|---|---|
| `stage` | `build`, `investigate`, `resolve` |
| `product` | `event-gateway`, `outpost`, `console` |
| `topic` | `signature-verification`, `filtering`, `transformations`, `retries`, `rate-limits`, `deduplication`, `local-dev`, `sdk`, `alerting`, `capabilities` |
| `suite` | `benchmark`, `regression`, `other` |
| `experimentSuite` | `benchmark`, `no-skills`, `regression` |

These are closed enums, and they are enforced. A result whose value drifts from
the enum fails to parse and is dropped from the export rather than rendered
stale.

## Three things that will bite a mock

**There is no cost field.** Cost and token usage live in the raw run file and are
not exported, so a cost column cannot be populated from this data as it stands.
Adding it is a decision, not a lookup, and it is complicated by Claude Code
reporting a dollar figure while Codex reports only tokens: any cost column needs
a non-numeric state for rows that have no price, not a zero.

**The app renames two things when it parses.** `stage` becomes `category`
(falling back to `"unknown"`), and a `primaryCategory` is derived from
`topic[0]` (falling back to `"uncategorized"`). Mocking against the file gives
you `stage`; reading the components gives you `category`. Same concept.

**The stage list in the app is still Supabase's.** `JOURNEY_STAGES` in
`apps/web/src/lib/eval-results.ts` carries four stages including `deploy`, which
our schema deliberately excludes, and descriptions that name Supabase. Do not
copy that prose into a design. Correct stages and descriptions are the three in
the taxonomy above; the plan explains why `deploy` is absent.

## Scoring model, for anyone deciding what to show

Scores are **per stage, not blended**. "Build 5/6, Investigate 2/3" is the
intended presentation; a single percentage is explicitly not. Failures are always
shown — visible failure is what makes the passing numbers credible, so a design
that hides or de-emphasises red is working against the artifact's purpose.

The comparison that carries the most meaning is a row against its `-no-skills`
twin: the two are identical apart from the skills list, so the difference between
them is what the skills added and nothing else.
