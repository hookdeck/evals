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

Both are populated by CI. `results-sample.json` is still the thing to mock
against, because it covers states a given run may not contain.

The published contract is `results/` rather than either file: see
[Published snapshots](#published-snapshots) below.

**The exported row is narrower than the raw run file.** Each run also writes
`.eval-runs/<experiment>/<eval>.json`, which carries the transcript, tool calls,
token usage, cost and `priorAttempts` — the transcript and checks of every
attempt a retry superseded. `export-results.ts` deliberately does not copy any
of those through. Anything not listed below is unavailable to the UI, whatever a
raw result file happens to contain. That holds for rows carried forward by
`--merge` as well: they are parsed with the same schema as fresh rows, and a row
that no longer parses is reported and dropped rather than republished.

**A cell that errors writes no row at all**, by design: a dead agent process is
not an answer. What its earlier attempts left goes to
`.eval-errored/<experiment>/<eval>.json` instead, outside the tree the exporter
reads, with `errored: true`, the error, `priorAttempts` and the attempt that was
running when it errored. In CI it is uploaded as a separate
`errored-attempts-<experiment>__<eval>` artifact, which the publish job never
downloads. The exporter also refuses any file with `errored: true` or without a
boolean `passed`, so evidence copied into `.eval-runs/` by mistake is skipped
with a warning rather than published as a failure.

## The row

| Field | Type | Notes |
|---|---|---|
| `experiment` | string | Config name, e.g. `claude-code-sonnet-5` |
| `experimentSuite` | enum, optional | `benchmark` \| `no-skills` \| `regression` |
| `experimentDisplay` | object, optional | See below |
| `eval` | string | Scenario id, e.g. `benchmark-filtering-001-enterprise-orders` |
| `ranAt` | string, optional | ISO timestamp of when this cell's run finished. Per row, because a merged file holds rows from several runs |
| `runId` | string, optional | The GitHub Actions run that produced this row. Absent for local runs and rows before 17 August 2026 |
| `provenance` | object, optional | `{ harness, scenario, skillsPin? }`: two short fingerprints and a commit. See below |
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

`provenance`: what the row was measured under. `harness` covers what every
scenario shares — the base prompt, the sandbox CLI pin, the skills CLI, the
skills submodule pin and the sandbox image definition (the Dockerfile) — and
`scenario` covers the scenario's own files. The image definition joined in
November 2026, so every row recorded before then has a different `harness`
from every row after it; that is correct, because the image change gave Codex
the pinned CLI on PATH for the first time. Two rows
with the same `scenario` and different `harness` measured the same task under a
different instrument. Opaque: compare for equality, do not parse. `skillsPin`
is the skills submodule commit the row ran against, in the clear, possibly with a
suffix when that checkout had uncommitted changes; absent from rows recorded
before the harness wrote it. The whole object is absent from
every row published before November 2026, because the exporter dropped it
(#96); `export-results --merge` reports such rows as `no provenance recorded`.

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

`docs`: `{ calls: [...] }`, each call `{ source, query, hasContent?, resultChars?, httpError?, pages }`
where `source` is `search_docs` | `web_fetch` | `web_search` | `shell_fetch` and
each page is `{ url, title? }`. `resultChars` approximates how much text the call
pulled into context; divide by about four for tokens. It is omitted when no
result was visible, which is every Codex hosted `web_search`.

`httpError` is set on `web_fetch` and `shell_fetch` calls that have a result, and
has three states:

| value | meaning |
|---|---|
| a number | the fetch answered with that HTTP error status instead of the page: Claude Code's WebFetch error stub, or a piped `curl -f` whose whole output is `curl: (22) …`. `pages` still names the url that was asked for. |
| `null` | the result was checked and was not an error |
| absent | the row was exported before the check existed (November 2026), or the source is never checked |

A consumer that wants to recognise errors on older rows has to infer them, and
`apps/framework/lib/docs-reach.ts` does so from `resultChars` only when
`httpError` is absent. Never infer when it is `null`: a real page can be any
length.

`hasContent: false` means the result was a list of links rather than page text.
For Claude Code's WebSearch, `pages` is the hits it returned, including when the
query was itself a url. Rows exported before November 2026 recorded such a
url-shaped query as its own page, with `hasContent` absent.

## Published snapshots

`results/latest.json` is the most recent publish, `results/runs/<stamp>.json`
keeps each one, and `results/index.json` lists them newest first. A snapshot
wraps the rows:

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | number | `1` |
| `publishedAt` | string | When the snapshot was published, not when its rows ran |
| `runId` | string, optional | The run that published it. **Not necessarily the run that produced every row** |
| `counts` | object | `{ rows, experiments, evals, passed, runs }`; `runs` is distinct `runId`s among the rows |
| `composition` | object | What the snapshot is made of. See below |
| `results` | array | The rows above |

**A snapshot is not a run.** `export-results --merge` carries forward every cell
a run did not re-execute, so one snapshot can hold rows measured weeks apart.
`composition` says so at the top of the file instead of leaving it to be derived:

| Field | Type | Notes |
|---|---|---|
| `mixed` | boolean | True when rows come from more than one run, or when any row has no `runId` |
| `ranAt` | object | `{ earliest?, latest? }` across every row |
| `carried` | number, optional | Rows whose `runId` is not the snapshot's `runId`. Absent when the snapshot has no `runId` |
| `runs` | array | `{ runId, rows, earliest?, latest? }` per run, newest first. `runId` is `null` for rows without one |

**Anything rendering one date for a snapshot should check `mixed` first.** When
it is true, "Results from 28 September" over 38 rows measured on 1 September is
wrong; say which runs and dates the rows came from. Snapshots published before
November 2026 have no `composition`; derive the same thing from each row's
`runId` and `ranAt`, which every row since 17 August carries.

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
