# Working in this repo

`README.md` covers what the project is and how a run works. This file covers
current status, where the plan lives, and the conventions and traps worth
knowing before you change anything.

## Status

Phase 0 (framework spike) and Phase 1 (the project provisioner) are done. The
regression suite exists and passes on both primary agents. No benchmark
scenarios yet, and no CI.

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
pnpm --filter @hookdeck-evals/framework exec tsx harness/run-eval.ts --dry --suite regression
```

`HOOKDECK_API_KEY` is a project key for a dedicated `evals-ci` project, in an
organisation with no production data. `OPENAI_API_KEY` is needed by the default LLM judge, so any judged
scenario needs it whichever agent produced the run.

Runs bill per token. A local Claude Code subscription does not cover them: the
agent runs inside a container, which needs an API key the same way CI does.

## Conventions

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
