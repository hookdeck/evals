# Working in this repo

`README.md` is for people: what this project is, why it exists, how to run it,
and how to consume the published results. This file is for whoever is changing
the code, human or agent: current status, what things cost, and the conventions
and traps that were expensive to learn. If a fact is only useful while editing
this repo, it belongs here; if it is useful to someone reading about the
benchmark, it belongs in the README.

## Status

Phases 0 and 1 are done. Phases 2 and 3 are substantially done: eighteen
scenarios exist, fifteen benchmark and three regression, and every benchmark
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

**What the numbers say.** Eight of fifteen scenarios discriminate, which is a
healthy benchmark rather than a flat one. The frontier agents pass nearly
everything; the weak model is where most failures live, which is the floor
working as intended.

The skills axis is the interesting result and it is not uniform. Claude gains
one scenario from skills, GPT-5.6 nets zero, and the weak model is **three
worse with skills than without**, losing four scenarios it otherwise passes.
That direction is a finding about our documentation rather than about the
model, and there is a known mechanism: a skill that lists example values is read
as an exhaustive list, which once led a weak model to conclude a supported
provider was unsupported. Do not report the skills delta as a single number; it
has a different sign at different capability levels.

**Product findings come from runs, not speculation.** Several concern
`hookdeck listen`: it crashes without a TTY unless given `--output compact`; a
CLI destination with no connected session has its requests ignored with cause
`CLI_DISCONNECTED` rather than queued, so nothing retries; and it falls back to
an unauthenticated guest Console session even with `HOOKDECK_API_KEY` set, which
let a weaker model report success while bypassing the project entirely. The plan
has the detail.

**The repository is public**, as of 13 August. Results are published to
`results/` as a contract, and `raw-results-*` artifacts keep transcripts, tool
calls and agent reports for 90 days. Those artifacts are the only record of
*why* an agent did something; a published row cannot tell you.

CI runs formatting, typecheck, unit tests and build on pull requests. It ran
only formatting until 12 August, and two defects reached main that any of the
others would have caught.

`eval-refresh` runs weekly (Monday 06:00 UTC, frontier agents plus the weak
pair) and monthly (1st, 08:00 UTC, adding the `-no-skills` twins for a full
matrix), plus manual dispatch. Check `gh secret list` against the workflow env
rather than trusting any list written here: `OUTPOST_API_KEY` was documented as
a secret before it existed, and the first full matrix run scored `outpost-001`
as six agent failures because of it.

## What this costs, and what it has cost

Runs bill per token and the numbers matter, because cadence is chosen against
them and the choice is otherwise re-derived from scratch every time.

Measured per full pass of fifteen scenarios:

| | |
|---|---|
| `claude-code-sonnet-5` | about $20 |
| `codex-gpt-5.6` (resolves to `gpt-5.6-sol`) | about $7 |
| `codex-gpt-5.4-mini` | about $4 |
| LLM judge (`gpt-5.5`) | about $0.10 |
| Full matrix, six experiments | about $64 |

Weekly frontier plus weak pair is roughly $185 a month. Everything weekly would
be $279 against a $200 budget, and the `-no-skills` twins are what gets cut to
monthly, because their delta moves slowly.

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

Re-runs for a loop need at least three attempts. The weekly cadence runs one and
cannot separate a fix from variance.

## Releases

A release is how an improvement is published. It is not a calendar event: cut one
when there is a measured change to report, not on a schedule.

**A release represents one run and what changed since the last one.** Tag the results
commit, so the release points at exactly the data it describes, and
`results/runs/<timestamp>.json` is the immutable snapshot behind it.

The notes carry:

- the run: id, date, and a link to the workflow run
- the results delta against the previous release, per experiment
- the issues closed since it, which is where the external changes appear
- model or scenario additions, called out separately

**The website reads these releases and renders them as a changelog**, so the notes are
public copy rather than internal shorthand. Write them for someone who has not read
the issues.

The parsed format is three sections of one-line items:

```markdown
## Shipped
- <title> · <where> · #<issue>

## Benchmark
- <title> · #<issue>

## Discovered
- <title> · #<issue>
```

`Shipped` is a change to the product, the docs or the skills. `Benchmark` is a repair
to our own instrument. `Discovered` is found but not yet explained. The page renders
Shipped and Discovered and counts only those; Benchmark stays in the notes as the
record. Anything outside those three headings is preamble and is not an item, which is
how the run summary and the delta stay out of the changelog.

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
PR, a CLI fix, a documentation change: each gets an issue in this repository that the
release closes. This is the only mechanism that lets a release describe a private
documentation change without linking to anything private, and it is what keeps the
changelog honest about cause rather than listing whatever happened to land.

**Adding a model or a scenario changes the denominator.** Totals either side of such a
release are not comparable, and the notes have to say so rather than showing a delta
that reads as improvement. The same applies to a sandbox CLI bump, which changes the
product under test.

## Plans

`.plans/` holds the planning documents. Start with
[`.plans/delivery-plan.md`](.plans/delivery-plan.md): phases with entry and exit
criteria, the decisions and their reasoning, cost and cadence, and what is still
open.

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

**Outpost state is not reset between runs.** `FixedProjectSource` snapshots and
restores the Hookdeck project, and knows nothing about Outpost. Tenants and
destinations an Outpost run creates survive into the next one, so the second run
of a scenario finds `acme` already there and may score a previous run's work.
`FixedProjectSource` now deletes tenants that were not present when it acquired
the lease, on release. The residual: a run that dies before release still
leaks, and the next run inherits it.
Until it is, treat Outpost results after the first run of a scenario as
unreliable, and delete tenants by hand between runs.

**Reset is to pristine, not to empty.** A new Hookdeck project ships with
default issue triggers. The first acquire snapshots what the project contains,
and every reset deletes only what a run added.

**Never sleep for ingestion, poll for it.** Every scorer that sends something
and reads it back used a fixed `setTimeout`, 8 or 12 seconds. Ingestion is
asynchronous, so when the platform is slower than the sleep the scorer reads too
early and records a correct agent as broken. It presents as a scenario failing a
*different* cell every run, because which cell loses depends on when its job
happened to run: `verification-001` failed three different cells across three
runs before this was found, and each looked like a model failure. Use `waitFor`
or `waitForOrLast` from `@hookdeck-evals/hookdeck`. Polling costs nothing when
the platform is quick and buys a far longer ceiling when it is not.

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

**Credentials reach the agent through `EvalSession.sandboxEnv`.** The session is
created before the sandbox because the sandbox needs the lease. Disposal runs in
reverse, so the container is torn down before the project is released.

**`export-results` refuses to write anything containing a credential.** An agent
echoed its project key into a transcript on the first real run. Raw results are
gitignored and the export carries no transcripts today, but the guard is there
for when per-run drill-down is added.

## Attribution

This repo is based on [supabase/evals](https://github.com/supabase/evals),
Apache-2.0. The first commit is their tree verbatim; the second removes the
Supabase runtime. Keep `LICENSE` and `NOTICE` intact and record changes in
`CHANGES.md`.
