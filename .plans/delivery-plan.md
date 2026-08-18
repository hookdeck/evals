# Hookdeck Evals: delivery plan

**Owner:** Phil
**Status:** Phases 0 to 3 substantially delivered; first improvement loop open
**Date:** 5 August 2026, last reviewed 14 August 2026
**Builds on:** [Hookdeck Evals proposal v2](https://app.notion.com/p/3b1783a05de281e19b68f6f77e8e9b65) (3 August 2026)
**Repo:** https://github.com/hookdeck/evals

> **This file is the source of truth for the plan**, and it is published. It carries no
> internal repository paths, no customer or business figures, and no unannounced product
> plans. Keep it that way when editing; anything failing that test belongs in a private
> note elsewhere. `AGENTS.md` covers how to work in this repo, and points here for what
> we are doing and why.

The proposal answers what and why. This answers how we ship it. Claims about existing
code are verified against the repos unless marked otherwise. Where this plan diverges
from the proposal, the divergences are listed at the end.

## The sequence

| Phase | What | Days | Blocks on |
|---|---|---|---|
| 0 | Reuse spike, throwaway branch | 1 | Nobody |
| 1 | Project provisioner (fixed project + wipe, behind a swappable interface) | 2 | Nobody |
| 2 | v0: repo, 3 regression + 4 build scenarios, 2 experiments, run manually | 6 | Phase 0, 1 |
| 3 | v1: remaining 8 benchmark scenarios, +MCP, CI, weekly schedule, results export | 8 | Phase 2 |
| 4 | First improvement loop (fix, re-run, capture before/after) | 3 | Phase 3 |
| 5 | Launch | Product marketing | Phase 4 |

Roughly 20 working days of Phil's time to launch-ready, plus the page and launch blog
running in parallel from the end of Phase 3.

**Status 18 Aug: phases 0 to 3 delivered. Phase 4 is live and has produced one closed
loop, a negative one.** Eighteen scenarios (fifteen benchmark, three regression), six
experiments, a public repository publishing to `results/` weekly and monthly, and the
first release ([v0.1.0](https://github.com/hookdeck/evals/releases/tag/v0.1.0)) packaging
a run. The scoreboard is open as a pull request on the website, green, carrying the
results table, the three counters and a changelog read from releases.

Loop 1 closed with **no measurable improvement**: the CLI defect was real and shipped in
2.5.0, but a control run showed the four failures used to justify it were variance. See
`LOOPS.md`. That is the most useful thing this project has produced so far, because it
invalidates every single-attempt conclusion drawn before 14 August.

What Phase 4 exposed, in order of how much it changes the work:

- **Measurement was not trustworthy.** All ten scored scenarios slept for a fixed 8-12
  seconds against asynchronous ingestion, so a slow platform failed a correct agent and a
  different cell lost each run. Converted to polling; not yet validated, because
  validating it needs a correct configuration to score against and nothing builds one.
- **The judge samples at default temperature**, so judge-backed checks disagree with
  themselves on identical input. A second variance source, independent of the first, and
  one no amount of polling fixes.
- **Live credentials reached public artifacts.** Agents run `env` while exploring and the
  dump was captured in transcripts we upload from a public repository. Redaction shipped;
  rotation is outstanding.

`score-only` was added so a scorer change can be checked for about the price of some API
calls rather than the $50-64 a matrix costs. It is also the answer to the pattern this
phase kept hitting: reaching for an expensive run to answer a question a cheaper method
could settle.

**Do not read scenario-by-scenario state from this file or from `AGENTS.md`.** Both
carried such a table and both went stale within a day. `results/latest.json` is
authoritative, and GitHub Issues carries what is left to do.

**The aided delta is not zero, and it is not one number.** This section previously
recorded it as zero on the evidence then available. The first clean full matrix, on
13 August, measures it as **+1 for Claude Sonnet 5, 0 for GPT-5.6, and -3 for
GPT-5.4-mini**, which loses four scenarios with our skills that it passes without
them. A skills delta reported as a single figure hides a sign change, and the negative
one is a finding about our documentation rather than about the model. Tracked as an
issue.

For scale, supabase/evals' own published results show +3, +1, +1, 0 and -1 across five
agents, so a mixed and occasionally negative delta is not anomalous. What is new is
that ours is negative *specifically on the weakest model*, which points at a mechanism
rather than at noise.

**Investigate and resolve moved up and are now the thin part.** They were scheduled
last because they are hardest to seed. They now hold two scenarios each against
eleven for build, so a single flip moves a published stage score by fifty points.
Tracked as an issue.

Still open: `evals-local`, and the org-key questions for the platform team. The
concurrency one has a number behind it: ninety pairs take about six hours serialised
on one project.

**What launch now waits on**, which is a different list from the one this plan started
with. None of it is scenario authoring:

1. rotate the leaked credentials (#20) — the only item with a security clock on it
2. merge the website pull request, which closes #15, #17 and #18
3. validate the polling conversion (#14), which needs a per-scenario known-good
   configuration so the correct-config path can be scored at no agent cost
4. set the judge to temperature 0 (#22)
5. cut the second release, which is the first one able to carry a measured delta (#13)

Phase 5 is product marketing's and is not blocked by any of it.

---

## What we build on

The harness is based on [supabase/evals](https://github.com/supabase/evals) with the
Supabase runtime removed and a Hookdeck project provisioner in its place. Measured
against the repo, here is what that means concretely.

| Bucket | Lines | What |
|---|---|---|
| Take near-verbatim | 11,327 | Agent runners + transcript parsers (2,771), core misc: eval metadata, markdown, docs-results, skill-results (1,963), generic slice of `core/index.ts`: judge, aiSdkAgent, defineExperiment, MCP plumbing, transcript serialization (553), parsers + transcript types (352), Docker sandbox + skills install + bare sandbox (742), suite runner + CLI args + results export (1,276), results web app (3,670) |
| Leave behind | 19,403 | platform-lite (16,085), `sandbox/supabase.ts` + `local-stack-runtime.ts` + `agent-environment.ts` (1,171), Supabase slice of `core/index.ts`: platformLiteRuntime, bootPlatformBackend, edge-function compilation, executor MCP, LocalStack types (1,076), framework demos + smoke + project-runner (1,071) |
| Write ourselves | 6,902 equivalent | Scenarios and experiment configs, which were always going to be ours (theirs: 39 scenarios at 6,515 lines, 18 experiment configs at 387) |

The two pieces that justify the copy are the **agent runners and transcript parsers**
(Claude Code, Codex, opencode: 2,771 lines) and the **container sandbox** (742 lines).
The outpost harness has neither; it is Claude-only and runs host-side. Everything
else we take is convenience.

**Keep the Docker sandbox.** Every CLI agent runs inside a container:
`run-eval.ts:511` calls `createBareSandbox({skills})`, which builds a `DockerSandbox`,
and Claude Code, Codex, and opencode all set `runsInSandbox`.
`packages/sandbox/src/docker-sandbox.ts` is 475 lines of generic container plumbing
with six Supabase mentions, all in comments. What comes out of that package is
`supabase.ts` (620 lines, boots their local stack) and most of
`local-stack-runtime.ts` (456 lines).

**The seam we build against is `EvalRuntime`** (`core/src/index.ts:757`), four lines:
`startSession()` returns `{mcpServers, promptAddendum, scoringContext, close}`.
`platformLiteRuntime()` implements it in 84 lines; `hookdeckRuntime()` implements the
same interface. One piece of shared code changes: `ToolScoringContext` (`:256`) is
typed with `SupabaseClient` and `ManagementApiClient` and gets retyped with a Hookdeck
client. That single retype is why we take a copy rather than a fork (Q7).

---

## Phase 0: the reuse spike

One day, on a throwaway local branch of a `supabase/evals` clone. Create the GitHub
repo after it passes, not before.

> **Status, 7 August 2026: SPIKE PASSED and the repo now exists.** Steps 1, 2 and 3
> pass; step 4 not run and low risk. **Q2 decided: copy supabase/evals.** The spike
> branch has been moved into this repo following Q7, with the upstream import as the
> first commit. See Spike results below, including one correction to Phase 1.

**What it must determine, in order:**

1. Does the monorepo build after removing `packages/platform-lite`,
   `packages/sandbox/src/supabase.ts`, and
   `packages/sandbox/src/local-stack-runtime.ts`, and cutting the resulting imports?
   (`pnpm install`, typecheck, `pnpm test`.)
2. Can a `hookdeckRuntime()` implementing `EvalRuntime` drop in where
   `platformLiteRuntime()` was, without editing the tools-mode branch of
   `run-eval.ts`?
3. Can Claude Code inside `DockerSandbox` reach `api.hookdeck.com` and run
   `hookdeck ci --api-key $HOOKDECK_API_KEY`? Their sandbox uses bridge networking to
   reach host-side platform-lite; we need plain outbound internet and a CLI install in
   the image.
4. Does `export-results.ts` emit a JSON file the web app renders with our dimensions
   (stage, product, topic, suite)?

**Pass:** one scenario ("create a Hookdeck source named X and a connection to Y") runs
under two experiments (docs-only, +skills) on Claude Code, scored by querying a real
Hookdeck project, exported, and rendered locally. Log wall-clock and the reported
`total_cost_usd` for both runs; that is the first real input to the cost model.

**If it fails, here is what each failure means:**

| Failure | Response |
|---|---|
| A. Monorepo will not build without platform-lite | Import-graph problem, almost certainly a `core/index.ts` split. Timebox two more hours. Does not change the decision. |
| B. DockerSandbox will not run, or the container cannot reach the Hookdeck API | Changes the decision. Extend the outpost harness instead, lifting in `core/src/agents/**` (2,771 lines of runners and parsers); it runs agents host-side with no container. Then rebuild the suite runner, results export, and web app, about 5,200 lines. Add 5 days. |
| C. `EvalRuntime` is not a clean seam (scorers or the runner reach into Supabase types that cannot be swapped) | Same response as B. Reading the code suggests this is unlikely: `ToolScoringContext` is one interface, spread into the scorer at a single call site (`run-eval.ts:543`). |
| D. Cost per run more than 3x the outpost median | Not a spike failure. Feed it into the cadence numbers. |

Only B and C change the approach. Ugly code, missing tests, and Supabase-specific
naming are cosmetic.

**Fold the framework survey into failure branch B.** The proposal has a Harbor and
alternatives survey as a parallel workstream gating the framework choice. If the spike
passes, the survey has nothing to decide. If it fails, spend half a day comparing
Harbor against extending the outpost harness before committing.

### Spike results (7 August 2026)

**Step 1, does it build without the Supabase runtime: pass.** After removing
`packages/platform-lite`, `sandbox/supabase.ts`, `sandbox/local-stack-runtime.ts`, the
local-stack branch of `run-eval.ts`, the framework demo scripts, and all
`evals/`/`experiments/`: 62,533 lines deleted, 179 added, 8,685 lines of non-test
source surviving. `pnpm typecheck` passes on framework and web. Tests: **core 103/103,
sandbox 18/18, web 68/71.** The three web failures assert the committed results file
is non-empty, which it will be after the first real run.

**Step 2, is `EvalRuntime` a clean seam: pass, and this is the important one.**
`ToolScoringContext` was retyped from `{mgmt, ref, client, getClient, query,
invokeFunction}` (Supabase Management API plus a supabase-js client) to `{projectId,
acquiredAt, api}`. **Nothing downstream needed changing.** The runner spreads the
context into the scorer at a single call site and never looks inside it, exactly as the
plan assumed. Failure branch C is closed.

**Step 3, container, connectivity, and the full provisioner loop: pass, 8/8.** The
sandbox image builds with the Hookdeck CLI baked in (pinned to 2.3.1, alongside skills
1.5.11), both resolve on the `PATH` the harness injects, and from inside the container
`api.hookdeck.com` returns 401 unauthenticated in 0.19s and `hookdeck.com/docs` returns
200. **Failure branch B is closed.**

`spike-step3.mjs` then ran the whole provisioner loop against the real `evals-ci`
project, all eight checks passing: scorer-side auth, `hookdeck ci --api-key`
authenticating inside the container, wipe-to-pristine, seed (source + destination +
connection), scorer read-back, `created_at` scoping, and teardown. The project was
verified back to pristine afterwards. Two details worth carrying forward: the API takes
`Authorization: Bearer <key>`, and a created source returns its delivery URL
(`https://hkdk.events/<id>`) on the create response, so seeding does not need a second
call to find where to POST events.

**Step 4** (results export rendering in the web app) is the only step not run. Low
risk: the export script and the app are both taken near-verbatim and their own tests
pass; it needs a real results file, which arrives with the first scenario run.

### Correction: the eval project is not empty, and must not be wiped to empty

The plan asserted an invariant that "the eval project contains nothing permanent". That
is false, and it matters.

A new Hookdeck project ships with **four default issue triggers** (`delivery`,
`request`, `transformation`, `backpressure`), all wildcard-scoped, created in the same
millisecond as the project. Verified on `evals-ci`.

Wipe-to-empty would delete them, with two consequences:

1. **It changes what BM4 tests.** BM4 is "tell me when deliveries to my endpoint keep
   failing", verified against issue trigger config. A real user's project already has a
   wildcard `delivery` trigger with `strategy: first_attempt`, so the realistic task is
   to recognise or modify it. In a wiped project the agent must create one from
   scratch. Those are different tasks and the wiped one is the unrealistic one.
2. **It is irreversible drift.** After the first wipe the project never returns to
   default, so run 1 and run 2 are no longer testing the same thing.

**`FixedProjectSource.acquire()` must restore to pristine, not to empty.** Snapshot the
project's resource IDs once on first acquire, persist that snapshot, and delete only
what a run added. `spike-step3.mjs` implements this (`.spike-pristine.json`) and it is
the behaviour Phase 1 should carry.

This generalises beyond issue triggers: treat "pristine" as whatever the project
contains before the harness first touches it, so any future default resource type is
protected automatically. It also removes the reason the plan preferred wipe-to-empty
over scoped deletion, so revisit that choice in Phase 1: wipe-to-pristine still
self-heals after a crashed run, because the snapshot is the reference point rather than
a per-run timestamp.

Three corrections to the "what we build on" table, all in our favour:

1. **`local-stack-runtime.ts` was not purely local-stack.** It also held
   `toAgentSandbox`, `resolveSandboxPath` (workspace path-escape guard), and
   `truncateOutput`. All three are generic and were extracted to `agent-sandbox.ts`
   rather than deleted. `wrapSelectAsJson` is SQL and went.
2. **`supabase.ts` was not purely Supabase.** `ensureSupabaseSandboxImage` and its
   retry helper are generic and moved to `image.ts` as `ensureSandboxImage`. **The
   sandbox base image is already product-agnostic upstream**: node, git, curl, docker,
   psql and the Vercel skills CLI, with the Supabase CLI installed separately per
   local-stack session. It needs one addition for us, the Hookdeck CLI, which is a
   two-line Dockerfile change.
3. **The blast radius of platform-lite is one import.** Despite being 16,085 lines, it
   was imported by exactly one source file (`packages/core/src/index.ts`); everything
   else was comments. Removing the Supabase declarations from `core/index.ts` came to
   976 lines against the 1,076 estimated.

Elapsed: well under the one-day budget for the two steps covered.

---

## Phase 1: the provisioner

Two days. The only component with no existing implementation, and the thing every
scenario depends on.

Today the harness works against a project we set up ahead of time and wipe between
runs. Org-level API keys with public project-management endpoints are planned, at which
point the harness creates and destroys a real project per run. Build for both from the start: the temporary half goes behind
one interface and the swap is a new file.

### The one abstraction that matters

```ts
interface ProjectSource {
  acquire(): Promise<LeasedProject>;   // { projectId, apiKey, acquiredAt }
  release(p: LeasedProject): Promise<void>;
}
```

`hookdeckRuntime()` takes a `ProjectSource` and knows nothing else about where
projects come from. Two implementations:

- **`FixedProjectSource`** (now): hands back a pre-created project from config, wipes
  it on acquire.
- **`ApiProjectSource`** (when the org key ships): creates a project, returns it,
  deletes it on release. Cleanup becomes "delete the project", which retires both the
  wipe logic and the event-history handling below.

About 30 lines of interface. It is the difference between the org-key swap being a new
file plus a config line, and being a rewrite of the runtime.

### How a run gets its environment

1. **Two projects.** `evals-ci` and `evals-local`, created by hand in a dedicated
   a dedicated organization. Two rather than one so scenario authoring does not
   collide with a scheduled run. Keys in GitHub Actions secrets and Doppler.
2. **Wipe on acquire.** Delete every source, destination, connection, transformation,
   and issue trigger, then apply the scenario's `remote/` seed.
3. **Seed.** `remote/` is a declarative JSON or YAML file listing resources to create,
   plus (for investigate scenarios) HTTP requests to POST at the source URL to
   generate event history. Events are seeded by sending them.
4. **Cleanup on release.** Delete resources created since `acquiredAt`, best-effort.
   This keeps the project tidy between runs; step 2 is what guarantees a clean start.
5. **Credentials.** The agent gets the project's API key as `HOOKDECK_API_KEY` in the
   sandbox environment. The scorer holds a separate handle to the same project. Lift
   `redact-secrets.ts` from the outpost harness (93 lines plus 210 lines of tests,
   already written) and run it over transcripts before export, so project keys never
   land in a public results file.

**Wipe to pristine, not to empty.** A new Hookdeck project is not empty: it ships with
four default issue triggers (verified on `evals-ci`, see Spike results). Deleting them
changes what BM4 tests and drifts the project irreversibly away from what a real user
has. So: snapshot the project's resource IDs on first acquire, persist the snapshot,
and on every subsequent acquire delete only what is not in it. That still self-heals
after a crashed run, because the snapshot is the reference point rather than a per-run
timestamp. Treat "pristine" as whatever exists before the harness first touches the
project, so any future default resource type is protected without a code change.

`created_at` is present on all five resource types, so the scoped release-time cleanup
is implementable. The list endpoints take `id, name, disabled, disabled_at, order_by,
dir, limit, next, prev` and no `created_at` filter, so it lists and filters
client-side. Fine at eval scale.

### Concurrency: one run per project until the org key lands

One project supports one run at a time.
Sources and destinations each carry a per-project uniqueness constraint on the alias
derived from their name, so Two concurrent BM1 runs that both name
a source "stripe" collide at the database. A scorer listing sources would also see the
other run's resources with no way to tell them apart.

For the weekly run, which is 94 agent runs:

- **Serialized wall clock is 4 to 6 hours** at the measured median of 2.7 minutes with
  a long tail. Acceptable for a scheduled job nobody waits on.
- **Shard across the two projects.** Two matrix jobs, each looping through half the
  pairs in-process. Two to three hours per shard, inside the six-hour job ceiling,
  with the per-pair retry logic intact inside the loop.
- **Do not serialize via a GitHub Actions concurrency group.** A group holds one
  running and one pending job and cancels every further queued job, so 94 matrix jobs
  sharing a group would mostly evaporate. The outpost workflow avoids this only
  because its CI slice is two scenarios.

`ApiProjectSource` removes the cap: one project per matrix job, weekly run drops to
about 60 minutes, and the shard loop becomes a plain matrix again.

### Event history

Events and requests are read-only through the API, so a fixed project accumulates
history across runs. **Scope every scorer query to a window starting at
`acquiredAt`.** Worth doing properly now regardless of the provisioner design, because
a scorer that assumes an empty project will eventually pass for the wrong reason.
`ApiProjectSource` retires the problem, since a fresh project has no history.

### Estimate

Two days. One for the `ProjectSource` interface, `FixedProjectSource`, and the wipe.
One for the seed format, event-history seeding, redaction wiring, and credential
plumbing into the sandbox. A further half day for `ApiProjectSource` when the org key
ships.

---

## Phases 2 and 3: scenario authoring

**This is the largest line item in the project, larger than the harness work.** Price
it accordingly.

### What a scenario costs

Per benchmark scenario: prompt (0.5h), scorer (2 to 4h), seeded state (1 to 3h for
investigate scenarios, near zero for build), motivation evidence (0.5h), then
iteration until at least one agent fails it for a legitimate reason rather than a
harness limitation (2 to 4h). That last item is supabase/evals' own contributing bar
and it is where the time goes.

- Build scenarios, blank project: **0.5 day each**
- Investigate/resolve scenarios, seeded state: **1 day each**
- Regression scenarios: **0.5 day each**. They are tasks like any other scenario, and
  most of the cost is making the primary check deterministic

For the proposal's set (6 build, 3 investigate/resolve, 2 agentic delivery, 2 Outpost,
3 regression): 3 + 3 + 2 + 1.5 + 0.75 + 0.5 = **about 11 days**. Call it 10 with the
second half going faster than the first.

### What migrates

**agent-skills is the useful source.** `scenarios.yaml` has four scenarios
(`receive-webhooks`, `investigate-delivery-health`, `receive-provider-webhooks`,
`outpost-managed-quickstart`) across three frameworks, each with staged, points-based
evaluation criteria, driven by a 1,748-line TypeScript tester with an LLM judge.
`receive-webhooks` is BM1 and BM6. `investigate-delivery-health` is the closest thing
we have to BM7. `outpost-managed-quickstart` feeds BM12. Budget 2 of the 10 days as
already done.

**webhook-skills contributes two prompts and vendor fixtures.** Its six agent
scenarios in `TESTING.md` are markdown checklists with a manual 10-point rubric per
scenario; the runner (`scripts/test-agent-scenario.sh`, 489 lines of bash) is
Claude-Code-only. Scenario 4 (Hookdeck signature verification) and Scenario 6 (Express
raw-body debugging) are the Event Gateway ones and carry over as prompts; 1, 2, and 3
test provider skills and stay in that repo's CI. `providers.yaml` has testScenario
entries for 150 providers, useful as vendor fixtures for BM1 and BM5. Budget half a
day.

**Promote two outpost scenarios.** Scenario 08 (integrate Outpost into an existing
Next.js SaaS) as BM13, per the proposal, plus scenario 01 (curl quickstart) as a cheap
floor: measured at $0.14 to $0.27 and about a minute per run, and it has the most
historical run data to compare against. Leave 02, 03, 04, 06, and 07 in the outpost
inner loop; they are the same journey in TypeScript, Python, and Go, which is depth
rather than breadth. That resolves open question 3.

### The regression scenarios

**R1, filtering.** Built, then split in two once measurement showed one prompt could
not carry both jobs. Both scenarios open the same way: order references look like
`ORD-2026-AC-4821`, the format changed at the start of the year, and the old ones
still arrive.

`regression-filtering-001-regex-capability` asks the capability question and stops
there: *"can I use a regex on the reference? What is the closest I can get?"* One
check, a pure negative: did the assistant claim regex filtering or a channels feature
exists. No seed and nothing to build, because a capability question is answerable from
the documentation alone. This is the June 2026 incident, and it reproduces: Claude Code
answers in 40 seconds with zero tool calls and offers two regex patterns, Codex answers
correctly.

`benchmark-filtering-001-enterprise-orders` adds *"whatever the answer, set up the
filtering so only the current format reaches my endpoint"* and seeds a source, a
destination and a connection. It keeps the negative check and adds an outcome probe:
send one reference in each format and confirm the current one arrives and the legacy
one does not. Correct answers use `$startsWith`; the probe scores whether the filtering
works rather than whether the rule matches a shape we guessed.

Both agents pass the benchmark version, so it does not discriminate between them today.
It stays because it is a fair build task and the pair is the measurement: identical
scenarios either side of one clause, where the difference in results is the finding.

**R2, payload limits.** Seed a source and send one request above the 10 MiB inbound
ceiling so it is rejected with `PAYLOAD_TOO_LARGE`, then: *"some of our events just
aren't showing up."* An investigate task. Judged on the diagnosis, with a negative
check against stating a wrong limit.

**R3, source verification.** *"Set up my source to verify this provider's signature."*
The prompt carries a sample request with the signature header. Scored entirely on API
state: algorithm, encoding, and header key on the source's verification config. **No
judge at all.**

The five-minute-job half of the original R2 belongs in BM10, which is the same problem
with a different number, rather than being tested twice.

### First finding: a skill an agent never loads cannot help it

The `+skills` row was wired and pointed at the scenario the baseline fails, on the
theory that shipping a skill is how we fix a hallucination. One run, so treat it as a
lead rather than a result, but it did not go that way.

The skills were available to the agent and it loaded neither. Zero tool calls, zero
documentation pages, 42 seconds, the same invented regex operator as the baseline. The
plumbing is fine, which the run proves: both skills were offered.

The first read was that the skill descriptions failed to advertise filtering, which is
true of `event-gateway` and does not explain this. Check what the agent actually had in
front of it. The system prompt says *"you are an agent working on a real Hookdeck
project... use the provided tools to inspect and change the project"*. The `hookdeck`
skill's description says *"use when working with any Hookdeck product and unsure which
skill to use"*. The match could hardly be more direct, and the agent loaded nothing and
called nothing.

So the finding is not about discoverability. **A skill is a remedy for knowing you are
ignorant, and this agent was not ignorant, it was certain.** Progressive disclosure only
ever offers; something has to prompt the agent to accept, and a confident wrong answer
prompts nothing. The failures a skill would most usefully prevent are exactly the ones
where it never gets opened, and that holds however good the skill is.

Which sets a limit worth knowing before we sell skills as the fix for hallucination.
They should lift tasks an agent knows it cannot complete from memory, which is most
build work, and do very little for questions it thinks it can already answer. The
benchmark suite is build-heavy, so expect the `+skills` row to move there and stay flat
on the regression suite. If that is what the numbers say, it is a finding about how
skills work rather than a disappointing result.

Worth fixing anyway, separately: `event-gateway`'s description omits filter, filtering,
rule and transform, though the body names them as core Rules. A description is a routing
decision rather than a summary. That is a real defect, just not this one.

One run, one agent, one scenario. Confirm with repeats before anyone acts on it.

### What BM1's first run showed

Scored 2 of 4 at $1.92 in under seven minutes. The agent's work was good and both
failures were the scorer's, which is the third time that has been true and the reason
the rule exists.

**Skills get loaded on build tasks.** `loaded: ["hookdeck", "event-gateway"]`, against
`loaded: []` on the regression question. That is the prediction above confirmed on its
first test: an agent reaches for a skill when it knows it cannot proceed from memory,
and not when it thinks it already knows. Two data points, so hold it lightly, but they
point the same way.

**An agent can install skills itself, and this one did.** It ran `npx skills add
hookdeck/webhook-skills --skill stripe-webhooks` and used the result. The sandbox has
network access because scenarios need the documentation, and the skills registry is on
the same network.

Resolved by splitting the question rather than answering it once, because two different
things were being conflated. Product skills (`hookdeck`, `event-gateway`) are the axis:
a `-no-skills` run that installs one has stopped being a baseline, and the delta between
arms is the number this project publishes, so that run is excluded from it. Provider
skills (`stripe-webhooks`) are not the axis: documenting a third party's signature
format was never Hookdeck's responsibility, we maintain those skills for exactly this
case, and an agent finding them is the system working. Recorded either way, in
`skills.selfInstalled`, read off the commands the agent ran.

Blocking the network was considered and rejected. The documentation is on it, and a
baseline that cannot reach the internet is unrealistic in the opposite direction.

supabase/evals draws the same line from the other side. Their harness sources skills
"from the local `skills/` directory, never the network", so the controlled arm stays
controlled, while their eval metadata supports a per-eval `skills: []` override
described as "for a scenario where the prompt asks the agent to install skills itself".
Deliberate self-installation is a declared scenario type there; incidental
self-installation is the case neither suite had handled.

**The scorer has to own process lifecycle.** Nothing was listening when scoring ran,
so both live checks failed. The agent was right: asked to set this up, it wrote the
handler, configured the connection, and documented `npm start` and `hookdeck listen` as
things the developer runs. The deliverable is code and configuration, not a running
process, and a scorer that expects a live server is scoring tidiness. It should start
what the agent built, exercise it, and stop it.

**And the handler needs a secret the API does not expose.** To verify
`x-hookdeck-signature` the handler needs Hookdeck's signing secret. The agent could not
read it either and left a placeholder in `.env.example`, which is the correct thing to
do and also means the positive path cannot pass however the processes are managed. The
seed has to supply it, the way it already supplies the Stripe secret, sourced from the
environment rather than committed.

### First product finding: `hookdeck listen` assumes a terminal

Not a finding about an agent, and not about the harness. `hookdeck listen` defaults to
`--output interactive`, a full-screen UI that opens `/dev/tty` and exits with
`could not open a new TTY: open /dev/tty: no such device or address` wherever there
is no terminal. `--output compact` and `--output quiet` both work.

Every context an agent runs in is non-interactive. So is CI, a Docker entrypoint, and
anything backgrounded. A default that assumes a terminal fails for agents first, and
it fails as a crash on startup rather than a message naming the flag that would fix
it. An agent that hits this sees its tunnel die with a Bubble Tea stack trace and has
to infer both the cause and the remedy.

Claude Code inferred both, unprompted, and used `--output compact` without being told.
That is the good version of this result and it should be said plainly: the product
tripped, and the agent recovered. The scenario still caught it, because the scorer
made the same mistake the CLI invites and spent a run on it.

Two candidate fixes, and this belongs to whoever owns the CLI rather than to this
suite: detect a missing TTY and fall back to compact rather than crashing, or name the
flag in the error. The first is better, because the failure is silent from the outside
- the tunnel simply is not there - and silence is expensive to debug.

This is what the benchmark is for, arriving before launch and about our own tooling.

### Confirmed: nothing queues when `hookdeck listen` is not running

Found while debugging BM1, and confirmed against the platform source rather than left
as an inference.

An agent set up a CLI destination and told the user it had configured retries "so
events queue and retry automatically if your local server or `hookdeck listen` session
is briefly down while you're developing". Half of that is right and the half that is
wrong is the half a developer relies on.

What the request records show, across several runs: with a session connected, a
verified request produces a CLI event and delivers. With no session connected, the
same request is `verified: true` with no rejection, produces no event of any kind, and
carries `ignored_count: 1`. Ingestion has an explicit branch for it: a connection whose
destination has no URL, with zero CLI sessions, is ignored with cause
`CLI_DISCONNECTED`.

So it is intended behaviour, not a defect. And it is less severe than the first reading
of it: an `IgnoredEvent` is recorded with cause `CLI_DISCONNECTED`, listable at
`/requests/{id}/ignored_events`, and replayable through `/bulk/ignored-events/retry`,
which filters by cause. Nothing is lost.

What is true is narrower and still worth fixing. **Recovery is manual, and the agent
said it was automatic.** If the local server is down while the tunnel is up, an event
exists, delivery fails, and retries do exactly what the agent described. If the tunnel
itself is down, no event exists, no retry fires, and someone has to know that ignored
events are a separate class with their own bulk-retry endpoint before anything comes
back. Those two cases are indistinguishable from the developer's side and only one
self-heals.

Three things follow, in order of how cheaply they can be fixed:

1. **`ignored_count` is hidden from the public API reference** (`x-docs-hide`), so the
   one field that says "accepted, and went nowhere" is not visible to anyone reading
   the docs. An agent debugging this cannot find it, and the recovery path it would
   lead to is `/bulk/ignored-events/retry`, which is the thing you actually need.
2. **The distinction is a docs gap.** Nothing an agent is likely to read explains that
   `listen` being down loses events while the server being down does not.
3. **This is a regression scenario**, once the docs say something for it to be scored
   against: an agent asked about durability while developing locally should not promise
   queuing it does not get.

The scenario that surfaced this was passing on its own terms at the time. The finding
came out of a scorer disagreeing with an agent, which is the third time today that
disagreement has been worth more than the score.

### The first delta, and it is zero

Both build scenarios run against the baseline. Both pass.

| Scenario | no-skills | +skills |
|---|---|---|
| BM1, Stripe into an Express handler | 5/5, $1.45, 5 docs pages | 5/5, $2.02 |
| BM6, events arriving at a local service | 3/3, $0.62, **0 docs pages** | 3/3, $0.97 |

Clean baselines: no skills available, none loaded, none self-installed. So this is a
real measurement rather than a leak.

Skills changed no outcome and cost 39% and 56% more. One run each, so the percentages
are indicative, but the direction is consistent and the pass rates are not close calls.

The BM6 baseline is the sharper number. It reached a working tunnel and a delivered
event having read **no documentation at all**. That is a task a frontier model already
knows how to do, and a scenario that asks nothing of our docs or our skills cannot
measure either.

**Neither scenario discriminates, so neither is carrying benchmark signal today.** Our
own rule says a benchmark scenario needs at least one agent to fail. On this evidence
we have three benchmark scenarios and zero discriminating ones.

The regression suite is the contrast, and it points at where the signal actually is.
`regression-filtering-001-regex-capability` fails Claude Code and passes Codex,
reliably, on a capability question. Asked *what can this product do*, an agent answers
from memory and invents. Asked *build this*, the same agent reads the documentation and
succeeds.

That reframes the headline. The evidence so far says frontier agents build with
Hookdeck successfully from documentation alone, and fail when stating what the product
cannot do. If that holds up, it is a better and more honest story than "skills lift
build success", and it points investment at capability accuracy rather than at
build-time guidance.

Two things follow for scenario selection. Build scenarios need to be harder than the
vendor golden path to discriminate at all: the trap has to be somewhere the
documentation is thin or the correct answer is counterintuitive, not somewhere a
competent developer would get it right. And the suite should stop assuming the aided
delta is the headline until a scenario produces one.

Worth re-testing on weaker models before concluding. A baseline that passes on Sonnet 5
may still fail on Haiku or a smaller Codex model, which would make these scenarios
useful as a floor rather than useless.

### What supabase/evals actually scores, and why it changes the read

Their published results shipped in our first commit, so this is their data rather than
an impression of it. Ten experiments: Claude Code on Opus 5 and Sonnet 5, Codex on
GPT-5.6 and GPT-5.4-mini, opencode on Kimi K3, each with a no-skills twin. Nineteen
benchmark scenarios, 190 rows.

**Pass rates run from 73.7% to 100%.** The weakest configuration is GPT-5.4-mini at
14/19 without skills. Two configurations score a clean 19/19, and one of those is a
*no-skills* arm.

**Twelve of their nineteen scenarios are passed by every agent.** Only seven
discriminate at all, and the hardest sits at 5/10:

| Passed | Scenario |
|---|---|
| 5/10 | investigate-auth-001-deleted-user-access |
| 7/10 | build-functions-005-dual-auth-user-secret |
| 7/10 | deploy-database-001-prometheus-metrics |
| 8/10 | build-cli-002-declarative-schema |
| 8/10 | investigate-reliability-003-edge-function-5xx-correlation |
| 8/10 | resolve-database-001-migration-history-mismatch |
| 9/10 | build-functions-004-service-role-bypass |

**Their aided delta is small and not consistently positive.**

| Agent | no-skills | +skills | delta |
|---|---|---|---|
| Claude Code Sonnet 5 | 15/19 | 18/19 | +3 |
| Codex GPT-5.6 | 18/19 | 19/19 | +1 |
| Codex GPT-5.4-mini | 14/19 | 15/19 | +1 |
| Claude Code Opus 5 | 18/19 | 18/19 | 0 |
| opencode Kimi K3 | 19/19 | 18/19 | **-1** |

Three things follow, and they change the reading of our own zero delta.

**Our result is normal, not a defect in our scenarios.** A published benchmark from the
project we are copying has 63% of its scenarios producing no signal and a skills delta
that is zero or negative for two of five agents. We measured two scenarios and found
zero. That is the same picture at a smaller sample size.

**The scenarios that discriminate are not golden paths.** Two of their three hardest
are investigate, one is deploy, and the build scenarios that bite involve subtle
authorization combinations rather than the vendor happy path. Ours are all build, all
golden path. That is the gap, and it was predictable from their data before we spent
anything.

**Weaker models are where the floor shows.** GPT-5.4-mini is 4-5 scenarios behind the
frontier models on the same suite. A scenario that Sonnet 5 clears may still be worth
keeping as a floor, which is the argument for running our three against a weaker model
before judging them useless.

The sequencing consequence is direct: BM7, BM8 and BM9 are our investigate and resolve
scenarios, and the plan currently schedules them **last** because they are the hardest
to seed. On this evidence they are the ones most likely to carry signal, and they
should move up.

### The scenarios are a floor, and the floor found two real failures

GPT-5.4-mini, no skills, against the same three build scenarios that every frontier
configuration passes:

| Scenario | Sonnet 5 (either arm) | GPT-5.4-mini |
|---|---|---|
| filtering, enterprise orders | pass | pass |
| local delivery | pass | **fail** |
| Stripe into an Express handler | pass | **fail 4/5** |

So they are not dead weight. They are flat across the frontier and discriminating below
it, which is what a floor looks like, and it is the same shape as supabase/evals where
GPT-5.4-mini trails by four to five scenarios. Keep them, and stop reading "everyone
passes" as "no signal" without testing the bottom of the range.

Both failures are worth more than the score.

**It bypassed the project entirely and reported success.** Asked to get events arriving
locally, it ran `hookdeck listen` without authenticating, which falls back to the
no-account path and issues a guest Console URL. Traffic genuinely arrived at the local
service, and its report ends "you can now point real traffic at that Hookdeck source
URL and watch deliveries land on your machine". All true, and none of it in the
project: no connection, no delivery history, no retries, and an ephemeral URL.

`HOOKDECK_API_KEY` was in its environment throughout. `listen` does not use it for
authentication; the documented non-interactive paths are `--cli-key` and `--api-key`,
and the frontier model knew to run `hookdeck ci --api-key` first. So the difference
between using your project and not using it is one unprompted step, and skipping it
fails silently in the most convincing possible way, with a working tunnel and a working
URL. A developer following that agent's instructions would believe they were set up.

That is a better regression scenario than anything currently in the suite, and a
product question before it is a scenario: should `listen` prefer an API key that is
already in the environment, or say plainly that it is running unauthenticated.

**It configured Stripe verification with the wrong secret.** The source rejects a
request signed with the secret sitting in the developer's own `.env`, while correctly
rejecting a forged one. The integration would never receive a real Stripe event, and
nothing about the configuration looks wrong from the outside. This is exactly the
silent-failure class the suite exists to catch, and the deterministic both-directions
check is what caught it.

### Stage was the wrong lever: it is difficulty, not category

I read supabase's results as saying investigate and resolve discriminate, moved them up
the plan on that basis, and wrote one of each. Both pass on every configuration,
including GPT-5.4-mini, which fails two of the three build scenarios.

| Scenario | Stage | +skills | baseline | GPT-5.4-mini |
|---|---|---|---|---|
| filtering, enterprise orders | build | pass | pass | pass |
| Stripe into an Express handler | build | pass | pass | **fail** |
| local delivery | build | pass | pass | **fail** |
| failing deliveries | investigate | pass | pass | pass |
| paused connection | resolve | pass | pass | pass |

So our investigate and resolve scenarios are *easier* than our build ones, which is the
opposite of the pattern I inferred. The category was a proxy for difficulty in their
data, not the cause of it, and I treated the proxy as the mechanism.

Look at what their hard ones actually ask. `investigate-auth-001-deleted-user-access`
at 5/10 turns on what happens to access when a user is removed, which is a cascade
across objects. `investigate-reliability-003-edge-function-5xx-correlation` at 8/10
says correlation in its name. Both need several signals held together.

Ours need one lookup each. BM7: list the attempts, one destination returns 422 and the
other does not. BM8: read one boolean field. Neither rewards holding two facts at once,
so neither separates a careful agent from a quick one, and a weaker model gets there as
easily as a frontier one.

**What discriminates is a question whose answer is not in any single response.** The two
scenarios that do bite are the two where something is quietly wrong rather than plainly
broken: a source configured with the wrong secret still looks configured, and a tunnel
that never authenticated still reports success. Both are silent failures, and both need
the agent to notice an absence rather than read an error.

That is the design note for the next scenarios, and it replaces "write more
investigate":

- The evidence should require correlation. Which events are missing rather than which
  failed; what changed around the time it started; which of several connections
  explains a partial outage.
- The wrong answer should be available and plausible. A scenario where the only visible
  signal is the right one measures whether the agent can read a list.
- Prefer silence to errors. Every scenario that has discriminated so far failed
  quietly.

### What actually discriminates: the agent being wrong about its own claim

The correlation scenario was built to the design note and passes on everything,
including GPT-5.4-mini in 133 seconds. So difficulty was not the lever either, and
three attempts at finding one have now failed: stage, then single-lookup versus
correlation, then silent-versus-loud failure.

Sorting every result by whether it produced signal makes the actual line obvious.

| Scenario | Discriminates | Shape |
|---|---|---|
| Stripe verification | yes, at the floor | agent configured a source with the wrong secret and believed it worked |
| local delivery | yes, at the floor | agent set up a guest Console session and reported success |
| regex capability | yes, at the frontier | agent answered a capability question from memory |
| failing deliveries | no | read the attempts, report |
| paused connection | no | read a field, change it |
| partial outage | no | read the filter and the requests, report |

The three that carry signal are all cases where **the agent's own output or claim was
wrong and it did not know**. The three that carry none are all cases where the evidence
was present and the task was to read it and reason. Agents are extremely good at the
second and unreliable at the first, and that distinction cuts across build, investigate
and resolve rather than following them.

This is a better finding than a discriminating benchmark would have been, because it
says something specific about where an agent is dangerous rather than which agent is
better. An agent that misreads delivery history wastes an afternoon. An agent that
configures verification with the wrong secret, or tunnels to a guest session, or
promises queuing the product does not do, produces something that looks finished and
fails in production.

It also settles what the remaining build scenarios should be. BM2 to BM5 are all
constructive tasks, and each has a version where the output can be silently wrong:

- **BM3, transformations.** A transformation that runs and produces a plausible payload
  with a field quietly dropped. Score by running it and comparing the delivered body.
- **BM4, issue triggers.** An alert configured so that it never actually fires. Score by
  causing the condition and checking whether the notification is created.
- **BM2, filtering with retries.** A rule that looks correct and excludes valid orders,
  which is the shape of the June incident.
- **BM5, provider webhooks.** The same trap as BM1 against a provider whose signature
  scheme is less familiar, so memory is less reliable.

Write each so the agent can finish confidently and be wrong. That is the only shape that
has produced signal, and it is also the shape that produced all three product findings.

### How regression scenarios are written

Regression scenarios are **tasks with verifiable end states**, exactly like benchmark
scenarios. The difference is only which suite they belong to and therefore whether
they reach the published scoreboard. There is no separate Q&A format.

A hallucination is caught as a **negative check inside a task scorer**, not by quizzing
the agent. This is how supabase/evals handles the same problem: their realtime
scenario is an ordinary "set up live updates" task whose scorer includes
`checkNoReadReplicaGuidance`, failing the run if the agent recommends read replicas
along the way.

Four rules, which follow from that:

1. **The primary check is deterministic wherever possible.** Query the project and
   compare. Across supabase/evals, 69 of 91 checks are deterministic and only 22 are
   judged; roughly three to one is the ratio to aim for. A scenario that is entirely
   judged is a design smell.
2. **Ground truth for a judge is narrow, inline, and scenario-local.** State the one
   fact the scenario turns on, in the scorer that uses it. Do not maintain a shared
   document of product facts: it duplicates the docs, goes stale silently, and makes
   the judge the arbiter of truth instead of whether the thing works.
3. **Write hallucination checks as negatives.** Name the specific wrong claim ("fail if
   it offers a regex filter operator"), rather than enumerating everything true and
   requiring a match. A negative check cannot go out of date by omission.
4. **Finding the right documentation is part of what is measured.** `hookdeck.com`
   serves `llms.txt` and markdown versions of its pages, so a docs-only agent has a
   real map to navigate. Handing the agent, or the scorer, a pre-digested summary of
   the docs skips the skill the benchmark exists to measure.
5. **Put the context an agent needs in the seed, not the prompt.** A scenario with no
   seeded state gives the agent nothing to discover, so a good agent asks clarifying
   questions and scores zero for behaving well. The first run of R1 failed exactly
   this way: the prompt asked for a filter on order value and customer domain, but
   with no events seeded there was no way to learn the payload field paths, and the
   agent correctly asked rather than guessed. Seed event history and let the shape be
   discovered.
6. **A negative check must be purely negative.** "Fail only if it invents a regex
   operator" and nothing else. R1's first version read "pass if it builds the filter
   *and* invents nothing", which failed an agent that invented nothing but asked a
   question. Conflating the two makes the hallucination signal unreadable, because a
   failure no longer tells you which half broke.
7. **Phrasing decides whether a hallucination is provoked at all.** Measured on R1:
   asked *"can I use a regex? what's the closest I can get?"*, Claude Code answered
   from memory in 40 seconds with zero tool calls and offered a regex pattern. Told to
   *set the filtering up*, the same agent on the same model read three to four
   documentation pages and did not. The first attempt to hold both in one prompt asked
   the question and requested the work, on the reasoning that this kept the answer
   checkable. It did the opposite: an instruction to build gives an agent a reason to
   look things up that the original support ticket never had, and the scenario stopped
   catching what it existed to catch. Hence the split. A regression scenario guarding a
   capability hallucination asks the question and nothing else; asking for work belongs
   in the benchmark suite.
8. **Score behaviour, not configuration, wherever the API allows.** Hookdeck redacts
   source `config.auth` on read, so R3 cannot inspect the algorithm or encoding an
   agent chose. Signing a request and checking it is accepted, then checking a bad
   signature is rejected, turned out to be the better scorer anyway: it passes an
   agent that reached a correct setup by an unanticipated route, and fails config that
   looks plausible but rejects real traffic.

### Order, and why

Front-loads the scenarios that do not need the provisioner, so scenario work and
Phase 1 overlap.

1. **R1, R2, R3 (regression).** Config-only tasks, so they run fast against a leased
   project. Gives a real number in week one and exercises both the deterministic and
   judged scoring paths.
2. **BM1, BM6 (build, event-gateway).** Blank project. Migrated from agent-skills'
   `receive-webhooks`. First real use of the provisioner.
3. **BM12, BM13 (Outpost).** Scored against managed Outpost, which means an Outpost
   project on the Hookdeck platform rather than a self-hosted open-source instance.
   BM12 is built: an `OutpostClient`, an optional `ctx.outpost` on the scoring context,
   and a scenario that asks for a customer subscription and one delivered event. BM13
   is not, and should wait until BM12 has run: it seeds an existing Next.js app and
   runs the agent's code, so it is worth building on how the Outpost API actually
   behaves rather than on how the spec reads.
   BM13 is promoted from outpost/08. These move after the provisioner rather than
   alongside it; see below for why the ordering changed.
4. **BM2, BM3, BM4, BM5 (build, event-gateway).** Config-heavy, all deterministic
   scorers against API state.
5. **BM7, BM8, BM9 (investigate/resolve).** Need seeded state including event history.
   Last because they are the hardest to seed and the only benchmark scenarios with a
   judge.
6. **BM10, BM11 (agentic delivery).** Cheaper than first estimated. Verified against
   the live API spec: `DestinationTypeConfigHTTP` carries `rate_limit` and
   `rate_limit_period` (`second | minute | hour | concurrent`) inside `config`, so
   both score as a config read like BM4. BM11 sets a time-based limit; BM10 sets
   `concurrent`, capping in-flight deliveries. *Still confirm with whoever owns
   delivery that `concurrent` is the recommended answer for a slow consumer before
   writing the scorer.* The optional second check (observing pacing) may not need
   custom infrastructure either: `MOCK_API` is a built-in destination type carrying
   the same rate-limit config, so it is a destination whose behaviour we control.

Items 1 and 2 are v0. Items 3 to 6 are v1.

### Outpost is scored managed, not self-hosted

**Decision: score against managed Outpost on the Hookdeck platform.** Self-hosted
open-source Outpost was the cheaper option and the earlier assumption, and it is the
wrong one. The benchmark's claim is how well an agent builds with what a customer
buys, and a self-hosted instance is a different product with a different setup path.
The migration source already points the same way: the agent-skills scenario is named
`outpost-managed-quickstart`. It also collapses two environment models into one,
because a managed Outpost project fits the `ProjectSource` seam that already exists
rather than needing a parallel one.

**This costs us the reason Outpost was sequenced early.** The old ordering ran BM12
and BM13 while the provisioner settled, on the grounds that Outpost needed no Hookdeck
project. Managed Outpost does, so those scenarios inherit the same constraints as
every other: one environment at a time, reset between runs, no free parallelism, and
provisioning work before scenario work. They move after the provisioner instead of
beside it, and Outpost stops being the cheap filler it looked like.

**Open, and worth settling before BM12 starts.** Whether an Outpost project is
provisioned and keyed the same way an Event Gateway project is, or needs its own
acquire path. That decides whether `ProjectSource` gains a variant or just a
parameter.

### Rethink triggers

Decision 7 Aug: build all 15 scenarios rather than cutting to eight, and revisit if
setup proves expensive. Two triggers make that a decision rather than a drift, since
the risk with revisit-later is that it arrives when there is no room to act.

- **One day per scenario.** If a scenario is not running end to end after a day of
  seeding and scorer work, park it and move on. The order above front-loads cheap
  scenarios, so a stall shows up against a run of quick wins rather than hiding in a
  slow patch.
- **BM13: three runs before building around it.** At $1 to $3 and 5 to 24 minutes it
  is the expensive, high-variance row. If three runs disagree for reasons that are not
  the agent, swap to outpost scenario 05, which the proposal already names as the
  fallback. About an hour and $9 to find out, worth spending early.

The remaining risk after the BM10/BM11 correction is BM13, plus BM1, BM5 and BM6,
which run the agent's code and check its tests pass. That live-execution path is the
flakiest part of the outpost harness today.

---

## Cost and cadence

### What a run costs

From 47 completed run transcripts in `outpost/docs/agent-evaluation/results/runs/`:
Claude Code on `claude-sonnet-4-6` against real Outpost scenarios, with
`total_cost_usd` reported by Claude Code itself.

| Measure | Cost | Wall clock |
|---|---|---|
| Median | $0.40 | 2.7 min |
| Mean | $0.84 | — |
| Max (scenario 09, FastAPI integration) | $3.14 | 23.5 min |
| Tier 1 (curl, TypeScript, Python, Go quickstarts) | $0.11 to $0.43 | 0.9 to 2.9 min |
| Tier 3 (integrate into existing app) | $0.94 to $3.14 | 4.7 to 23.5 min |

Measured, not estimated. Two caveats: they are Sonnet 4.6, and they include a
22K-token Turn 0 onboarding prompt our scenarios will not have (our prompts are short
and casual by design), offset by more docs fetching in the docs-only experiment. Treat
$0.40 median as the central estimate and re-baseline after the spike.

**Re-baselined, and the estimate holds.** The first full CI run of the regression suite
on Claude Code Sonnet 5, docs-only, one attempt each: $0.11, $0.40, $0.79. Median
$0.40, mean $0.43, against a $0.40 central estimate carried over from a different model
and a different scenario set. The spread tracks how much work a scenario asks for: the
capability question that reads no documentation is the cheapest, and the one that
configures verification and gets probed twice is the dearest. Codex cannot be compared
in money yet, for the reasons in `deriveUsage`.

Wall clock is the number that moved. Six pairs took 22 minutes, because one shared
project forces the matrix to run one job at a time. That is the constraint the
org-level key removes, and it is what makes it worth asking about rather than waiting
for.

### The judge was never expensive: a correction

A per-model usage export settled two things the invoice alone could not, and one of them
overturns a decision made on this page.

**`gpt-5.6` resolves to `gpt-5.6-sol`**, the dearest of the three variants at $2.50
fresh, $0.25 cached and $15.00 output per million. That was unknowable from the pricing
page, which lists no bare `gpt-5.6`, and it is why the price table leaves that id
unpriced rather than guessing. Across 536 requests it cost $9.51, which works out at
about $0.53 a scenario and **$7.40 for a fourteen-scenario pass**.

**The judge cost was overstated by roughly twenty-eight times.** It was derived as a
residual: one day's invoice minus the four Codex runs identifiable that day, with
everything left over attributed to judging. The remainder was mostly other Codex usage
that had not been counted, including a re-run and the replay experiment itself.

The real figure, from the model breakdown: 45 requests, 161,150 input tokens, 4,257
output, none cached. Even priced generously that is **$0.93 for every judge call ever
made**, about two pence a call, or ten pence per fourteen-scenario pass. Not $2.85 a
pass, and not $74 a month.

So the judge was never a cost worth optimising, and the case for moving off `gpt-5.5`
was built on a number that was wrong. The replay evidence stands - `gpt-5.4-mini` agreed
15 of 15 including both real catches - but agreement is a reason the switch is *safe*,
not a reason it is *worthwhile*. Weighed against a saving of about £2 a month, diverging
from upstream on precisely the checks that guard against invented capabilities is not a
trade worth making.

The lesson is narrower than the arithmetic: a residual is not a measurement. Attributing
an unexplained remainder to the thing currently under discussion is how a plausible
number becomes a decision.

### gpt-5.6 on the full suite, and a scorer that punished thoroughness

The second frontier agent, fourteen scenarios plus Outpost. Eleven pass. Of the four
that do not, one is a real failure, one is a missing key, and two were the scorer.

**Real: local delivery.** It tried the API key, was told it was invalid, and fell back
to a guest Console workspace. Same outcome as the weak model, and the same CLI issue
(hookdeck-cli#334), but with a difference worth recording: it *told the user* it had
fallen back. The weak model did not. Both produce a setup that is not in the customer's
project; only one of them is honest about it.

**Not a failure: Outpost.** `OUTPOST_API_KEY` was added after the run started, so the
scenario reported the skip it is designed to report. It still records as `passed:
false`, which is the flaw described below.

**The scorer's, twice.** Both verification scenarios failed on "the handler accepts a
genuine signature", and the handler was right. gpt-5.6 wrote this:

```js
if (hookdeckSource !== 'stripe-checkout' || hookdeckVerified !== 'true' || !hookdeckEventId) {
  return res.status(401).json({ error: 'Unverified webhook source' });
}
```

Hookdeck forwards `x-hookdeck-eventid`, `x-hookdeck-source-name` and
`x-hookdeck-verified` alongside the signature, and checking them is defence in depth.
The probe sent only the signature and `x-hookdeck-verified`, so a correct handler
rejected it. Claude Code passed the same check because its handler happened not to
check those headers.

**So the scenario was scoring the less thorough handler higher**, which is the exact
inverse of what it exists to measure. The probe now carries the full header set,
including the source name read from the project rather than assumed.

This is the same mistake as signing only as Hookdeck, and as searching for a body field
the task removes: a probe that is not what the real thing sends measures the probe. It
has now happened often enough to be the single most reliable source of defects in this
suite, and the convention already in `AGENTS.md` did not prevent it. What would have
caught it sooner is the discipline that did catch it: when a scorer and an agent
disagree, read what the agent actually built before believing the score.

### Findings raised, and where

Every product finding from the suite has been filed against the repo that owns it, with
the measurement behind it. This is what the improvement loop produces beyond a number.

| # | Finding | Raised |
|---|---|---|
| 1 | `listen` crashes without a TTY unless given `--output compact` | hookdeck-cli#333 |
| 2 | A disconnected CLI destination ignores requests; recovery is manual and undocumented, and `ignored_count` is hidden from the API reference | website#741 |
| 3 | `listen` ignores `HOOKDECK_API_KEY` and silently creates a guest account | hookdeck-cli#334 |
| 4 | `connection upsert` accepts an empty `--source-webhook-secret` | hookdeck-cli#335 |
| 5 | A skill's example list read as exhaustive, making an agent worse than no skill | agent-skills#26 |

Three of the five belong to `hookdeck listen`, which is worth noticing on its own: it is
the highest-traffic agent-facing surface we have and the least forgiving. All five share
a shape. Nothing errors, the agent reports success, and the failure appears later
somewhere else.

Finding 4 is the one to fix first if only one gets attention. It is the single cause of
two of the three failures in the suite, across two models and two providers, and the fix
is rejecting a value that cannot mean anything.

### The improvement loop, closed on a skill that was steering agents wrong

The loop the launch is gated on, run end to end on the only pair that can measure a
lift. Skills had changed no outcome anywhere, but every comparison had been made on
Claude Code, which passes everything either way. The weak model is where the failures
are, so that is where a lift is observable.

**Before.** `codex-gpt-5.4-mini-no-skills` fails three scenarios, all credential
handling: a wrong Stripe secret, a missing `webhook_secret_key`, an unauthenticated
`hookdeck listen`.

**With skills.** One fixed, one unchanged, and one substantially worse.

| Scenario | no-skills | +skills |
|---|---|---|
| local delivery | fail | **pass** |
| Stripe verification | fail 4/5 | fail 4/5 |
| ElevenLabs verification | fail 4/5 | **fail 0/1** |

The regression is the useful part. Without skills the agent created an `ELEVENLABS`
source and got four of five checks. With skills it created a generic `WEBHOOK` source
and hand-rolled verification, never mentioning `ELEVENLABS` once, while following the
skill's own `--source-type` pattern twelve times.

**The cause is one line of skill content.** `authentication.md` described source types as
"Provider presets (Stripe, Shopify, GitHub, etc.)". The API has 151. An agent reading
three examples reasonably concluded ElevenLabs was not among them and fell back to the
generic path, which is worse in every way: it hand-rolls an algorithm, header and
encoding the preset already knows.

That is a skill making an agent worse than no skill, by being illustrative where a
reader needs it to be complete. It generalises past this one line: **an example list in
a skill is read as an exhaustive list**, because the agent has no other source for the
boundary.

**The fix**, applied to `hookdeck/agent-skills`: say there are over 150 presets, say
that the examples are examples, and give a command that lists them all.

**After.** The regression is repaired.

| | `ELEVENLABS` mentioned | Score |
|---|---|---|
| no skills | - | 4/5 |
| skills, before the fix | 0 times | 0/5 |
| skills, after the fix | 33 times | 4/5 |

Stated honestly: the fix repaired damage the skill was doing, and did not produce a lift
over no skills. The aided delta on this scenario is still zero. What changed is that it
is no longer negative, and the mechanism is understood rather than inferred.

That is the loop the plan gates launch on, run end to end: a measured failure, a
diagnosis specific enough to act on, a fix, and a re-measurement that moves the number
it predicted. It is also a better launch story than a lift would have been, because it
is falsifiable and specific. We shipped a skill, measured it making an agent worse,
found the sentence responsible, and fixed it.

**One gap remains, and reading the transcript changed what it is.** Both verification
scenarios still fail on "the source accepts a genuine signature", with skills and
without. The first diagnosis was that the skill fails to document configuring the
provider secret. It does document it, the agent found it, and it ran the right command:

```
hookdeck gateway connection upsert ... --source-type ELEVENLABS \
  --source-webhook-secret "$ELEVENLABS_WEBHOOK_SECRET"
```

The variable was never exported into its shell. The secret sits in the workspace `.env`,
the agent read that file with dotenv inside a separate node script, and the shell it ran
the CLI from had nothing. So the flag received an empty string.

**The CLI accepted it.** It created a source configured to verify signatures against an
empty secret, reported success, and the agent told the user the integration was ready.
The source then rejects every genuinely signed request from the provider while
correctly rejecting forged ones, so it looks configured from every angle and works for
nothing.

That is a product finding rather than a documentation one, and it is the sharpest of the
four. An empty webhook secret has no legitimate use: it cannot verify anything. Refusing
it at the CLI, or warning, converts a silent production failure into an error at the
moment it is made. This is also the same failure as the Stripe scenario, which makes it
the single cause of two of the three failures in the suite.

The skill could still help by showing the secret being read from `.env` rather than
assuming it is exported, since every example passes a literal. That is worth a line, but
it is mitigation for a sharp edge rather than the fix.

### The competence gap is authentication, not reasoning

Ten benchmark scenarios, all passing on Claude Code, three failing on GPT-5.4-mini. The
three are not spread across the suite.

| Scenario | GPT-5.4-mini | What it got wrong |
|---|---|---|
| Stripe verification | fail | configured the source with the wrong secret |
| ElevenLabs verification | fail | never set `webhook_secret_key` at all |
| local delivery | fail | ran `hookdeck listen` unauthenticated, got a guest session |

All three are credential handling: a wrong secret, a missing secret, an unauthenticated
session. Everything else passes on the same model, including a transformation that has
to lift a nested field, a filter with a boundary, an alert that has to be scoped to the
right connection, and three diagnostic scenarios.

Two earlier predictions died here. The transformation scenario was built on the theory
that a nested field would be quietly dropped, and the weak model lifted it correctly.
The alerting scenario was built on the theory that a trigger would be misscoped, and it
was scoped correctly. Both were reasonable and both were wrong, and the pattern that
survived was not one anybody predicted.

**A weaker model can build with Hookdeck and reason about it, and cannot reliably wire
up authentication.** That is a specific and useful claim, it is the kind of thing a
benchmark exists to produce, and it points at where documentation and skills would pay
off if the delta ever moves.

It also means the suite's discriminating power sits in three scenarios that cost $6.26
of the $14.44 full-suite total. They are 43% of the cost and all of the signal.

### Re-baselined again, and the median has moved

The earlier re-baseline was three regression scenarios at a $0.40 median, which matched
the estimate borrowed from Outpost transcripts. Eight benchmark scenarios later the
picture is different, because the scenarios got more demanding.

| | Cost |
|---|---|
| Cheapest (filtering, config only) | $0.40 |
| Median | $1.01 |
| Mean | $1.44 |
| Dearest (ElevenLabs, runs a service) | $3.27 |
| One pass of all ten, one experiment | $14.44 |

The three most expensive all run the agent's code: install dependencies, start a
service, probe it. That is also what makes them the scenarios worth having, so the cost
is buying something rather than leaking.

Scale it honestly before scheduling anything. Ten benchmark scenarios across four
experiments is roughly $50 a pass at the current mean, and the plan's weekly figure of
about $50 assumed three models against a cheaper suite. A weekly full run is therefore
nearer $50 than the $50 it was estimated at only by coincidence: the scenario count
went up as the per-scenario cost went up.

Two levers if that is too much, neither of which needs deciding yet. Run the expensive
scenarios on fewer experiments, since a scenario that runs a service is exactly the one
least likely to differ between two frontier models. Or run the full suite fortnightly
and the cheap half weekly. Both are better than dropping the code-running scenarios,
which are the ones that have produced every product finding.

### What a weekly full run costs

12 benchmark scenarios, 6 experiments (docs-only, +MCP, +skills, on Claude Code and
Codex), 2 attempts with stop-on-pass. At a 70% pass rate that is about 1.3 attempts
per pair.

- 12 x 6 x 1.3 = **94 agent runs**
- 94 x $0.45 (median weighted up for BM13) = **$42**
- LLM judge on BM7 and the regression suite, plus the regression runs themselves
  (cheap, no environment): **about $6**
- GitHub Actions: 94 jobs x 6 min = 560 minutes per week. **Free on a public repo.**
  On a private repo, about $19/month.

**A weekly full run costs roughly $50 in model spend, about $2,600 a year.** Wall
clock is 2 to 3 hours per shard until the org key lands, then about 60 minutes.
Neither is a problem for a scheduled job.

Adding Opus 5 (roughly 1.7x Sonnet's per-token price) and two secondary models through
the AI Gateway takes this to roughly **$150 per week, about $7,800 a year**. Treat
that as a decision rather than a constraint: the marginal value of a fourth and fifth
model on the scoreboard is low until the first three tell a stable story.

CI bills per token. Claude Code and Codex run on subscriptions locally, but
supabase/evals' `eval-refresh.yml` sets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
`AI_GATEWAY_API_KEY` as job env, and any scheduled run does the same.

### Cadence

- **Weekly benchmark.** $50 a week is not a number that needs defending.
- **Regression suite on every docs, MCP, or skills change.** 3 scenarios x 6
  experiments = 18 runs with no environment, under $5 and under 10 minutes. This is
  the cheap loop and it should fire often.
- **Benchmark on new model releases, by manual dispatch.** This is what a public
  scoreboard's audience wants, and it is what the ecosystem roadmap asks this harness
  to be the home for. It replaces the proposal's per-release trigger, which would fire
  more often than the scores move.

Two rules for CI. Set `timeout-minutes` on the job and an explicit `--timeout-sec` per
attempt (supabase/evals defaults to 720). Gate the scheduled run behind a repository
variable so it can be turned off in one click without a commit.

---

## Repo and CI

**Repo:** `hookdeck/evals`, public from creation, Apache-2.0. Public buys free Actions
minutes, and two of the artifact's three jobs are public credibility and AEO, which
start earning from day one.

**Layout:** keep supabase/evals' shape, because the runner discovers by convention.
`evals/<id>/{PROMPT.md, EVAL.ts, remote/, local/}`, `experiments/*.ts`,
`packages/core`, `packages/sandbox`, `apps/framework`, `apps/web`.

**Triggers:**

| Trigger | Runs | Why |
|---|---|---|
| `schedule`, weekly | benchmark suite, frontier agents + weak pair | Published scores, and the weak pair is the only source of failures |
| `schedule`, monthly | benchmark suite, full matrix | Adds the `-no-skills` twins, whose delta does not move week to week |
| `repository_dispatch` from the docs repo, and PRs touching `skills/` | regression suite only | Cheap, catches hallucination regressions |
| PR label `run-evals-changed` | only the scenarios changed in the PR | Scenario authoring loop |
| `workflow_dispatch` | anything, by suite/eval/experiment | New model releases, one-offs |

This is supabase/evals' `eval-refresh.yml` model: a `prepare` job discovers
(eval x experiment) pairs and emits them as a matrix, and each matrix job runs one
pair. Lift it, change the schedule block and the suite defaults, and add the shard
loop from Phase 1 until the org key lands.

**Where this stands today.** Pull requests run formatting, typecheck, unit tests and
build. `eval-refresh` runs on two schedules, weekly for the frontier agents plus the
weak pair and monthly for the full matrix, and on manual dispatch. Lifting the file
wholesale turned out to carry more than the schedule: it arrived live on
supabase/evals' nightly cron and fired against a half-built suite, and its matrix ran
pairs concurrently, which one shared project cannot support. It is now
`max-parallel: 1` behind a queueing concurrency group.

Three guards were added after a run cost money and produced nothing: a preflight makes
one real inference call per provider before the matrix starts, a credit or auth
failure in any job cancels the run, and a run that errors before emitting a transcript
event throws rather than being scored. The last one matters most: without it, an
outage is published as agent failure.

**It has run end to end, and the scores match local.** Claude Code fails
`regression-filtering-001-regex-capability` and passes the other two; Codex passes all
three. A scorer that behaves the same on a GitHub runner as on a laptop is the thing
worth knowing, because it means the shared project and the sandbox both survive the
move.

Two failures found by running it rather than reading it, both in the last job, after
every eval had run and been paid for. `publish-results` needs `actions: read` to list
its own run's artifacts, which was dropped when the workflow was simplified. And the
push of exported results has to rebase first: a full run takes tens of minutes, so the
branch has usually moved by the time results exist, and a plain push is rejected. The
lesson generalises past CI. A pipeline whose expensive work happens before its fragile
step should be exercised end to end before it is trusted, because the cheap failure
and the expensive one arrive together.

**The results app in this repo is a local preview, not the published page.** It was
retargeted from upstream's branding on 12 August. The published page lives in the
website repository, is built natively there, and fetches `results/latest.json` per
request so a fresh run appears without a deploy. `/evals.md` serves the same data as
markdown tables.

The exported row still carries no cost or token data, so a cost column remains a
decision about what to export rather than a field to read.

**Results storage:** `results/latest.json` is the published contract,
`results/runs/<timestamp>.json` the history, and `results/index.json` lists what
exists. Each snapshot carries `publishedAt`, the `runId` that produced it, and counts,
so a figure can be traced to its job rather than taken on trust.

History is kept in the repository rather than on a `gh-pages` branch as upstream does,
because it cannot be reconstructed: a row records whether an agent passed, not what it
did, so overwriting `latest.json` destroys the previous answer. `append-gh-pages-history.yml`
was removed rather than left pointing at a branch that does not exist.

Raw per-run output, which does carry transcripts, tool calls and agent reports, stays
in Actions artifacts for 90 days. That window has to exceed the run cadence or it
cannot answer a comparative question, and most real questions are comparative.

**Secrets in a public repo.** Five: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`AI_GATEWAY_API_KEY`, `HOOKDECK_API_KEY` (the `evals-ci` project; becomes an org-level
key when those endpoints ship), `OUTPOST_API_KEY`. Three rules:

1. Gate every workflow that touches secrets on
   `github.event.pull_request.head.repo.full_name == github.repository`, so fork PRs
   skip rather than fail. supabase/evals and the outpost workflow both do this; copy
   the condition verbatim.
2. Run `redact-secrets.ts` over every transcript before export. Transcripts are the
   published artifact and an agent will echo its API key into one eventually.
3. Scope the keys to a dedicated organization with no production
   data and no billing relationship, so the blast radius of a leak is a set of
   throwaway projects. This matters more once the key is org-level, since a key that
   can create and delete projects is a bigger credential than a project-scoped one.

---

## The first improvement loop

Launch is gated on this, so plan it rather than waiting for it to happen.

**Expect the first failure to be a docs gap on signature verification header format,
surfaced by BM1 and BM5 in the docs-only experiment.** The evidence points there: the
June 2026 support ticket in which an assistant described regex payload filtering and a
"Channel" field, neither of which exist; a recurring theme around which verification
schemes a source supports; and webhook-skills' own manual
scenarios, all four of which put "correct verification method" and "raw body handling"
at the top of the rubric. Second most likely is BM4, where issue-trigger config is
thinly documented relative to how often people ask for it.

Being specific about the prediction is the point. If the first failure lands somewhere
else, that is itself a finding worth writing down.

**It landed somewhere else, twice over.** Verification did produce failures, but the
reproducible competence gap across models was authentication rather than header
format, and the largest single effect measured so far is that our skills make the
weakest model *worse* on four scenarios. Neither was predicted here. The prediction
was not wasted: being wrong about it is what made the skills result worth chasing
rather than filing as noise.

**How the fix gets made.** The fix has to be a docs, MCP, or skills change. Changing
the scenario to make it pass proves nothing.

1. Pin the pre-fix result. Tag the results commit and note the exact scenario,
   experiment, and scorer checks that failed, plus the transcript.
2. Read the transcript for what the agent looked for and did not find. This is the
   diagnostic, and it is why transcripts are exported.
3. Make one change in one place: a docs page, an MCP tool description, or a skill. One
   change, so the delta is attributable.
4. Re-run the same scenario and experiment, same model, same effort, at least 3
   attempts to distinguish a fix from variance.
5. Record before and after in `LOOPS.md`: date, scenario, failing check, transcript
   link, the fix (with a link to the docs or MCP PR), and the score change.

**Budget 3 days elapsed, of which about 1 is work.** The rest is waiting for runs and
for a docs change to land and deploy.

`LOOPS.md` is also the launch blog's raw material and product marketing's handoff G2.

---

## What product marketing needs, and when

| Handoff | What he gets | When | What he does with it |
|---|---|---|---|
| G1 | Frozen `eval-results.json` schema plus a sample file with real (not final) numbers | End of Phase 3 | Builds `hookdeck.com/evals` against real data while scores are still moving |
| G2 | `LOOPS.md`: the before/after story from the first closed loop | End of Phase 4 | Launch blog. This is the post's spine, not a supporting detail |
| G3 | Scenario list with one-line descriptions and scorer summaries; methodology note drafted by Phil | End of Phase 2 | Edits the methodology copy, which is the credibility surface of the page |
| G4 | The reproduce-this command | Before page copy freezes | One command on the page. Depends on the plugin decision (Q5) |
| G5 | Launch date, footer link copy, changelog entry | After Phase 4 | Social, changelog, community Slack, AEO |

**Tell product marketing now:** the published page is an Astro page product marketing builds, consuming the
exported `eval-results.json`. hookdeck.com is Astro; supabase/evals' results app is
Vite plus React (`apps/web`, 3,670 lines) and serves us as a local preview for the
scenario-authoring loop. G1 exists to unblock him early, since this is real scope the
proposal implies is free.

---

## Decisions

**Q1. Name.** **Hookdeck Evals.** Repo `hookdeck/evals`, page `hookdeck.com/evals`.
The pattern is what makes it legible (`supabase/evals`, `vercel/evals`), and
"webhook evals" would over-claim: we benchmark agents on Hookdeck, not webhook vendors
against each other. Settle it now so the repo name is fixed.

**Q2. Reuse versus extend.** **Copy supabase/evals**, subject to the spike. 11,327
lines of generic code carry over, and the two expensive-to-write pieces (agent runners
plus transcript parsers for three CLI agents; the container sandbox) are exactly what
the outpost harness lacks. Switch to extending outpost only on spike failure B or C.

**Q3. Outpost promotions.** **Two: scenario 08 as BM13, scenario 01 as a cheap
floor.** Reasoning under scenario authoring.

**Q4. Console coverage.** **Ship v1 as event-gateway plus outpost.** Console is
expected to change substantially before Evals launches, so a v1 scenario would
benchmark something whose shape is about to move.

The product enum carries `console`, the name that ships today. Naming a dimension for
a rename that has not happened would publish a product name before the product has
one. Listing the value now still means the first Console scenario is a folder rather
than a schema change.

On the roadmap's related question: **the discovery benchmark rides this harness, as
its own suite.** Its scorer answers "which product did the agent choose" rather than
"did the thing work", so it stays out of the benchmark scoreboard. Build it after
launch, once the harness is proven.

**Q5. Distribution format (plugin).** **Keep three experiment rungs for v1:
docs-only, +MCP, +skills.** Add `+plugin` as a fourth "what we actually recommend" row
once the plugin ships. The rungs measure different things: the Event Gateway MCP is
read-only (eleven tools: `hookdeck_projects`, `connections`, `sources`,
`destinations`, `transformations`, `requests`, `events`, `attempts`, `issues`,
`metrics`, `help`, plus `hookdeck_login`), so it lifts investigate and resolve while
skills lift build. A single `+plugin` row would average away the most interesting
result the suite produces. **Decide before product marketing freezes the page copy**, because G4
needs to be one command.

Put the expectation in the methodology note so a flat +MCP row on the build track
reads as a finding rather than a bug: near-zero +MCP lift on build, meaningful lift on
investigate and resolve. Build-track MCP lift is a product change (write tools in the
MCP), and Evals surfacing that is the point.

**Q6. Repo location and what moves.** `hookdeck/evals`, public, and **nothing moves**.
webhook-skills' `test-agent-scenario.sh` retires once the harness covers Scenarios 4
and 6; its functional example tests stay as ordinary repo CI. agent-skills'
`agent-scenario-tester` (1,748 lines) retires once the harness covers its four
scenarios; its `scenarios.yaml` prompts migrate. Retiring a superseded tool in its
origin repo keeps its history where it belongs.

**Q7. Fork versus standalone copy.** **Standalone copy.** 63% of the framework is
removed on import and the surviving core is retyped (`ToolScoringContext` swaps
`SupabaseClient` and `ManagementApiClient` for a Hookdeck client, and it is the single
interface every scorer touches), so upstream merges are cherry-picks from commit one.
A fork link would buy provenance we can state in the README anyway, at the cost of
GitHub search behavior, issue behavior, and PRs defaulting to target upstream.

Attribution mechanics, since Apache-2.0 section 4 is specific and supabase/evals ships
no NOTICE file (`LICENSE` only, with "Copyright 2026 Supabase" at line 189):

1. **Keep `LICENSE` verbatim**, including the Supabase copyright line, rather than
   replacing it with a fresh Apache-2.0 template.
2. **Add a `NOTICE` file** (we create it; there is none upstream):
   `Hookdeck Evals / Copyright 2026 Hookdeck / This product includes software
   developed by Supabase (https://github.com/supabase/evals), licensed under the
   Apache License, Version 2.0.`
3. **Preserve any per-file copyright headers** on files copied across.
4. **State changes** (section 4(b)) in `CHANGES.md`: removed platform-lite and the
   Supabase local stack; replaced the scoring runtime with a Hookdeck project
   provisioner; replaced all scenarios and experiments; retained agent runners,
   transcript parsers, suite runner, results export, and results web app.
5. **README section** near the top: "Derived from
   [supabase/evals](https://github.com/supabase/evals)", linking their repo and launch
   post, and saying plainly what we kept.
6. **Make the derivation visible in git.** Seed the repo with one initial commit that
   is a verbatim copy of upstream at a named SHA, then a second commit that removes
   the Supabase runtime. `git log` then shows the derivation without a fork link,
   which is the main thing a fork would have given us.

---

## Use the live API spec, not the committed one

`hookdeck-api-schema/openapi.json` was last updated in **December 2024** and is
substantially wrong. The live spec is served at
`https://api.hookdeck.com/2025-07-01/openapi` (89 paths). Scorers written from the
committed file will encode API shapes that no longer exist.

Three differences found the hard way while building Phase 1:

- **Destination create** takes `type` (`HTTP | CLI | MOCK_API`) and a `config` object,
  not a top-level `url`. The stale file documents the old shape.
- **Rate limiting moved into `config`**, and `MOCK_API` exists as a destination type
  at all. Neither is in the stale file.
- **Delivery Groups** is an entire surface the stale file has no trace of: rate
  limiting keyed by a payload field path (`body.customer_id`), which the ecosystem
  roadmap lists as a company priority in Early Access.

Verified against the live spec and still correct: `PUT /transformations/run` (BM3),
`POST /bulk/events/retry` (BM9), `PUT /connections/{id}/pause` (BM8), events and
requests read-only, and no `created_at` filter on list endpoints.

**Practice for scenario authoring: check every endpoint against the live spec before
writing a scorer, and against a real call before trusting it.** Both Phase 1 mismatches
surfaced only when the code ran.

The same applies to the scorer's own queries, which has now bitten three times: source
verification config is redacted on read; `/events` omits the payload without
`include=data`; destination create takes `type` plus `config.url`. In every case the
agent was right and the scorer was wrong, and it read as an agent failure until someone
opened the transcript. **A scorer that finds nothing is more likely broken than proof
that nothing happened.** Probe the queries against a real project before believing a
red result.

## Scenario coverage vs. actual feature usage

Internal usage data, August 2026. Connection rules ranked by how many projects use
them, most to least:

| Rank | Rule | Covered by |
|---|---|---|
| 1 | Retry | BM2 (partially) |
| 2 | Filter | BM2 |
| 3 | Transform | BM3 |
| 4 | Deduplicate | **nothing** |
| 5 | Delay | nothing |

Destination rate limits are configured on a substantial minority of HTTP destinations,
and HTTP is by far the most common destination type.

Three things this changes:

1. **Keep BM10 and BM11.** Rate limiting is configured widely enough that it is not a
   niche feature, and deserves its scenarios.
2. **Deduplication is a genuine coverage gap**: materially more projects use it than
   use delay, and no scenario touches it. A candidate sixteenth scenario, and cheap
   (a connection rule, so a config read).
3. **Delay is the least-used rule**, which is consistent with it not being the answer
   to BM10.

Caveat: the query counts rules stored directly on the connection. Rules inherited from
rulesets are not counted, so the ranking is a floor rather than exact.

## Not covered: Delivery Groups

**Decided 7 Aug: out of v1.** Early Access and too niche to be a journey developers
actually run, so it fails the selection rule. Revisit at GA if usage grows.

## Open questions

1. **Org-level API key: timeline and scope.** Expected within a month. Does it cover
   project *deletion* as well as creation? Deletion is what makes `ApiProjectSource` a
   clean swap rather than create-plus-wipe. Needed before Phase 3, since it decides
   whether the weekly run starts sharded or parallel. Platform team, ten minutes.
2. **Per-organization project cap.** No limit found in `core` (grepped for
   `max_teams`, `team_limit`, `projects_limit`), but absence of a grep hit is not
   confirmation. Only matters once `ApiProjectSource` is creating a project per run.
   Platform team, same conversation as (1).
3. **Secondary models on the scoreboard.** Three models cost about $50 a week, five
   about $150. The precondition is now met: the 13 August run is the first clean
   full matrix. Tracked as a GitHub issue rather than here.
4. **Plugin decision (Q5).** Needs to be made before product marketing freezes the page copy.
5. ~~**Whether `.plans/` ships publicly.**~~ Resolved 13 August. The repository is
   public and `.plans/` ships with it. Private-repo file paths were removed before
   the switch; run cost is deliberately kept, because cadence decisions rest on it
   and it was re-derived badly when absent.

---

## Where this plan diverges from the proposal

For Phil to decide whether to amend the v2 page. Nothing here changes the strategy.

1. **Section 7, the environment model.** The proposal describes a throwaway project
   created and seeded via the API. That is the right end state and arrives with the
   org-level API key in about a month. Until then, project create, delete, and
   API-key retrieval are session-authenticated dashboard routes
   absent from the public OpenAPI schema, so Phase 1 uses a fixed project behind a swappable interface. The cost
   while it lasts is concurrency: one run at a time per project.
2. **Sections 7 and 8, "delete the Docker sandbox".** Keep it. The container is
   required for every CLI agent in tools mode, which is the only mode we use, and
   `docker-sandbox.ts` is generic. What comes out is `supabase.ts` and
   `local-stack-runtime.ts`.
3. **Section 6, subscriptions.** True locally, but scheduled and CI runs bill per
   token against API keys. About $50 a week for the weekly benchmark.
4. **Section 8, the results web app.** Keep it as a local preview. The published page
   is Astro, built by product marketing against the exported `eval-results.json`.
5. **Section 8 and section 11 Q1, fork plus alternatives survey.** Standalone copy
   rather than a GitHub fork (Q7), and the survey folds into the spike's failure
   branch rather than running in parallel.
6. **Section 5, the regression suite format.** The proposal specifies "LLM-judge
   against a documented capability sheet plus string checks on stated limits".
   Regression scenarios are instead tasks with verifiable end states, with
   hallucinations caught as negative checks inside the task scorer, and no shared
   capability document. See How regression scenarios are written for why.
7. **Section 6, the +MCP rung.** The Event Gateway MCP is read-only, so expect
   near-zero build-track lift. Worth stating in the methodology note before the first
   results publish.
8. **Section 10, phasing.** Replaced by the phase table at the top. The substantive
   difference: scenario authoring is about 10 days, larger than the harness work.
