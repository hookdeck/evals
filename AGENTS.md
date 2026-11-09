# Working in this repo

`README.md` is for people: what this project is, why it exists, how to run it,
and how to consume the published results. This file is for whoever is changing
the code, human or agent: current status, what things cost, and the conventions
and traps that were expensive to learn. If a fact is only useful while editing
this repo, it belongs here; if it is useful to someone reading about the
benchmark, it belongs in the README.

## Status

Phases 0 and 1 are done. Phases 2 and 3 are substantially done: twenty-two
scenarios exist, nineteen benchmark and three regression, and every benchmark
scenario has produced a valid result against all six experiments.

**Do not keep a per-scenario status table here.** There was one and it went
stale within a day, because a run regenerates the same information and this file
does not. `results/latest.json` is authoritative for what passes what. Query it:

```bash
python3 -c "
import json
from collections import defaultdict
rows=json.load(open('results/latest.json'))['results']
m=defaultdict(dict)
for r in rows: m[r['eval']][r['experiment']]=r['passed']
for e in sorted(m): print(e, sum(1 for v in m[e].values() if v), '/', len(m[e]))
"
```

**Experiments: six.** `claude-code-sonnet-5` and `codex-gpt-5.6` with
`['hookdeck', 'event-gateway']`, `-no-skills` twins of each, and
`codex-gpt-5.4-mini` in both arms as a deliberately weaker model.

**What the numbers say.** The 6 November snapshot is best of three attempts, and
at that threshold one scenario of nineteen has a failing cell: `outpost-001`, for
`codex-gpt-5.4-mini-no-skills`. Counted from the raw artifacts, twelve of its 114
cells failed at least one attempt, across six scenarios, and seven of the twelve
are the weak model. The 28 September snapshot, single attempts, had nine
scenarios with a failing cell. Best of three and one attempt are different
thresholds, so do not read the drop as agents getting better: a cell that fails
once and passes on retry is variance until its transcript says otherwise. The
frontier agents pass everything at best of three; the weak model is where most
failed attempts live, which is the floor working as intended.

The skills axis has not settled, and this paragraph has been rewritten four times
in the direction of less confidence. It once said the weak model was **two worse**
with skills than without; on 28 September that model read **four better** (18/19
against 14/19). Across the four September runs the delta read -1, +1, +4 and +4,
and on 5 and 6 November it read −1 and +1. Neither November reading is comparable
with September: both are best of three, and both were measured at the new skills
pin (`84e59f4`, #102). Nor is the 5 November reading clean on its own, because
Codex's login shells could not find the pinned CLI in that run (#114). #2 was
closed on 22 September with its premise withdrawn: the -3 that started it is from
the credit-outage day and no run since reproduced it.

What survives is the warning rather than the number. **Do not report the skills
delta as a single figure**, do not report a sign as replicated until it has
replicated, and read it per row — the disagreements move between runs, so a total
hides which cells produced it. The one mechanism that is documented rather than
inferred stands: a skill that lists example values is read as an exhaustive list,
which once led a weak model to conclude a supported provider was unsupported.

**Count executions, not snapshot files.** A snapshot republishes the cells a run
did not re-measure (#60), so iterating `results/runs/*.json` counts one execution
many times. The 17 August weak-pair cells sit in seven snapshot files and read −2
in every one, which is where this section's "eight of the nine later runs read
−2" came from. Keyed per execution, the eight full-suite runs of the weak pair read:

| executed | `+skills` | `-no-skills` | delta |
|---|---|---|---|
| 13 August | 10/15 | 13/15 | −3 |
| 17 August | 9/15 | 11/15 | −2 |
| 1 September | 14/19 | 15/19 | −1 |
| 7 September | 16/19 | 15/19 | +1 |
| 14 September | 18/19 | 14/19 | +4 |
| 28 September | 18/19 | 14/19 | +4 |
| 5 November | 17/19 | 18/19 | −1 |
| 6 November | 19/19 | 18/19 | +1 |

The first six rows are single attempts. Every one of those runs was dispatched or
scheduled at `runs=1`, and only `outpost-003`, which sets `min_attempts: 3`, ever
took a second attempt in them. The two November rows are `--runs 3` with stop on
pass. So the table changes instrument between its sixth and seventh rows, and
the November rows are best of three.

The two +4 rows are not one result counted twice. Six cells changed between
them, two in the `+skills` arm and four in the baseline, and the totals happen to
land on the same numbers.

The −3 is from 13 August, the credit-outage day described under costs below, so
treat it as suspect until its rows are checked against the outage window: a bad
population is identified by its cause, not by what its rows look like.

Recompute rather than quoting the table:

```bash
python3 -c "
import json,glob
from collections import defaultdict
cells={}
for f in sorted(glob.glob('results/runs/*.json')):
    for r in json.load(open(f))['results']:
        run = r.get('runId') or (r.get('ranAt') or '')[:10]
        cells[(run, r['eval'], r['experiment'])] = r
arms=defaultdict(lambda: defaultdict(lambda: [0, 0]))
for (run, _, exp), r in cells.items():
    if not exp.startswith('codex-gpt-5.4-mini'): continue
    a = 'base' if exp.endswith('-no-skills') else 'skills'
    arms[run][a][0] += 1 if r['passed'] else 0
    arms[run][a][1] += 1
for run in sorted(arms, key=str):
    s, b = arms[run]['skills'], arms[run]['base']
    if s[1] and b[1]: print(f'{str(run):14} {s[0]}/{s[1]:<3} {b[0]}/{b[1]:<3} {s[0]-b[0]:+d}')
"
```

Two things that output will not tell you. **The denominators are the filter:** a
row reading `2/2` is a partial re-run of a couple of cells, not a suite delta.
And **most August rows carry no `runId`**, so they fall back to their date and two
executions on the same day merge. 13 August's cells carry no `runId`, and most
carry a placeholder midnight timestamp rather than a real time, so everything run
that day reads as one row and nothing in it says how many runs it was. That is another reason to read that day by cause rather than by row.

**Every pair in `results/latest.json` now shares an execution, and the file
still spans three.** It is a merged snapshot. Claude Code's Event Gateway cells
are from 5 November (run 42044644850), its Outpost cells from 6 November
(42256415982), and every Codex cell from 6 November (42220222687), under two
harness fingerprints. Each `+skills` arm and its `-no-skills` twin carry the same
`runId`, so a pair's delta compares one instrument with itself; a comparison
across models crosses runs. Until 5 November that was not true of the frontier
pairs: their `+skills` arms were executed on 28 September and their twins on
1 September, four weeks apart, and subtracting them gave a number that was not a
skills delta. Check `runId` per experiment before subtracting any pair.

**State the scenario set and the model with any skills delta**, or it will be
compared against a number measuring something else. Loop 2's corrected
measurement was `+skills` 12/12 against `-no-skills` 10/12, but that is five
Outpost scenarios across all three models rather than nineteen scenarios on the
weak model, and the two populations answer different questions. They were once
conflated into a claim that the weak model's sign had flipped. Three September
executions now do read positive on their own, and that is still no reason to
merge the two populations.

**Product findings come from runs, not speculation.** Several concern
`hookdeck listen`. On CLI 2.3.1 it crashed without a TTY unless given
`--output compact`, and it fell back to an unauthenticated guest Console session
even with `HOOKDECK_API_KEY` set, which let a weaker model report success while
bypassing the project entirely. CLI 2.5.0, the sandbox pin since 14 August, was
released to fix both (hookdeck-cli#333 and #334). What a run has shown since is
narrower than "fixed": on 5 November (run 42044644850) Claude Code started
`hookdeck listen` under `nohup` with no `--output` flag, and the CLI printed
"Non-interactive mode detected", created its source and printed its listening
banner instead of crashing. Nothing in that transcript then sent it an event,
and none of the transcripts behind the 6 November snapshot shows a guest
session. The scorers still pass `--output compact`, which costs nothing.
Separately, a CLI destination with no connected session has its requests ignored
with cause `CLI_DISCONNECTED` rather than queued, so nothing retries. The plan
has the detail.

**The repository is public**, as of 13 August. Results are published to
`results/` as a contract, and `raw-results-*` artifacts keep transcripts, tool
calls and agent reports for 90 days. Those artifacts are the only record of
*why* an agent did something; a published row cannot tell you.

CI runs formatting, typecheck, unit tests and build on pull requests. It ran
only formatting until 12 August, and two defects reached main that any of the
others would have caught.

`eval-refresh` runs the **regression suite** weekly (Monday 06:00 UTC, every
experiment) and nothing else on a schedule. Benchmark runs are dispatched
against a bucket of work — see Runs below. Check `gh secret list` against the workflow env
rather than trusting any list written here: `OUTPOST_API_KEY` was documented as
a secret before it existed, and the first full matrix run scored `outpost-001`
as six agent failures because of it.

## What this costs, and what it has cost

Runs bill per token and the numbers matter, because cadence is chosen against
them and the choice is otherwise re-derived from scratch every time.

Measured per full pass of **fifteen** scenarios:

| | |
|---|---|
| `claude-code-sonnet-5` | about $20 |
| `codex-gpt-5.6` (resolves to `gpt-5.6-sol`) | about $7 |
| `codex-gpt-5.4-mini` | about $4 |
| LLM judge (`gpt-5.5`) | about $0.10 |
| Full matrix, six experiments | about $64 |

**There are nineteen benchmark scenarios now, so scale those figures by about
1.27: roughly $81 a full matrix.** The table is left at its measured denominator
rather than rewritten, because the figures were measured and the scaling is
arithmetic, and conflating the two is how the judge came to be reported at
twenty-eight times its real cost. Re-measure rather than re-scale if a decision
turns on it.

**Claude Code was re-measured on 5 November**, in run 42044644850: nineteen
scenarios, both arms, `--runs 3`. Its own `total_cost_usd` came to $35.46 across
38 cells, $18.65 for `+skills` and $16.81 for `-no-skills`, which is below the
scaled $25 a pass. Read it as a floor. A raw result keeps only its final
attempt's `usage`, and two of those cells took a second attempt that is not
counted. Codex reports tokens and no cost, so its rows above stay as measured.

Weekly frontier plus weak pair was roughly $185 a month, and everything weekly
would have been $279 against a $200 budget. Both are historical: the benchmark
came off the schedule on 1 October 2026, so the recurring cost is now one
regression run a week and whatever is dispatched deliberately.

**Multiple attempts are far cheaper than they look, because `--runs` stops at the
first pass.** `STOP_ON_PASS` is the default, so a retry is only paid for on a cell
that failed. At the current pass rates the expected attempts per cell at
`--runs 3` is **1.11**, not 3 — and it is unevenly distributed, 1.06 for the
frontier arms against 1.25 for the weak model, which is also where the signal is.
The first full matrix at `--runs 3`, on 5 November (run 42044644850), measured
it: 128 attempts for 114 cells, 1.12 a cell, with 1.05 for the frontier arms and
1.26 for the weak model.

The true multiplier is somewhat higher, because the attempts that repeat are by
construction the failed ones and a failing cell tends to run to the timeout. It
is `1 + 0.114k` where `k` is what a failed attempt costs relative to a typical
one — 1.11× at k=1, 1.34× at k=3. **`k` is not known.** When this was written,
4 of 114 published rows carried `usage.costUsd` and all four passed. Published
rows now carry no `usage` at all, and a raw result records only its final
attempt's, so a superseded failed attempt is never costed. A Claude Code cell
that failed every attempt would record one, and none did on 5 November. See #6.
Budget a three-attempt matrix at $90–$110 and treat anything more precise as a
residual rather than a measurement.

**Failed runs cost the same as successful ones.** On 13 August the OpenAI credit
balance reached zero mid-run; thirty-seven Codex jobs then started, failed and
were paid for in wall-clock time, and a further twenty-two runs from earlier
that night were scored as agent failures despite the agent never making a tool
call. A separate full matrix was cancelled 27 jobs in. Somewhere around $50 was
spent producing nothing usable, across a single day.

That is what the guards are for, and why they are worth keeping:

- a preflight makes one real inference call per provider before the matrix
  starts, turning six hours of failure into thirty seconds
- a credit, quota or auth failure in any job cancels the whole run
- a run that errors before emitting a transcript event throws rather than being
  scored

Two of those exist because the cheap version was tried first and did not work.
`/v1/models` answers 200 with a zero credit balance, so a liveness check built
on it passes while every real call fails; only an actual completion sees it.

## Runs

**Nothing runs the benchmark on a schedule.** One cron remains, weekly, and it runs
the regression suite only: three scenarios guarding mistakes already seen and fixed,
across all six experiments, two attempts each. Every agent passing is the expected
state, so a failing check **fails the job** here — the opposite of the benchmark suite,
where a failure is a score — and the run opens or updates an issue labelled
`regression-alert`, because a red run in a tab nobody has open is not a notification.
It is one issue per failing scenario, titled `Regression failing: <eval id>`, and each
failing cell is labelled by the step that failed: a red check is the agent or the
scorer, and an errored eval step means the cell has no verdict, usually the harness, a
provider or the agent CLI rather than the agent's answer. A provider refusal, a cell
that failed at setup, a cancelled or timed-out cell, or a failure outside the matrix
goes to one run-level issue instead, because none of them is a verdict on a scenario. A
closed issue with the same title is reopened, so a guard that regresses again keeps its
history. Until November there was one issue for everything, and a harness `fetch
failed` landed on a rubric thread and read as more of the same. The logic is
`.github/scripts/regression-alert.sh`; run it with
`DRY_RUN=1 GH_REPO=hookdeck/evals RUN_ID=<run> RUN_URL=<url>` against a past run before
changing it.

**Measured on the first run**, 1 October 2026 ([run 36869979661](https://github.com/hookdeck/evals/actions/runs/36869979661)): eighteen cells,
**seventeen passed**, fifty minutes of wall clock. The cells run one at a time
(`max-parallel: 1`): their jobs summed to 2,881 seconds, about 2.7 minutes per cell, and
prepare, publish and queueing were the other two minutes or so. The "$5 and ten minutes"
that circulated was a planning estimate from before any regression run existed. Cost is
still unmeasured, because the regression export carries no `usage`.

**That run was reported as green and was not.** `regression-filtering-001-regex-capability`
failed for `claude-code-sonnet-5` across both attempts, and the run still concluded
success, because the step that fails a cell on a red check was gated on
`github.event_name == 'schedule'`. "Eighteen cells green" went into a PR body, a commit
message and a workflow comment before anyone read the result files. #103 removed the
gate (#99): the check now keys on the suite alone, so a dispatched regression run fails
the same cells a scheduled one does, and its conclusion means the same on either
trigger. Only the `regression-alert` issue is still opened by the scheduled run alone.

**The committed regression file can now hold a failing scheduled cell, and keeps every
cell.** Until #103, publishing was skipped whenever any matrix job failed. On a scheduled
regression run a red check fails its job, so `regression-eval-results.json` could never
record a failing scheduled cell. Dispatched runs did not fail on a red check, so they
published theirs: `passed: false` rows arrived on 1 October and 2 November. A dispatch with `merge` left at its default also replaced every row with
that run's own (#98). The regression export now always merges. The first full run after
#103, a dispatch on 5 November ([run 42038277214](https://github.com/hookdeck/evals/actions/runs/42038277214)),
published all eighteen rows in `2da24ec`, every one passing on its first attempt. That
includes all six arms of `regression-filtering-001-regex-capability`, which had failed in
every weekly run from 5 October to 2 November. It is one run, so it does not settle the
next paragraph.

**"Every agent passing is the expected state" is still an assumption for one
scenario.** `regression-filtering-001-regex-capability` failed every weekly run from
5 October to 2 November. Those runs' transcripts were never uploaded (#93), so the
causes come from later runs (#92): a local re-run whose failing transcript #94 kept,
and two dispatches on 2 November (runs 41430462176 and 41455801121). Two causes:

- the rubric failed correct answers for the word they opened with, fixed by #95;
- Claude Code without our skills invented a `$regex` filter operator in one of two
  answers, which is the guarded mistake itself, tracked as the product finding #100.

#92 stays open for a third: the rubric does not say how to score an answer that gives a
regex without saying where it runs, so the judge decides, and it has decided both ways.

**A benchmark run is dispatched against a bucket of work, never a date.** Two buckets,
and a run belongs to one of them:

- **Eval changes** — a scenario, a scorer, the base prompt, the CLI pin, a new model or
  experiment. The run measures what the change did to what we measure.
- **Product changes** — a fix, a documentation change or a skill change that this
  benchmark found. The run measures whether it worked, which is the loop closing.

If a proposed run belongs to neither, it is buying data nobody has a decision waiting
on. Paused on 1 October 2026 for exactly that reason: eight product findings were open
and none had shipped, so weekly and monthly matrices were widening a queue nobody was
consuming, at about $185 a month plus $90-110 a matrix. Five weeklies had produced one
harness defect and a lot of variance data about a delta we already know we cannot
measure precisely enough (#2).

The workflow was disabled on 1 October, from about 07:30 until 13:36 UTC, so the monthly matrix
could not fire while the schedule was being changed. It is active again. Disabling is
the way to stop a cron without a commit, and it blocks `workflow_dispatch` too:

```bash
gh workflow disable eval-refresh.yml   # stops the cron and dispatch
gh workflow enable eval-refresh.yml    # both again
```

### Before dispatching a matrix

Run the preflight, with the same inputs the dispatch will take, from a checkout of `main`:

```bash
pnpm preflight --suite benchmark --experiment-suite benchmark,no-skills --runs 3
pnpm preflight --help     # every flag, and the check ids --skip takes
pnpm -s preflight --json  # -s keeps pnpm's banner out of the JSON
```

Every defect v0.5.0 found was discoverable before the run that found it (#131), and
a matrix costs about $100 and six hours. The preflight takes minutes. It is read-only
apart from one real completion per provider, the same request the workflow's own
preflight makes.

- **Assertions fail the script.** Do not dispatch on a non-zero exit. Spend needs
  `--confirm-balance` (or a `y` on a terminal) because no provider exposes a balance
  to a project key. Open `harness` issues need `--accept-harness <numbers>`, so each
  one is accepted for the run by name.
- **Decisions never fail it.** A CLI pin behind `latest` (Hookdeck, skills or an
  agent's), a skills pin behind `main`, a model with a newer sibling, a changed base
  prompt: each prints the current and the latest, and the release notes record what
  was chosen.
- **A moved instrument needs a canary.** When the image definition, a CLI pin or a
  model differs from what the newest published cells of that agent ran under, it
  prints the two-cell `gh workflow run` command with `EVALS_PUBLISH=false`. Per
  agent, not per snapshot: a Claude-only partial publish says nothing about the image
  Codex last ran on. Verify the finished run with `--canary-run <id>` before the
  matrix.
- **`--skip <id>` is an escape hatch, not a pass.** The report prints skipped checks
  as a banner. Name them in the release notes.

It reads `.env` for the provider and project keys, so it checks your keys, not the
repository secrets. It checks those by name only, and the workflow checks their
liveness before its matrix.

## What to work on next

**GitHub Issues is the source of truth for work, and #24 is the order to do it
in.** Before starting anything, read [#24](https://github.com/hookdeck/evals/issues/24):
it is pinned, it carries the reasoning for the sequence, and the
[milestones](https://github.com/hookdeck/evals/milestones) carry what is in each
phase. Picking the top of `gh issue list` instead will usually pick something
that depends on work not done yet.

When you finish something, close its issue or say what changed. Do not keep a to-do list in this file or in the plan: one was kept
here as a per-scenario status table and went stale within a day, because a run
regenerates that information and a markdown file does not.

```
gh issue list                    # what could be picked up
gh issue view <n>                # the detail and any discussion
gh issue list --state closed     # what was already decided, and why
```

**Two labels say who fixes the thing, and they are the first filter on that
list.** `product` is a fact about Hookdeck, its docs or its skills, and the fix
is almost always in another repository. `harness` is ours — runner, scorers,
provisioner, seeds and CI — and can be picked up in this repo. The other labels
— `scenario`, `publishing`, `documentation` — say what an issue is about rather
than who fixes it, so either of the two can carry any of them: #43 is `product`
and `scenario`, because the API fix is elsewhere and the scenario it suggests is
ours.

The label says where the fix goes, not where the finding came from. Most of
these came out of a run, and #43 opens by saying that none did — it came out of
building a demo — and carries `product` anyway, because what a reader filtering
the board wants is the work that is not ours.

The two are otherwise indistinguishable on a board and have opposite next
actions: a `product` issue needs filing elsewhere and then measuring, a `harness`
issue needs a pull request here. `product` was called `finding` until 21
September and carried both. Of the eleven issues it held, five were measurements
of our own instrument rather than of Hookdeck, and three of those moved to
`harness`. That is the same conflation the release notes rule against, where an
open defect in our instrument is neither a product finding nor something
shipped.

**A `product` issue carries an `Owned by:` line at the top of its body**, naming
the repository and the title the issue would take there:

```
**Owned by:** `hookdeck/core` — "Say the project is not an Outpost project instead of returning Not Found"
```

The label says the fix is elsewhere; only that line says where, and working out
where is the expensive half. Name both repositories when a finding splits across
them, as #34 does — documentation in `hookdeck/outpost`, behaviour in
`hookdeck/core`. Where you cannot tell which repository owns it, write that in
the line rather than guessing: an issue filed against the wrong repository is
worse than one not filed. Replace the line with a link once the issue exists.

**Two shapes carry `product` with no `Owned by:` line**, and both have their next
step here rather than elsewhere. A mapping issue is one: its change has already
merged elsewhere and it is waiting on a run to measure it, so it opens with a link
to that change, which is what an `Owned by:` line becomes once the issue exists —
#27 links the merged `hookdeck/agent-skills` pull request in its first line. An
open question about our own skills or docs is the other: it cannot name a
repository until it has an answer, because the answer is what decides whether the
fix is a skill, a docs page or a scenario. Anything else carrying `product` with
no line is drift.

A `product` issue is closed by the release that measures the change, not the one
that ships it — the mapping-issue rule under Releases — so one sitting open after
its fix merged elsewhere is in the correct state.

The division of labour between the three places, so nothing is duplicated:

| | |
|---|---|
| GitHub Issues | what is left to do, and what is in progress |
| #24 and milestones | what order to do it in, and why |
| `.plans/delivery-plan.md` | why the project is shaped the way it is |
| this file | how to work here, and what is expensive to relearn |

**The roadmap carries reasoning, milestones carry contents.** Do not list issues
in #24 and do not put ordering in a markdown file: a list kept in two places goes
stale in one of them, which this repo has already learned twice from
per-scenario status tables.

A finding that changes what someone should do belongs in an issue. A finding
that changes how to work here belongs in Conventions or Traps below. Both, if
it is both.

## Improvement loops

[`LOOPS.md`](LOOPS.md) records what the benchmark found, what was changed because of
it, and whether the change worked. A loop only counts when it closes: a finding, one
attributable change, and a re-run that says what the change bought. A finding without
a re-run is an issue, not a loop.

Two rules that are the whole point of the file:

- **The fix is to the product, the docs or the skills.** Changing a scenario so it
  passes proves nothing, and is the move this file exists to make visible.
- **Record the loops that failed.** A change that did not work is more informative
  than one that did, and omitting them makes the rest less believable.

Re-runs for a loop need at least three attempts. A dispatched run defaults to two,
which is enough to stop one unlucky cell deciding a verdict and not enough to separate
a fix from variance — ask for three.

## Releases

A release is how an improvement is published. It is not a calendar event: cut one
when there is a measured change to report, not on a schedule.

**What justifies one.** The page is release-pinned, so cutting a release is the act of
changing what the public sees — and not cutting one is how a run gets read before it is
believed. Any of these three is enough:

1. **The product moved.** Something shipped that this benchmark found, or a finding
   worth publishing came out of a run. This is the loop working and it is what the
   changelog is for.
2. **The instrument changed what it measures**, and a full run has been measured under
   it. A scenario, a scorer, the base prompt, the sandbox CLI pin. Release so the
   published numbers and the notes describing them agree; until then the page is
   showing numbers measured under something the notes do not describe.
3. **The published snapshot has gone stale** — roughly six weeks, or sooner if the
   instrument has moved under it. Transcripts expire at ninety days (#21), so a
   snapshot nobody released is evidence nobody can check later.

**What does not justify one: a run whose numbers moved.** Movement is the default. The
weak model's skills delta read -1 on 1 September and +4 on 14 September with no change
to the instrument between them, and eleven cells flipped, two of them in both
directions across the arms of the same pair. Releasing on movement publishes variance
and spends the changelog on non-events.

**Package a full matrix, not a partial run.** A run covering four experiments carries
the other two arms forward from whenever they last ran — publishable, but a release
whose notes say "one run" would be wrong. Dispatch all six experiments for anything
that will be released.

**A release represents one run and what changed since the last one.** Tag the results
commit, so the release points at exactly the data it describes, and
`results/runs/<timestamp>.json` is the immutable snapshot behind it.

**It is a GitHub release, not a bare tag.** The website reads the releases API, resolves
the most recent release to its tag, and reads `results/` at that ref — so a tag pushed
without a release publishes nothing, and the page keeps showing the previous snapshot.
Cutting one is a single command against the results commit rather than the branch tip:

```bash
gh release create v0.4.0 --target <results-commit-sha> \
  --title "<verb + subject>" --notes-file <draft>
```

Lightweight tags, created by that command; nothing here needs an annotated tag or a
signature. v0.1.0 and v0.2.0 point at their results commits. **v0.3.0 points at the
merge commit of its release PR**, which happens to carry the same tree and so works,
but it is not what this paragraph asks for — check `git log -1 <tag>` names a publish
commit before announcing anything from it.

The notes carry:

- the run: id, date, and a link to the workflow run
- the results delta against the previous release, per experiment
- the issues closed since it, which is where the external changes appear
- model or scenario additions, called out separately

**The website reads these releases and renders them as a changelog**, so the notes are
public copy rather than internal shorthand. Write them for someone who has not read
the issues.

**Nothing about a release is configured in the website.** Its changelog card takes the
title from the release name and the summary from the first paragraph of the notes.
That was not true until 2 September: three tags had hand-written titles and blurbs
hardcoded in the component, so the page and the releases it linked to disagreed, and a
fourth release would have rendered with no summary at all — see hookdeck/website#789.
If a card ever looks wrong, the fix belongs in the release, not in the site.

The parsed format is three sections of one-line items:

```markdown
## Shipped
- <title> · <where> · #<issue>

## Discovered
- <title> · #<issue>

## Benchmark
- <title> · #<issue>
```

**The title says what happened to what.** A verb and its subject: "Fixed CLI guest
account creation", "Documented no-terminal CLI auth", "Expanded Outpost coverage to
five scenarios". Two failure modes, both made here on 2 September before the third
attempt stuck:

- *Editorial* — "Every number now comes from one run", "The CLI no longer works behind
  your back in a guest project". A headline argues; a changelog entry is scanned.
- *Subject with no verb* — "No-terminal CLI auth", "CLI guest account creation". Names
  the area and leaves out whether it was fixed, documented or found, which is the only
  thing a reader wants from a changelog line.

**It is short**, because the website renders the release name as the heading of its
changelog card: four or five words is the target, and a wrapped title is the symptom
of a long one.

**It says what the release actually did.** A release note is read by someone building
on Hookdeck, so a product fix or a product finding is the headline when there is one.
When the release is work on the instrument — v0.4.0, "Fixed how results are scored and
published" — title it as that. Promoting a finding to the headline of a release that
fixed nothing invites the reader to look for a fix that is not there, and titling
instrument work as though it were a product change is the same mistake pointing the
other way.

**The first paragraph is the summary the page renders.** The website takes whole
sentences from it up to 120 characters and shows them under the title, so it has to
read as a lede on its own — not a scene-setting sentence that only works with the rest
of the paragraph behind it. Both halves of the card come from the release; nothing
about a release is configured in the website.

**Write the notes with the `hookdeck-voice` skill loaded.** They are public,
Hookdeck-branded content that a blog post or changelog entry links to, and they were
written three times without it. American English, no hype vocabulary, specific over
generic, honest about maturity.

**In that order: Shipped, Discovered, Benchmark.** What a reader has a stake in comes
first — what changed for them, then what we found out about the product — and the
repairs to our own instrument come last. The website does not group by section, so
this is the order of the release page itself, which is where anyone following a link
from a blog post or a changelog entry arrives.

`Shipped` is a change to the product, the docs or the skills. `Benchmark` is a repair
to our own instrument, and only ones that have shipped. `Discovered` is a **product**
finding — something true of Hookdeck, its docs or its skills that we do not yet
understand or have not yet fixed. The page renders Shipped and Discovered and counts only
those; Benchmark stays in the notes as the record.

**An open defect in our own instrument goes in neither.** It is not a product finding, so
it is not Discovered, and it has not shipped, so it is not Benchmark. It lives in an issue
until it is fixed, and appears in the release that fixes it. A reader of the changelog
has no stake in our harness being broken; they have every stake in knowing what we found
about the product. Mixing the two inflates the findings count with our own bugs — the
same reason Benchmark items are excluded from the counters. Anything outside those three headings is preamble and is not an item, which is
how the run summary and the delta stay out of the changelog.

**The changelog is about the product, not about the benchmark.** Its subject is what
changed for someone building on Hookdeck with an agent: what the runs found, what we
fixed, and what an agent can now do that it could not before. The benchmark's own
machinery — a scorer we corrected, a harness we repaired — is how we know, not what we
are reporting. It belongs in the `Benchmark` section, which the page does not render,
and in issues.

This is easy to get wrong, because the benchmark's own defects are often the most
interesting thing that happened that week to the people running it. They are not the
most interesting thing to a reader deciding whether their agent can configure a
Hookdeck integration.

**So the release title names the product improvement.** It renders beside the version,
which already says where the release sits in the sequence, so the title has that space
to say what an agent or a developer can now do. Two failure modes:

- *Categories.* "Corrections", "maintenance", "first packaged run" are true of many
  releases and say nothing about this one.
- *Instrument news.* "Eight of twenty published failures were our own scoring" is a
  striking sentence about our benchmark and tells a reader nothing about Hookdeck.

Test: could this sit unchanged on a different release, and does it name something that
changed about the product? If a release genuinely shipped no product change, say what it
unblocks rather than dressing up the housekeeping.

**A release title names what changed. An item title names what happened to a
reader.** They are different jobs, and the rules below are for items, which is
easy to miss when writing the line at the top.

**Make the delta visible.** A changelog is a list of changes, so a title that
states a standing condition leaves a reader unable to tell whether it is new,
whether we broke it, or whether we merely noticed it. *"The operator events API
is undocumented"* could be any of the three. The strongest fix is to say what
was done, verb first and in the past tense:

- Added the operator events API to the OpenAPI definition
- Fixed the environment variable names on the operator events docs page
- Changed the Outpost API to return 401 rather than 404 for a key from another
  project
- Added four Outpost scenarios

Naming the previous state works too, and is often sharper: *"returns 401, not
404"* tells a developer exactly what moved without any framing word. *"Outpost
coverage goes from one scenario to five"* carries both ends.

This does not contradict "state the observed behaviour, not the work" above.
That rule is against vague project-tracking — *"Track the CLI agent-safety
work"* — not against naming a change actively. "Added X to Y" is specific and
checkable; "improved Outpost documentation" is not.

**Prefer the artefact over the capability it implies.** "Added `hookdeck ci` to
the skill" cannot overstate itself. *"Agents can now authenticate the CLI
without a terminal"* is more readable and asserts an outcome that release had
not measured — no run had yet shown agents doing better. Use the capability
framing only when a run demonstrated it, and cite the run.

Three v0.3.0 titles were rejected before the plain one, each failing
differently: *"Turning on alerts for a stalled customer needs an API you cannot
find"* was opaque and built the release on one of four findings; *"Five Outpost
scenarios, four documentation gaps"* was accurate and read as generated, because
symmetry and counting are a tell; *"Agents can use Outpost. Working out how is
the hard part."* was a conclusion rather than a change. Editorialising is a
third failure mode alongside categories and instrument news.

**Product coverage is a change worth naming; benchmark plumbing is not.** The
rule that the changelog is about the product does not put coverage off limits —
which products we can say anything about is a fact a reader has a stake in,
where a repaired scorer is not. When a release ships no product change, coverage
growth is usually the honest headline, and reaching past it for a cleverer angle
produced all three rejected drafts above.

**Terminology: the OpenAPI *Specification* is the standard; the file is a
definition.** "Added it to the spec" is wrong in the same way "the Event Gateway
API" was wrong for `api.hookdeck.com`, which carries platform and Event Gateway
functionality while Outpost has its own subdomain. Precision here is cheap and
the alternative is a reader correcting us.

**The title is the whole entry, so it has to carry the finding alone.** No description
is rendered. A reader sees one line and an issue number, and decides from that line
whether to click. Rules, in order of how often they are broken:

1. **State the observed behaviour, not the work.** "The CLI created a guest account
   instead of using your credentials", not "Track the CLI agent-safety work". An issue
   title names a task for us; a changelog title names a thing that happened to them.
2. **Write it from the reader's side.** What would a developer have noticed? They did
   not lose a scenario, they lost their configuration into a project they could not
   see.
3. **No internal shorthand.** No scenario ids, no experiment names, no `-no-skills`,
   no "BM6". These mean nothing outside this repository.
4. **One line, and no trailing detail.** If it needs a clause explaining the
   consequence, the consequence is usually the title.
5. **Past tense for Shipped, present for Discovered.** Shipped describes something
   that was true and is not any more; Discovered describes something still true.

Issue titles and changelog titles are different artefacts, and a good issue title is
often a poor changelog title. Rewrite rather than paste.

**Every change made elsewhere in response to an eval needs an issue here.** A skills
PR, a CLI fix, a documentation change: each gets an issue in this repository. It is the
only mechanism that lets a release describe a private documentation change without
linking to anything private, and it is what keeps the changelog honest about cause
rather than listing whatever happened to land.

**A mapping issue is closed by the release that measures the change, not the one that
ships it.** Those are usually different releases and often far apart. A skills change
merges upstream and reaches no run until the submodule pin moves; a documentation change
alters what an agent reads only once a run reads it. Closing on merge marks as done
something nobody has measured, which is Loop 1's mistake wearing different clothes: there
the change was real, shipped, and bought nothing the benchmark could detect.

So the shipping release *references* the mapping issue and says the effect is not yet
measured. The measuring release closes it, and carries the delta. An issue sitting open
between the two is the correct state and is the only visible record that a shipped change
is still unproven.

**Adding a model or a scenario changes the denominator.** Totals either side of such a
release are not comparable, and the notes have to say so rather than showing a delta
that reads as improvement. The same applies to a sandbox CLI bump, which changes the
product under test.

**A run can be told not to publish.** Set the repository variable
`EVALS_PUBLISH` to `false` and a dispatched matrix still runs and still uploads
its artifacts, while `results/` is left alone:

```bash
gh variable set EVALS_PUBLISH --body false    # hold publishing
gh variable delete EVALS_PUBLISH              # resume
```

Use it whenever `main` carries something you already know is wrong — a scorer
mid-repair, a scenario whose seed is being rewritten, a harness fix reviewed but
unmerged. On 24 August the cron fired against a `main` whose prompt addendum was
still omitting a credential, and was cancelled by hand at 47 of 72 cells,
minutes ahead of publishing twelve failures that were ours rather than the
agents'. That required somebody to be watching, and it was luck that anybody
was.

**A held run is still worth running.** The artifacts carry the transcripts, and
transcripts are where the findings come from — the scoreboard has never produced
one. Holding publication is not the same as skipping the week.

**A partly failed run still publishes; a cancelled one never does.** One errored
cell used to skip the publish job outright, and on 21 September 75 of 76 completed
cells went unpublished (#80). The export now checks what came back against every
pair the run was asked for, names each missing cell in the job summary along with
whatever stands in for it — a carried row and its date under `--merge`, or nothing —
and refuses if more than a tenth of the cells are missing. Past that floor something
systematic happened and somebody should read it first. If publishing is still right,
raise the floor and re-run **only** the publish job; "Re-run failed jobs" would re-run
the failed matrix cells too, and pay for them again:

```bash
gh variable set EVALS_MAX_MISSING_FRACTION --body 0.25   # then re-run publish-results
gh variable delete EVALS_MAX_MISSING_FRACTION            # back to 0.1
```

A credit, quota or auth failure cancels the run on purpose, and a cancelled run
publishes nothing whatever the floor says. The failing job uploads a
`provider-refused-*` marker before it cancels, and the publish job refuses on any
marker, so a cancel that did not take still publishes nothing. The regression export always merges,
whatever the `merge` input says, so a one-cell dispatch cannot replace the record
with one row (#98).

## Plans

`.plans/` holds the planning documents. Start with
[`.plans/delivery-plan.md`](.plans/delivery-plan.md): phases with entry and exit
criteria, the decisions and their reasoning, cost and cadence, and what is still
open.

[`.plans/scenario-difficulty-research.md`](.plans/scenario-difficulty-research.md)
compares our scenarios and metric with other vendor and research benchmarks, and
classifies every scenario by what makes it hard. Read it before hardening,
retiring or proposing a scenario, and before changing what the page publishes.

The plan is the source of truth for *what we are doing and why*. This file is
the source of truth for *how to work here*. When they disagree, the plan wins on
direction and this file wins on mechanics.

Everything in this repository is published; it has been public since 13 August.
Keep it that way: no internal repository paths, no customer names or figures, no
unannounced product plans. Anything failing that test belongs in a private note
elsewhere.

What this benchmark costs to run is explicitly *not* in that category and is
recorded above. It is a fact about this project rather than about the business,
it is what cadence decisions rest on, and leaving it out meant it was re-derived
badly more than once: the judge was at one point reported as costing thirty
times its real price because a figure was inferred from a residual rather than
measured.

## Setup

```
cp .env.example .env     # then fill it in
pnpm install
docker info              # a daemon must be running
pnpm eval -- --dry --suite regression
```

Run through `pnpm eval`. It is the only entry point that loads `.env` (via
`node --env-file`); calling `harness/run-eval.ts` with `tsx` directly starts
with an empty environment and every experiment is skipped for a missing key,
which reads like a configuration problem rather than a wrong command.

`.env` is the only env file read here, loaded explicitly by `pnpm eval` through
`node --env-file`. A `.env.local` is read by nothing; if one exists, it is a
leftover, and a second copy of a credential is worse than none because the one
you edit is not the one in use.

`HOOKDECK_API_KEY` is a project key for a dedicated `evals-ci` project, in an
organisation with no production data. `HOOKDECK_WEBHOOK_SECRET` is that
project's signing secret from the dashboard, not available on the API, and
scenarios that score a handler cannot pass without it. `OPENAI_API_KEY` is
needed by the default LLM judge, so any judged scenario needs it whichever agent
produced the run.

Runs bill per token. A local Claude Code subscription does not cover them: the
agent runs inside a container, which needs an API key the same way CI does.

## Conventions

**Every product finding this benchmark has produced came from a transcript.
None came from the scoreboard.** Two days of Outpost runs produced four: an API
answering `404` where `401` was meant, a skill that never names the credential,
a docs page whose environment variables do not exist, and a harness omission of
our own that failed twelve baseline cells and read as a skills result. A pass
rate cannot express any of them. It cannot even separate "the agent could not"
from "we misled it" — which is the difference between a to-do for the product
and a bug in our instrument.

So the scoreboard says *which* cells to read and never *what happened*. Run

```bash
pnpm --filter @hookdeck-evals/framework triage
```

after a run. It reads what the harness already records and flags the cells where
the number is not the whole story: an unclean exit (a killed container arrives
with a plausible partial score, and one was written as a `2/6` agent failure), a
run that failed while its own report claims success (nine of twelve baselines in
one run, every one of them confidently building on the wrong product), a
declared credential the agent never referenced, a skill offered and never
opened, a baseline that self-installed a product skill, a cell whose only
green checks are the ones an idle agent satisfies, and a cell whose agent could
not find the pinned CLI or ran a different one (69 of the 76 Codex cells in run
42044644850).

Nothing flagged is not the same as nothing to learn. It means no cell tripped a
signal the script knows about, and the signals it knows about are the ones that
have already cost us something.

**When a scorer disagrees with an agent, read the agent's report first.** It has
been the cheapest answer every time and it keeps getting skipped. It named the
credential it could not fetch, and the variable name it looked for
(`HOOKDECK_WEBHOOK_SECRET`, which was better than the one we had invented). It
showed the exact `hookdeck listen` invocation that works headless, including the
`--output compact` the scorer was missing. Treat the report as evidence, not
commentary.

**A scorer must own every process it depends on.** Start what it needs, stop
what it does not. An agent that verifies its own work leaves servers and tunnels
running, on its own ports, writing to its own logs, and Hookdeck will deliver to
that session instead of the scorer's. Failing a scenario because the agent was
thorough is the worst thing a scorer can reward.

**Put diagnostics in the check notes, not in a file in the sandbox.** The
container is destroyed after scoring, so "see /tmp/x.log" is a dead end by the
time anyone reads the failure. Tailing that log into the notes turned a run per
guess into a five-minute diagnosis.

**Send what the real thing sends.** Every BM1 failure across seven runs was a
scorer probing with something no real client would send, then recording a
correct handler as broken. Sign as the provider *and* as Hookdeck, because a
real delivery carries both. Include `data.object`, because every Stripe event
has one. Supply the secrets the developer in the scenario would already hold.
Seed the workspace they would already have. If a probe is not something the
provider would actually put on the wire, the scenario is measuring the probe.

**Build the smallest scenario that exercises a mechanism, before the one that
uses it.** BM6 isolates local delivery; BM1 bundles it with provider setup and
handler code. BM6 found the workspace-seeding bug, the process-conflict bug and
the TTY crash in four runs and about $2. BM1 had been failing on the first of
those for four runs and about $10, and could not say which of its parts was
broken. When a scenario fails in a way that could be any of three subsystems,
the cheapest next move is a scenario that only has one of them.

**Signal comes from the agent being wrong about its own claim, not from task
difficulty.** Three attempts at finding a lever failed: stage, then correlation
versus single-lookup, then silent versus loud failure. Sorting every result by
whether it produced signal gives the real line. The scenarios that discriminate
are the ones where the agent produced something and was wrong about it: a source
configured with the wrong secret, a tunnel pointed at a guest session, a
capability answered from memory. The scenarios that produce nothing are the ones
where all the evidence is present and the task is to read it: which destination
is failing, whether a connection is paused, which orders a filter excludes.
Agents are excellent at the second and unreliable at the first. Write scenarios
where an agent can finish confidently and be wrong.

**Difficulty discriminates, not stage.** Investigate and resolve looked like the
answer because supabase's hardest scenarios are mostly investigate. Ours are
investigate and resolve and every configuration passes them, including the weak
model that fails two build scenarios. Their hard ones need several signals held
together (one has "correlation" in its name); ours need one lookup each. Write
for correlation, make a plausible wrong answer available, and prefer a silent
failure to an error: every scenario that has discriminated so far failed quietly.

**A scenario joins the benchmark once something has failed it, not before.**
CONTRIBUTING.md has asked for this since before the first scenario existed and
nothing checked it, so five scenarios reached the published suite with no agent
ever having failed them — four of them written from an argument about what users
probably do rather than from a case where somebody got it wrong.

```bash
pnpm --filter @hookdeck-evals/framework scenario-criteria
```

reports both rules — citation and observed failure — plus what the suite covers
by product and stage. Run it before proposing a scenario. A scenario nothing
fails is still publishable as a floor; what is not defensible is finding out
afterwards.

**Test the floor before concluding a scenario carries no signal.** All three
build scenarios pass on every Sonnet 5 configuration, which read as no signal
until `codex-gpt-5.4-mini-no-skills` failed two of them. Flat at the top of the
range and discriminating below it is a floor, and a floor is worth publishing.
supabase/evals is the same shape: twelve of their nineteen scenarios are passed
by every agent.

**`pnpm -r build` and `pnpm typecheck` are not the same check.** The build
passed while `typecheck` reported a real error in `packages/hookdeck`, because
they cover different project references. Run both before claiming green; CI now
runs both, plus tests, which it did not until this was found.

**Probe a scorer's own queries against a real project before trusting a red
result.** This has bitten most times a scorer has gone red: source verification config is redacted on
read, so it cannot be inspected; `/events` omits the payload unless you pass
`include=data`; destination create takes `type` plus `config.url`. Each time the
agent was right and the scorer was wrong, and each time it looked like an agent
failure until someone read the transcript. A scorer that finds nothing is more
likely broken than proof that nothing happened.

**The platform source answers questions the spec cannot.** The OpenAPI spec
gives shapes; it does not say what a provider's signature header must look
like, or what happens when a CLI destination has no session. Both were settled
by reading the Event Gateway implementation: the per-provider HMAC config
(algorithm, header key, encoding, whether the timestamp prefixes the body) and
the ingestion path that ignores a request with cause `CLI_DISCONNECTED`. If you
have access to it, read it before asserting product behaviour in a scenario or
a finding. If you do not, say what you could not verify rather than inferring
it from the spec, which has been wrong here more than once.

**Verify API shapes against the live spec, then against a real call.**
`reference/hookdeck-openapi.json` is fetched from the live API; refresh it with
the command in `reference/README.md`. Do not use `hookdeck/hookdeck-api-schema`,
which was last updated in December 2024 and describes shapes that no longer
exist. Two mismatches were found while building the provisioner, and both only
surfaced at runtime: destination create takes `type` plus `config.url` rather
than a top-level `url`, and pause/unpause are `PUT`.

**Score behaviour, not configuration, where the API allows it.** Hookdeck
redacts source `config.auth` on read, so a scorer cannot inspect the algorithm
or encoding an agent chose. Signing a request and checking it is accepted is
both possible and better: it passes an agent that reached a correct setup by an
unanticipated route, and fails config that looks right but rejects real traffic.

**An example list in a skill is read as an exhaustive list.** Measured: the
event-gateway skill described source types as "Provider presets (Stripe,
Shopify, GitHub, etc.)" and the API has 151. A weak model with that skill
concluded ElevenLabs was unsupported, built a generic `WEBHOOK` source with
hand-rolled verification, and scored worse than the same model with no skill at
all. Naming the count and giving a way to list them took it from zero mentions
of `ELEVENLABS` to thirty-three. An agent has no other source for where a
boundary is, so a skill that is illustrative where it needs to be complete is
not neutral, it is harmful.

**An agent can install skills itself, and a baseline that does is not a
baseline.** The sandbox has network access because scenarios need the
documentation, and the skills registry is on that network. `skills.selfInstalled`
on a result records what the agent fetched. Read it by repo: a product skill
(`hookdeck`, `event-gateway`) pulled into a `-no-skills` run invalidates that run
as a baseline and should be excluded from the delta; a provider skill
(`stripe-webhooks`) is legitimate, because documenting a third party's signature
format was never Hookdeck's job and we maintain those skills for exactly this.
Do not block the network to prevent it: the docs need it, and a baseline that
cannot reach the internet is unrealistic in the other direction.

**Skills are the axis; the CLI and the API are the baseline.** Every experiment
gets the pinned Hookdeck CLI (baked into the sandbox image) and a live
`HOOKDECK_API_KEY`, so a scoreboard row differs from its neighbour by skills and
nothing else. The MCP server is not a launch row: it ships inside the CLI and is
read-only, eleven analysis tools that cannot create or mutate, so it should lift
investigate and resolve while leaving build flat. Measure it on the investigate
and resolve scenarios and publish that as a finding about the product. The
baseline is named `-no-skills` rather than docs-only for that reason: it still
has the CLI and a key.

**A residual is not a measurement.** The judge was reported as costing $2.85 a
pass and $74 a month, and that drove a decision to move off upstream's model.
The figure came from subtracting identifiable runs from one day's invoice and
attributing the remainder to judging. A per-model usage export put the real cost
at roughly two pence a call: $0.93 for every judge call ever made, ten pence per
fourteen-scenario pass. Wrong by about twenty-eight times, and the decision was
reverted. When an unexplained remainder lands on whatever is currently under
discussion, that is a hypothesis, not a number.

**The judge model is upstream's `gpt-5.5` and should stay there without a strong
reason.** `scripts/replay-judge.ts` re-judges stored transcripts with a
different model and compares verdicts, so the question is answerable for pennies
whenever it comes up again. `gpt-5.4-mini` agreed on 15 of 15 including both
real catches, so a switch is safe; it is just not worth making, because these
checks are mostly negatives guarding against invented capabilities and the
saving is trivial.

**The base prompt is a treatment, not neutral scaffolding.** It is the one string
every cell in every experiment shares, so a word added to it moves every number
at once and is indistinguishable in a snapshot from the thing being measured.
Change it the way a scenario or a CLI pin is changed: deliberately, in its own
commit, and with the release saying results either side are not comparable.

It carries **"Do not ask clarifying questions. Complete the task with the
information provided."** since 27 August, borrowed verbatim from
[clerk/clerk-evals](https://github.com/clerk/clerk-evals) — the closest
architectural match to this benchmark, running the same two agent CLIs, which
prepends that line to every eval prompt on its agentic path.

The reason is that this benchmark is single-turn. A question gets no reply and
the agent is scored on whatever state it left, usually nothing. Four cells in the
stored runs ended that way, against a skills delta of two cells in twenty-four:
the artefact was larger than the signal beside it.

**An agent that stops to ask is not failing at anything, and must never be
published as a capability failure.** τ-bench's airline policy *requires* an agent
to "list the action details and obtain explicit user confirmation (yes) to
proceed" before any action that updates the booking database. The behaviour this
prompt suppresses is a pass requirement there, because that harness has a user to
answer and ours does not. `triage` keeps flagging it (`ASKED_AND_STOPPED`) for
exactly this reason: the instruction removes the confound, and the detector says
whether it worked. Nobody else in the survey does both — Clerk instructs without
measuring, upstream does neither. See hookdeck/evals#57 for the five answers four
other benchmarks give.

**Measured, same day, on the four cells that had tripped the detector: it went to
zero.** Three now pass. The fourth (`verification-002` on the weak model) made 68
tool calls, stopped cleanly, scored 3/5 and failed on the handler-side signature
checks — a capability failure on its merits rather than an agent waiting for a
person. About $3 to find out.

Read that as one measurement and not four: the detector going 4→0 is what the
instruction targets and is the direct result, while the three flips to passing are
consistent with it and are *not* evidence of it. These were failing cells re-run
once with no control arm, and a failing cell that is re-run can flip on its own.
Claiming the instruction bought three scenarios would be the same mistake as the
9–0 skills result in Loop 2, at a smaller scale.

**Prefer more attempts to more instruction.** `--runs 3` stops at the first pass,
so it costs about 1.11× and it removes a stopped run's power to decide a cell
without touching the prompt at all. It is the cheapest correction available and
should be reached for before anything is added to the base prompt.

A scenario that knows its own outcome varies can say so, with `min_attempts` in
its frontmatter. It is a floor on `--runs` for that scenario alone, capped at
five, and with stop-on-pass it is paid for only on the cells that were already
failing. `outpost-003` carries `min_attempts: 3`: across three full passes it
was stable for both frontier models on all six of their observations and split
2-1 for the weak model in both arms, because passing turns on which undocumented
route the agent happens to guess. Use it where variance is measured rather than
suspected, and remember what it buys — the published number becomes best-of-N,
which the row's `attempts` field states rather than hides. What cannot be
copied is the other route: Convex avoids clarifying questions by writing prompts
as requirement lists, and this repo has measured that adding an instruction to
build *suppresses the very failure a scenario exists to catch*. This paragraph
used to name Vercel alongside Convex. It was wrong: Vercel's current Next.js eval
prompts are one-to-three-sentence task statements (checked on 9 November against
`agent-031`, `agent-038` and `agent-048`).

**The published score is scenarios completed, and checks are evidence rather
than a score.** One row is one scenario — a ticket an agent was given — and its
`passed` is the AND of every check in it. That is what the harness records, what
`results/latest.json` publishes, what a release quotes and what the website
prints. Upstream is the same: supabase/evals computes `passed / results.length`
and never aggregates checks into a number.

Decided against the alternative on 29 August, after the website briefly shipped
check-level percentages to give partial credit for partial work. The idea is
reasonable and it does not survive contact with scorers that short-circuit:
**a scorer stops as soon as there is nothing left to check, so a run that fails
at the first hurdle returns `0/1` where a near-miss returns `4/5`.** Failing
worse becomes cheaper than failing partially, and each agent's denominator ends
up set by its own failures — 59, 62 and 65 checks across six arms of the same
nineteen scenarios. On the 25 August snapshot it put the deliberately weaker
model at 97% against a frontier agent's 95%, where by scenarios they tie at 89%,
and the page ranked them in that order. Check counts also become weights: they
run from one to five per scenario, set by how each scorer happens to be written.

Two things follow for scorer authors. A check list is **not** comparable between
runs of the same scenario, so never compute a rate from it or compare its length
across cells. And an early return is still the right shape — a scorer that
cannot find a tenant has nothing to say about delivery — so the fix is at the
consumer, not here.

**Classify what gates a scenario, and read failures along it.** Every scenario
carries `gated_by` in its frontmatter: `discovery`, `judgement` or `mixed`. The
test is one question — **if we improved our docs and skills, could this cell go
from red to green?** If yes it is `discovery` and a failure is a to-do for us.
If the agent had everything it needed and chose badly, acting more broadly than
asked or stopping short, it is `judgement`: no documentation change moves it, so
it measures the model rather than the product.

This matters because the two are otherwise the same red square with opposite
implications, and `passed` is the AND of every check — so "could not configure a
queue" and "configured it and broke something else" are indistinguishable in a
snapshot. Reporting them as one number invites reading model carefulness as a
documentation win, or the reverse.

```bash
pnpm --filter @hookdeck-evals/framework report-results
```

splits a snapshot along it, and prints the failing check names for `mixed`
scenarios, where the label alone cannot say which half failed. Run it before
deciding what to work on from a set of results: on the 78/90 snapshot every one
of the twelve failures was discovery-gated, which is a different instruction
from the same twelve split evenly.

Prefer `discovery` when writing new scenarios. A `judgement` scenario is still
worth publishing as a floor — carefulness on multi-part tickets is a real fact
about running agents — but it will never move for anything we ship, so a suite
made of them measures models and calls it a product benchmark.

**Prefer deterministic checks.** Across supabase/evals, 69 of 91 checks are
deterministic and 22 are judged. A scenario that is entirely judged is a design
smell.

**Give a judge one narrow fact, inline.** State the single thing the scenario
turns on, in the scorer that uses it. Do not build a shared document of product
facts: it duplicates the docs, goes stale silently, and makes the judge the
arbiter of truth instead of whether the thing works.

**A negative check draws its line at observability, not at confidence.** BM7's
first version failed an agent for reporting that a destination pointed at a mock
endpoint rigged to reject, which was the root cause and was sitting in the
destination URL the API returns. Anything derivable from project state is
observation however specific it sounds; invention is asserting something that
appears nowhere in that state. Write the rubric as a list of things not present,
not as a feeling about how certain the agent sounded.

**Write hallucination checks as pure negatives.** "Fail only if it offers a
regex filter operator", and pass in every other case, including an unfinished
task. A check that reads "pass if it does the task *and* invents nothing" fails
an agent that invented nothing, which makes the signal unreadable.

**A scenario guarding a hallucination asks the question and nothing else.**
Prompt phrasing decides whether the failure appears at all. Measured on the two
filtering scenarios, which differ by one clause: asked the capability question
alone, Claude Code answered in 40 seconds with zero tool calls and offered a
regex. Add "set the filtering up" and it reads three or four docs pages and
answers correctly. An instruction to build gives the agent a reason to look
things up that the original ticket never had, so adding one to a regression
scenario suppresses the very failure it exists to catch. Ask for work in a
benchmark scenario; keep a regression scenario to the question.

**Put the context an agent needs in the seed, not the prompt.** A scenario with
no seeded state gives a good agent nothing to discover, so it asks a clarifying
question and scores zero for behaving correctly.

**Motivations are published.** Cite the evidence without naming the support
tool, a customer, or an internal ticket. Internal context belongs in
a comment in `EVAL.ts`.

**The results web app is Hookdeck-branded but structurally upstream's.** The
wordmark, copy, fonts, brand tokens and hostname check were retargeted on 12
August; the layout, components and design are still supabase/evals' and the
attribution comments in `index.css` record that. `CHANGES.md` has the detail.

## Traps

**Seeding a scenario: two things worth knowing before writing one.**
`local/` files support `${VAR}` placeholders, expanded from the run environment
on the way into the sandbox, so a workspace can carry a credential the agent
cannot fetch (`HOOKDECK_WEBHOOK_SECRET` lives in the dashboard, not the API)
without committing it. An unset variable is left as written rather than blanked,
so a missing credential reads as missing instead of as an empty string that
looks configured. And `https://mock.hookdeck.com?status=<code>` returns that
status on any path, which is how a scenario seeds failing deliveries: point a
destination at `.../collect?status=422` and every attempt to it fails while
another destination succeeds.

**Ingestion is synchronous, delivery is not.** A POST to a source URL returns
when ingestion accepts it; the event is then queued and delivered by a worker.
Anything that depends on an event having *been delivered* has to wait for it,
not for the POST. This produced a self-healing scenario: `resolve-002` seeds
failing deliveries, repairs the endpoint in an `after` block, and asks the agent
to redeliver, but the repair landed before the first attempt on some events, so
they succeeded and there was nothing left to redeliver. `applySeed` now waits for
seeded events to leave `QUEUED`/`SCHEDULED` before running `after`. The retry
rules in that seed do not help: `count: 0` gates reattempts, and this is the
first attempt.

**Identify a bad population by its cause, not by what its rows look like.**
When the Codex CLI died mid-run on 13 August, twenty-two runs were scored
without the agent doing anything. Picking the rows to re-run by fingerprint,
zero docs calls and every check failed, missed four of them: `resolve-002`
carries a negative check ("the inventory events were left alone") which
*passes* when an agent does nothing, so a dead row showed one of two checks
green and read as genuine. The row was looked at directly and the passing
check was taken as evidence the agent had worked; it was evidence of the
opposite. Cross-referencing job start times against the outage window gave the
exact set in one query. A fingerprint describes symptoms and any scenario with
a negative check breaks it; the outage window is the cause and cannot.

**Regression scenarios passing is correct.** They guard against a mistake
already seen and fixed; all agents passing is the desired state. For benchmark
scenarios the opposite holds: at least one agent must fail, or there is no
signal.

**One project means one run at a time.** Source and destination names must be
unique within a project, so two concurrent runs that both name a source `stripe`
collide. Do not try to serialise via a GitHub Actions
concurrency group: a group holds one running and one pending job and cancels the
rest. Shard instead.

**Outpost tenants are only reset on release.** `FixedProjectSource` snapshots
and restores the Hookdeck project, and Outpost has no snapshot to restore from.
Tenants and destinations an Outpost run creates survive into the next one, so
the second run of a scenario finds `acme` already there and may score a previous
run's work. `FixedProjectSource` now deletes tenants that were not present when
it acquired the lease, on release — but that runs in a `catch`-and-ignore, so a
run that dies before release still leaks and the next run inherits it.

**The Outpost project has an Event Gateway side, and agents write to it.**
`OUTPOST_API_KEY` is an ordinary project key, so it works on `api.hookdeck.com`
and the CLI too. A source, two connections, two destinations and two issue
triggers were left there on 24 and 25 August and nothing removed them. On 5
November an `outpost-005` attempt added a body `$nin` filter to one of those
connections instead of changing the Outpost destination's topics. The filter
carried into the cell's next two attempts, because nothing reset that side.
`FixedProjectSource` now deletes every gateway resource in the Outpost project
on every acquire, for every scenario, before the seed, and again on release. It
refuses if the Outpost key can see anything in the gateway project's snapshot
or live state, because that means both keys reach one project. So `OUTPOST_API_KEY` must
belong to a dedicated project, and a gateway API error on that key now fails
the acquire of every cell, Event Gateway scenarios included.

So cleanup on release is not enough on its own, and `applyOutpostSeed` deletes
each tenant it is about to create. That makes seeding idempotent without
depending on the previous run having exited cleanly, which is what the leftover
tenant actually broke: tenant create is idempotent on the id and destination
create is not, so seeding onto a survivor *appended* a second destination rather
than replacing the first. The scenario then started with two, one carrying the
seeded history and one empty, and a scorer reading `[0]` got whichever sorted
first. Scorers should still aggregate across a tenant's destinations rather than
taking the first, because an agent may legitimately add one.

**Outpost seeds must wait for delivery before mutating, and the wait needs its
own reason.** Publishing is synchronous and delivery is not, so an `after` block
lands while the events are still queued — the same trap `applySeed` fixes for the
gateway. On Outpost it is worse than a slow start: `outpost-002` disables a
destination in `after`, a disabled destination is never attempted, so the failed
attempts the whole scenario is built on were never created. It presented as a
seed that worked, because an earlier run's tenant had survived and had been
delivering while it sat there. `applyOutpostSeed` now waits for published events
to be attempted, any status, before running `after`.

**Outpost event history outlives the tenant.** Deleting and recreating `acme`
leaves every event it ever received in place: a freshly recreated tenant listed
38 events against the 3 that run had published. They stay bound to destinations
that no longer exist, so retrying one answers `404 "event not found"` rather than
anything explanatory. Filter by `destination_id` — and note that attempts are
naturally run-scoped only because the destination is new each run, which is a
property to rely on deliberately rather than by accident.

**The hosted Outpost API is not shaped like its tenant-scoped routes suggest.**
`/events`, `/attempts` and `/retry` are **top-level**, filtered by query
parameter, while destinations are under `/tenants/{id}/`. Guessing
`/tenants/{id}/events` returns a 404 whose body is an HTML page, which reads like
a broken deployment rather than a wrong path — about an hour went into probing
route shapes that were never going to exist. The spec is
`docs/apis/openapi.yaml` in `hookdeck/outpost`; the API host serves no
`openapi.json`, so fetch it from the repository.

**Read the Outpost prose docs before asserting a feature is absent.** They are
published at <https://hookdeck.com/docs/outpost> and live as `.mdoc` under
`docs/content/` in `hookdeck/outpost`. The OpenAPI spec describes shapes, not
behaviour, and a whole feature can be documented without appearing in it: this
scenario was written claiming a disabled destination produces no notification,
which was wrong — `alert.destination.disabled` is a documented **operator
event**, and it was missed by searching the spec and `internal/alert/` when the
answer was in `internal/opevents/`. It came within one step of being published
as a product finding. Being publicly documented cuts the other way too: the
sandbox has network access, so an agent can read these pages and a scenario may
fairly depend on them.

**Retry against a disabled destination returns `400 "Destination is disabled"`.**
Verified against the live API, and it is the mechanism `outpost-002` rests on:
re-enabling and retrying are ordered by the product, not by the scenario. Worth
knowing before writing any scenario that assumes held events can be recovered.

**A session is closed with `close()`, not `Symbol.asyncDispose`.** The session
object does not implement the disposable protocol, so
`session[Symbol.asyncDispose]?.()` is an optional call on `undefined`: it
type-checks, runs clean, and releases nothing. `score-only` did exactly that
from the day it was written, so every iteration kept its lease — no reset to
pristine, no Outpost tenant cleanup, no config restore. It stayed invisible
because the *next* acquire resets the Hookdeck project anyway, so the only
damage was to state that acquire does not cover. It surfaced when a scenario
that clears the project's operator event destinations left them cleared for
good. If a throwaway script needs a session, close it the same way.

**The operator events API is real, and in no published spec.**
`/operator-events/destinations` (list, create, get, update, delete, enable,
disable), `/operator-events/destination-types`, `/operator-events/events`,
`/operator-events/attempts` and `/operator-events/retry`, on the Outpost API
host with the Outpost key. None of it is in Hookdeck's OpenAPI, in Outpost's
`docs/apis/openapi.yaml`, or in the rendered reference at
`/docs/outpost/api` — see hookdeck/evals#34. Two traps in one: a `GET` on a
project that has never had a destination answers `404 "tenant not found"`,
because the backing tenant is created lazily on first create, so an empty
resource is easily read as a missing route; and `PATCH /config` rejects
`OPERATOR_EVENTS_TOPICS` with a 422 saying it is owned by those destinations,
which is the only pointer the product gives that the resource exists.

**The shared project carries real operator event destinations.** It is
long-lived, and at the time of writing had one subscribed to `*`. A scenario
about configuring alerting has to start from none, so `clearOperatorEventDestinations`
deletes them and `FixedProjectSource` puts them back on release. Recreating
changes the signing secret — there is no way to supply it — so a restored
destination is equivalent in configuration but not identical. Acceptable on a
dedicated eval project, and worth knowing before pointing any of this at one
that is not.

**Outpost validates a destination's shape, not its reachability.** A
well-formed but entirely fictional SQS queue and key pair is accepted;
`queue_url: "not-a-url"` is rejected with `422 "config.queue_url failed pattern
validation"`. That is what makes `outpost-004` scoreable without a live queue:
the API itself covers the part real infrastructure would add least to, and
standing up a real queue would mean cloud credentials inside the agent sandbox
and an external dependency that can fail a run for reasons no agent caused.
Delivery is already proven against webhook destinations elsewhere.

**Destination credentials are redacted on read** — `AKIA****************` — so a
scorer can assert that credentials were supplied and never which ones. Same
limitation as Hookdeck source `config.auth`. Presence is still worth checking:
an agent thinking in webhook shapes puts the access key in `config` beside the
queue URL and leaves `credentials` empty.

**Reset is to pristine, not to empty.** A new Hookdeck project ships with
default issue triggers. The first acquire snapshots what the project contains,
and every reset deletes only what a run added.

**Except issue triggers, which are declared, not captured.** A new project gets
exactly four — delivery, transformation, backpressure, request — and
`DEFAULT_ISSUE_TRIGGERS` lists them by content, read from the Event Gateway
implementation. Every reset keeps the oldest trigger of each type and rewrites it
to that content, creates any that are missing, and deletes every other trigger.

A captured snapshot of ids failed on these both ways round, and both happened to
the delivery default that `alerting-001` is built around (#28, #117). A run
rewrote it on 7 August before the snapshot was taken, so the rewrite was kept as
pristine; it was deleted by hand on 19 August as an orphan, and an id-based reset
never recreates anything, so the scenario then ran with no delivery trigger at
all. In CI it is worse, because each fresh checkout takes a new snapshot and so
adopts whatever the last job left.

**Those defaults email the whole team, so reset mutes them.** Each default
trigger carries `email: {}`, which names no recipients, and an email channel
without `member_emails` goes to every member of the organization who has not
turned alerts off, whenever the project's notification methods include email.
`member_emails` can narrow it, and an empty list sends to nobody, but that is a
recipient list a scorer has to read rather than an absent channel (see the
`alerting-001` scorer). Scenarios fail deliveries,
requests and transformations on purpose, so from at least 21 August every run
emailed the people on `evals-ci` about failures we had caused, and it surfaced
on 6 November only because they said so. The declared defaults carry
`channels: {}`, and `muteIssueTriggerNotifications` sets the same on every
trigger after each reset, which matters on release, where the reset is best
effort and can stop partway.

What to know before touching it:

- **It changes what `alerting-001` starts from.** No scorer reads issues, and
  the agent's own work is never reset before it is scored: acquire resets before
  the agent runs, release after scoring. But the agent now finds an enabled,
  wildcard delivery trigger at `channels: {}` — configured and silent, which is
  the failure that scenario exists to catch. It cannot be passed by confirming
  the trigger, and an agent copying its neighbours' shape fails the channel
  check. That is an instrument change, so results either side of it are not
  comparable for that scenario, and the next release notes say so.
- **The cleaner switch is out of reach.** Email is only sent when the project's
  notification methods include it, and turning that off would leave the
  triggers looking like a customer's. It is writable only with a dashboard
  session, not a project API key, so the harness cannot set it on a project it
  creates.
- **A failed mute warns rather than throws**, because an email is a nuisance
  and a failed run is lost spend.
- **A new project starts noisy.** Anything that creates or hands out a project
  must call `muteIssueTriggerNotifications` before the first run, and the
  `ProjectSource` interface says so. If anyone creates an eval project by hand,
  mute it the same way, or the first run emails the team.
- **A failed trigger reset fails the acquire**, like the rest of the reset.
  Nothing has been paid for yet, and `alerting-001` started without its default
  would score as though it were valid.

The Outpost project's gateway side is reset to empty, and that follows the same
rule: pristine there *is* empty. Platform project creation gives an Outpost project no issue
triggers, and no seed creates gateway resources in it. So that baseline is
declared in code (`OUTPOST_GATEWAY_PRISTINE`), not captured. A captured one
would come from whatever the last CI job left, because every job is a fresh
checkout, and it would have recorded the August leftovers as pristine.

**Never sleep for ingestion, poll for it.** Every scorer that sends something
and reads it back used a fixed `setTimeout`, 8 or 12 seconds. Ingestion is
asynchronous, so when the platform is slower than the sleep the scorer reads too
early and records a correct agent as broken. It presents as a scenario failing a
*different* cell every run, because which cell loses depends on when its job
happened to run: `verification-001` failed three different cells across three
runs before this was found, and each looked like a model failure. Use `waitFor`
or `waitForOrLast` from `@hookdeck-evals/hookdeck`. Polling costs nothing when
the platform is quick and buys a far longer ceiling when it is not.

**A new kind of wait is a product finding before it is a harness change.** Three
times now the benchmark has needed a new way to wait, and each time the reason
was that Hookdeck offers no signal for the thing being waited on: no signal that
a request has been processed, and none that a rule is in force. The second is
worse than absent — `GET /connections` returns the rule while the ingest path is
still admitting traffic it should reject, so the API answers a question adjacent
to the one being asked without distinguishing them (#25).

If a scorer cannot tell whether a filter is working, neither can a customer's
integration test, nor an agent checking its own work. We only noticed because we
run it hundreds of times. So when you reach for a new wait, open an issue for the
missing signal first, then write the wait.

**Three waits, and they are not interchangeable.** `waitFor` and
`waitForSettled` assume the condition is *monotonic* — once true it stays true —
which holds for ingestion, because an event that exists does not stop existing.
It does not hold for rule enforcement, which alternates while it propagates: a
request at +2.5s was filtered and a later one at +4.5s was not. For anything
non-monotonic use `waitForConsistent`, which requires the condition to hold
across several consecutive observations. A single correct answer is exactly the
observation that misleads.

**`waitForConsistent` reduces that risk rather than removing it.** Where the
thing being observed is served by more than one node, consecutive agreeing
observations only cover the nodes those observations reached. It is the best
check available without a readiness signal, and it is not a guarantee — so when
a scenario built on one starts failing intermittently, suspect the wait before
suspecting the scorer.

**Do not poll for a positive when a negative shares the read.** Four scenarios
assert that one thing routed *and* another did not: a filter passes the matching
order and drops the legacy one, a deduplicate rule admits the first payment and
suppresses the second. Returning the moment the positive lands reads the
negative before it has had any chance to arrive, so a rule that does nothing at
all scores as a pass. That is worse than the sleep it replaces, which was at
least even-handed. Use `waitForSettled`: the positive arriving starts a settle
window rather than ending the wait, and the value returned is the last one seen,
so anything landing during that window is counted. Reserve plain `waitFor` for
reads where every assertion points the same way.

**A flaky-looking scenario is not all flake.** The two failures that exposed the
sleep above had different causes: one was the race, the other was an agent
inventing an `x-hookdeck-webhook-secret` header and comparing hashes of the
secret itself, which is not Hookdeck's scheme, so the handler correctly rejected
a correctly signed probe. Same symptom, opposite conclusions. Read each failure
before generalising from a pair.

**Scope scorer queries to `ctx.acquiredAt`.** Events and requests cannot be
deleted through the API, so a shared project accumulates history, and a scorer
that just asks "did an event arrive?" will eventually say yes because of an
earlier run.

**Codex runs most commands in a login shell, and a login shell rebuilds PATH.**
In release run 42044644850, 2,233 of Codex's 2,456 shell commands were
`/bin/bash -lc '…'`; the rest were `bash -c`. A login shell runs Debian's
`/etc/profile`, which replaces whatever PATH the harness passed in with a fixed
list. Claude Code runs `bash -c` and inherits it. Of the Codex attempts in that
run that invoked the pinned `hookdeck`, 26/26, 18/22, 16/16 and 19/19 across
the four arms met `command not found`, and the four that did not had run it
only through `bash -c`. The agents carried on by absolute path, by `npx`, by an
unpinned `npx -y hookdeck-cli@latest`, or through the REST API — all of it
scored as though both agents had the same baseline. So anything an agent needs
on PATH has to be on it for both kinds of shell: the image sets it in `ENV` and
again in `/etc/profile.d/`, and `toolchain-check.ts` errors a cell before it
starts if either shell does not resolve the pinned version. A missing or wrong
CLI is treated in CI like a provider refusal: it leaves a `sandbox-broken`
marker that `publish-results` refuses on and cancels the run, because every
job builds the same image. A probe that times out or hits a dead container is
retried once and then errors only its own cell. Setting `PATH` on
`docker exec` alone is not enough.

**Credentials reach the agent through `EvalSession.sandboxEnv`.** The session is
created before the sandbox because the sandbox needs the lease. Disposal runs in
reverse, so the container is torn down before the project is released.

**`export-results` refuses to write anything containing a credential.** An agent
echoed its project key into a transcript on the first real run. Raw results are
gitignored and the export carries no transcripts today, but the guard is there
for when per-run drill-down is added.

**Redacting what the harness injected is not redacting every credential.** The
sandbox can create credentials of its own: `hookdeck ci` mints a CLI key and
writes it to `~/.config/hookdeck/config.toml`, and an agent checking its setup
reasonably `cat`s that file. No env var holds that key, and it has no prefix to
match. So the harness reads the CLI's config files out of each sandbox before
teardown and redacts the values of their credential keys
(`harness/sandbox-credentials.ts`). `redact.ts` also finds any value of 16 or
more characters, containing a letter and a digit, that is assigned to a
credential-marking name (`api_key = '…'`, `"webhook_secret_key": "…"`,
`--webhook-secret …`), and then redacts that value everywhere it appears in
the artifact. `check-artifacts` re-applies those passes before the raw
artifacts are uploaded. If anything is left, the job fails and both uploads
are skipped. The cell's score is unchanged but is not published either:
`publish-results` reads rows from those artifacts, so the cell counts as
missing, and an earlier row stands in only where the missing-cell floor allows
(#103). A new place the sandbox writes a credential needs adding to the
discovery command; a new artifact writer needs to go through
`serializeRedacted`.

## Attribution

This repo is based on [supabase/evals](https://github.com/supabase/evals),
Apache-2.0. The first commit is their tree verbatim; the second removes the
Supabase runtime. Keep `LICENSE` and `NOTICE` intact and record changes in
`CHANGES.md`.
