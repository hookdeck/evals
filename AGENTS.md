# Working in this repo

`README.md` covers what the project is and how a run works. This file covers
current status, where the plan lives, and the conventions and traps worth
knowing before you change anything.

## Status

Phase 0 (framework spike) and Phase 1 (the project provisioner) are done.
Phase 2 is underway and parts of Phase 3 landed early.

**Scenarios: nine.** Three regression, six benchmark.

| Suite | Stage | Scenario | Where it stands |
|---|---|---|---|
| regression | build | filtering-001-regex-capability | Fails Claude Code, passes Codex. The June 2026 incident reproduced |
| regression | build | verification-001-generic-hmac | Passes both |
| regression | investigate | limits-001-oversized-payload | Passes both |
| benchmark | build | filtering-001-enterprise-orders | Passes everything run against it |
| benchmark | build | verification-001-stripe-express | Passes Sonnet 5 both arms; fails GPT-5.4-mini 4/5 |
| benchmark | build | localdev-001-listen-locally | Passes Sonnet 5 both arms; fails GPT-5.4-mini |
| benchmark | investigate | investigate-001-failing-deliveries | Passes every configuration including GPT-5.4-mini. No signal |
| benchmark | resolve | resolve-001-paused-connection | Passes every configuration including GPT-5.4-mini. No signal. Fully deterministic |
| benchmark | investigate | investigate-002-partial-outage | Correlation-shaped. Passes Claude Code 3/3; weak model pending |

**Experiments: five.** `claude-code-sonnet-5` and `codex-gpt-5.6` with
`['hookdeck', 'event-gateway']`, `-no-skills` twins of each, and
`codex-gpt-5.4-mini-no-skills` as a deliberately weaker model.

**What the numbers say so far.** Skills changed no outcome on either build
scenario and cost 39% and 56% more. The build scenarios are flat across the
frontier and discriminating below it, so they are a floor rather than dead
weight. The only scenario that splits two frontier agents is a regression one,
and it asks a capability question rather than for work. On this evidence agents
build with Hookdeck from documentation alone and fail when stating what it
cannot do, which is not the headline the proposal assumed. See the plan.

**Three product findings, all from runs rather than speculation**, and all about
`hookdeck listen`: it crashes without a TTY unless given `--output compact`; a
CLI destination with no connected session has its requests ignored with cause
`CLI_DISCONNECTED` rather than queued, so nothing retries; and it falls back to
an unauthenticated guest Console session even with `HOOKDECK_API_KEY` in the
environment, which let a weaker model report success while bypassing the project
entirely. The plan has the detail.

CI runs formatting and unit tests on pull requests. `eval-refresh` is manual
dispatch only, with `HOOKDECK_API_KEY`, `HOOKDECK_WEBHOOK_SECRET`,
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` set as repository secrets, so a
dispatch will spend. It has completed end to end including publishing, and the
regression suite scored identically in CI and locally. No schedule is wired:
that arrives with the scoreboard.

Nothing is published. Both results files are empty, and the results web app is
still Supabase's shell (see Traps).

**Next:** BM9, the scoped bulk retry, which needs a harness change first. Its
scenario is "the endpoint is fixed now, redeliver the failed events from the
last hour, but only for the checkout source", so events have to fail *before*
the endpoint is repaired. `applySeed` runs every resource and its `then` steps,
then all events, with no way to change state afterwards. A top-level `after`
block of requests applied post-events, with `$ref:` resolution in the path,
would unlock this and any other scenario where state changes after history
exists.

Also unrun: BM7 and BM8 against `-no-skills` and the weak model, which is what
tells us whether the investigate and resolve scenarios discriminate or are
another floor.

## Plans

`.plans/` holds the planning documents. Start with
[`.plans/delivery-plan.md`](.plans/delivery-plan.md): phases with entry and exit
criteria, the decisions and their reasoning, cost and cadence, and what is still
open.

The plan is the source of truth for *what we are doing and why*. This file is
the source of truth for *how to work here*. When they disagree, the plan wins on
direction and this file wins on mechanics.

Everything in `.plans/` is published. Keep it that way: no internal repository
paths, no customer or business figures, no unannounced product plans. Anything
failing that test belongs in a private note elsewhere.

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

**Probe a scorer's own queries against a real project before trusting a red
result.** This has bitten most times a scorer has gone red: source verification config is redacted on
read, so it cannot be inspected; `/events` omits the payload unless you pass
`include=data`; destination create takes `type` plus `config.url`. Each time the
agent was right and the scorer was wrong, and each time it looked like an agent
failure until someone read the transcript. A scorer that finds nothing is more
likely broken than proof that nothing happened.

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

**The results web app is still Supabase's, apart from the data.** It carries
their logo, a "Back to Supabase" header, a "with a Supabase project" footer, a
hero reading "across Supabase", and a `supabase.com` hostname check that decides
the base path. `CHANGES.md` records the app as retained unchanged, which is
true and easy to read as harmless; it is not, because the app is the published
artefact. `JOURNEY_STAGES` has been retargeted because it is part of the data
model and a stale `deploy` stage advertised a column no scenario can ever fill.
The rest is Phase 3 work and has to happen before anything is shown to anyone,
including before the page is designed: mocking a UI from the current app copies
Supabase's branding and prose.

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

**Regression scenarios passing is correct.** They guard against a mistake
already seen and fixed; all agents passing is the desired state. For benchmark
scenarios the opposite holds: at least one agent must fail, or there is no
signal.

**One project means one run at a time.** Source and destination names must be
unique within a project, so two concurrent runs that both name a source `stripe`
collide. Do not try to serialise via a GitHub Actions
concurrency group: a group holds one running and one pending job and cancels the
rest. Shard instead.

**Reset is to pristine, not to empty.** A new Hookdeck project ships with
default issue triggers. The first acquire snapshots what the project contains,
and every reset deletes only what a run added.

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

This repo is a copy of [supabase/evals](https://github.com/supabase/evals),
Apache-2.0. The first commit is their tree verbatim; the second removes the
Supabase runtime. Keep `LICENSE` and `NOTICE` intact and record changes in
`CHANGES.md`.
