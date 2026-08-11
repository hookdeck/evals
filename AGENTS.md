# Working in this repo

`README.md` covers what the project is and how a run works. This file covers
current status, where the plan lives, and the conventions and traps worth
knowing before you change anything.

## Status

Phase 0 (framework spike) and Phase 1 (the project provisioner) are done.

Three regression scenarios and two benchmark scenarios exist, run by four
experiments: `claude-code-sonnet-5` and `codex-gpt-5.6` with
`['hookdeck', 'event-gateway']`, and `-no-skills` variants of each.

Two regression scenarios pass on both primary agents;
`regression-filtering-001-regex-capability` fails on Claude Code and passes on
Codex, which is the June 2026 incident reproduced rather than a defect in the
scenario. `benchmark-filtering-001-enterprise-orders` passes on both, so it does
not discriminate yet. `benchmark-verification-001-stripe-express` (BM1) has run
once, scored 2/4, and has since been rebuilt around what that run showed; the
rebuilt version is unrun.

BM6 is next: local dev, `hookdeck listen`, deliberately smaller than BM1 so the
tunnel is isolated rather than bundled with provider setup and handler code.

CI runs formatting and unit tests. `eval-refresh` is manual dispatch only.
`HOOKDECK_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set as
repository secrets, so a dispatch will spend; `AI_GATEWAY_API_KEY` is not set
and is not needed until secondary models go on the scoreboard.

The regression suite has run end to end in CI and scored identically to local:
Claude Code fails `regression-filtering-001-regex-capability` and passes the
other two, Codex passes all three. Six pairs took 22 minutes and $1.30 of Claude
Code, the wall clock being one shared project forcing `max-parallel: 1`.

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

**Probe a scorer's own queries against a real project before trusting a red
result.** This has bitten three times: source verification config is redacted on
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
`-docs-only` experiment suffix undersells the baseline, which has the CLI and a
key, not documentation alone.

**Prefer deterministic checks.** Across supabase/evals, 69 of 91 checks are
deterministic and 22 are judged. A scenario that is entirely judged is a design
smell.

**Give a judge one narrow fact, inline.** State the single thing the scenario
turns on, in the scorer that uses it. Do not build a shared document of product
facts: it duplicates the docs, goes stale silently, and makes the judge the
arbiter of truth instead of whether the thing works.

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

## Traps

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
