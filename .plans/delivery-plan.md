# Hookdeck Evals: delivery plan

**Owner:** Phil
**Status:** Draft for review
**Date:** 5 August 2026
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

**Status 7 Aug: Phases 0 done, repo created.** The spike passed and this repo is it:
four commits, `git log` showing the derivation from supabase/evals. Typecheck passes,
core 103/103 and sandbox 19/19. **Next: Phase 1, the provisioner** (2 days), then the
first scenarios. The GitHub remote does not exist yet, so nothing is pushed.

Two things to start in parallel, both minutes of effort:

- ~~Create the org and `evals-ci`~~ done 7 Aug: a dedicated org and an `evals-ci` project. Still to add: `evals-local`, and keys into GitHub secrets and Doppler.
- Ask the platform team the two org-key questions under Open questions.

---

## What we build on

The harness is a copy of [supabase/evals](https://github.com/supabase/evals) with the
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
3. **BM12, BM13 (Outpost).** Outpost is a separate API with its own key and needs no
   Hookdeck project, so these run while the provisioner is still settling. BM13 is
   promoted from outpost/08.
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
| `schedule`, weekly | benchmark suite, all experiments | Published scores |
| `repository_dispatch` from the docs repo, and PRs touching `skills/` | regression suite only | Cheap, catches hallucination regressions |
| PR label `run-evals-changed` | only the scenarios changed in the PR | Scenario authoring loop |
| `workflow_dispatch` | anything, by suite/eval/experiment | New model releases, one-offs |

This is supabase/evals' `eval-refresh.yml` model: a `prepare` job discovers
(eval x experiment) pairs and emits them as a matrix, and each matrix job runs one
pair. Lift it, change the schedule block and the suite defaults, and add the shard
loop from Phase 1 until the org key lands.

**Where this stands today.** The table above is the Phase 3 target. What runs now is
formatting and unit tests on pull requests, plus `eval-refresh` on manual dispatch
only. Lifting the file wholesale turned out to carry more than the schedule: it
arrived live on supabase/evals' nightly cron and fired against a half-built suite, and
its matrix ran pairs concurrently, which one shared project cannot support. It is now
`max-parallel: 1` behind a queueing concurrency group, and it will not run at all
until `HOOKDECK_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set as
repository secrets. That is deliberate: an automatic trigger should arrive with the
scoreboard, not before it, so that every run until then is one a person chose to pay
for.

**Results storage:** results committed to the repo as JSON, exported by
`export-results.ts`, with a `gh-pages` branch appending history so the site can show
trend lines. Also lifted from supabase/evals, which has `append-gh-pages-history.yml`
doing exactly this. That workflow has been removed for now rather than left pointing
at a branch that does not exist; restore it from the first commit when there is a
scoreboard to append to. Nothing is published yet, and both results files are empty.

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

**Tell product marketing now:** the published page is an Astro page he builds, consuming the
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
   about $150. Decide after the first stable benchmark run, not before.
4. **Plugin decision (Q5).** Needs to be made before product marketing freezes the page copy.
5. **Whether `.plans/` ships publicly.** It is committed and public by default in a
   public repo. Add to `.gitignore` if the cost numbers and `core` route references
   should stay internal.

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
