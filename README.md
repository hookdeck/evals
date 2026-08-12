# Hookdeck Evals

A public, continuously run benchmark of how well AI coding agents build with and
operate [Hookdeck](https://hookdeck.com): Event Gateway and Outpost.

Results are published at [hookdeck.com/evals](https://hookdeck.com/evals), failures
included.

## Derived from supabase/evals

This project is a copy of [supabase/evals](https://github.com/supabase/evals)
(Apache-2.0), imported verbatim at commit `3672889` and modified from there. Their
[launch post](https://supabase.com/blog/introducing-supabase-evals) explains the
design we build on.

We kept their agent runners and transcript parsers, container sandbox, eval and
experiment discovery, suite runner, results export, and results web app. We removed
the Supabase-specific runtime (a mock Management API and a Dockerised local stack) and
replaced it with a Hookdeck project provisioner, because Hookdeck is SaaS with a
complete public API and scoring can query real project state.

`CHANGES.md` states the modifications in full. `LICENSE` and `NOTICE` carry the
upstream copyright.

## Plan

[`.plans/delivery-plan.md`](.plans/delivery-plan.md) covers the phases, the decisions
and why they were made, cost and cadence, and what is still open.
[`AGENTS.md`](AGENTS.md) covers how to work in this repo: conventions, and the traps
worth knowing before changing anything.

## Quickstart

Clone with submodules:

```bash
git clone --recurse-submodules git@github.com:hookdeck/evals.git
```

If you already cloned without submodules:

```bash
git submodule update --init
```

From the repo root:

```bash
pnpm install
cp .env.example .env
```

Agent-backed runs require the relevant provider key in `.env` (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), plus `HOOKDECK_API_KEY` for the project scoring runs against.

## Concepts

- An **eval** is one scenario under `evals/<id>/`. It contains the prompt, the scorer, and optional starting state: `remote/` (the Hookdeck project the agent finds) and `local/` (files in the agent's workspace).
- An **experiment** is one agent/runtime/model setup under `experiments/<name>.ts`.
- An **eval suite** is a named set of evals to run together.
- An **experiment suite** is a named set of experiments with related configurations, for head to head comparisons.
- An **agent** is the model driver that receives the eval prompt and calls the configured tools.
- A **runtime** is the environment and tool surface an experiment gives to the agent. Ours leases a throwaway Hookdeck project and exposes the API to scorers.

## Running evals

Running evals executes experiment x eval pairs and writes local result files under `results/`.

Run a single eval with one experiment:

```bash
pnpm eval -- --eval regression-verification-001-generic-hmac --experiment claude-code-sonnet-5
```


Run selected evals across multiple experiments:

```bash
pnpm eval -- \
  --experiment claude-code-sonnet-5 \
  --experiment codex-gpt-5.6 \
  --eval regression-verification-001-generic-hmac \
  --eval regression-limits-001-oversized-payload
```

`--suite`, `--experiment-suite`, `--experiment`, and `--eval` accept multiple inputs via repeated flags as well as comma-separated values.

Run all benchmark and no-skills experiments across all benchmark evals:

```bash
pnpm eval -- --suite benchmark --experiment-suite benchmark,no-skills
```

### View results in the web app

After running evals locally, export their results to `eval-results.json` for the web app:

```bash
pnpm export-results
```

Start the web app development server:

```bash
pnpm web
```

## Eval Shape

Every eval contains:

1. `PROMPT.md` - frontmatter metadata plus the task description the agent sees.
2. `EVAL.ts` - a default-exported scorer.
3. Optional `remote/seed.json` - the Hookdeck project state the agent starts from: resources to create, and events to send at a seeded source. Events are seeded by sending them, because there is no create-event API.
4. Optional `local/` - files copied into the agent's workspace before it starts. Text files may contain `${VAR}` placeholders, filled from the run's environment during the copy, for a credential the scenario's developer would already hold but the agent cannot fetch. An unset variable is left as written rather than blanked.

To seed failing deliveries, point a destination at `https://mock.hookdeck.com?status=<code>`; the parameter works on any path, so `https://mock.hookdeck.com/api/v2/analytics/collect?status=422` both fails and reads like a real endpoint.

Put the context an agent needs in the seed, not the prompt. The prompt is what a real
person would type; everything needed to work the task out should be discoverable from
project state. A scenario with no seed gives a good agent nothing to discover, so it
asks a clarifying question and scores zero for behaving correctly.

`PROMPT.md` frontmatter drives eval discovery and site filters:

```md
---
stage: build
suite: benchmark
product:
  - event-gateway
topic:
  - filtering
motivation: Support ticket, June 2026. Short, and safe to publish.
---
```

Allowed metadata values are defined in `packages/core/src/eval-metadata.ts`.
`suite` is required on every eval (`benchmark`, `regression`, or `other`). Run an eval suite with `--suite regression` / `--suite other`. Select experiment suites separately with `--experiment-suite benchmark` or `--experiment-suite no-skills`.

## How a run works

Every run follows the same shape:

1. The experiment's runtime **leases a Hookdeck project** and resets it to pristine.
2. The scenario's `remote/seed.json` is applied, if it has one.
3. A **Docker sandbox** is started with the agent's skills installed and
   `HOOKDECK_API_KEY` in its environment, so the CLI and the REST API both work.
4. The agent runs against whatever tool surface the experiment gives it.
5. The scorer queries the project through `ctx.api` and returns checks.
6. The project is released and reset.

Runs need a Docker daemon, and `HOOKDECK_API_KEY` for the project scoring runs
against. See `.env.example`.

**Reset is to pristine, not to empty.** A new Hookdeck project ships with four default
issue triggers. Deleting them would leave the project unlike any real customer's. The
first acquire snapshots what the project contains and every reset deletes only what a
run added.

**Scope scorer queries to `ctx.acquiredAt`.** Events and requests cannot be deleted
through the API, so a shared project accumulates history, and a scorer that just asks
"did an event arrive?" will eventually say yes because of an earlier run.

## Outpost

Outpost is a separate product with a separate API, and scenarios that use it need
`OUTPOST_API_KEY` in `.env`: a managed Outpost project on the Hookdeck platform, not a
self-hosted instance. Without it those scenarios report a skip rather than failing, so
the rest of the suite runs normally on a machine that has no Outpost project.

Scorers reach it through `ctx.outpost`, which is present only when the key is set. It
is deliberately separate from `ctx.api`: Outpost inverts the gateway's model, in that a
tenant is your customer, the tenant owns destinations, and events are published to
topics rather than routed from sources.

**Outpost state is not reset between runs yet.** The provisioner restores the Hookdeck
project and does not touch Outpost, so tenants an Outpost run creates persist. See
`AGENTS.md`.

## Skills

Skills come from [`hookdeck/agent-skills`](https://github.com/hookdeck/agent-skills), pinned as a git submodule at `submodules/agent-skills`. A `skills/` directory of symlinks into the submodule exposes them to experiments: `hookdeck` (routes to the right product skill), `event-gateway`, and `outpost`.

To use a skill in an experiment, name its directory in the experiment's `skills` array. Event Gateway scenarios want `['hookdeck', 'event-gateway']`, which is the pair a real user installs rather than the product skill alone.

`skills` is in biome's ignore list. Ignoring `submodules` does not ignore a symlink pointing into it, and the skills carry example apps with their own biome config on a newer major that fails to parse against ours.

### What an agent already has

Skills are the only axis. Everything below is in every experiment, so a scoreboard row differs from its neighbour by skills and nothing else:

| Layer | In the baseline | What it is |
|---|---|---|
| Public documentation | Yes | What the agent has to find. No copy of it ships with the scenario. |
| Hookdeck CLI, pinned | Yes, baked into the sandbox image | Not agent-specific, but an agent enabler. `hookdeck listen` is the user's goal in some scenarios. |
| REST API via `HOOKDECK_API_KEY` | Yes, in the sandbox environment | The action surface. Anything an agent creates, it creates here or through the CLI. |
| Skills | No, this is the axis | Agent-specific guidance. |
| MCP (`hookdeck mcp`, ships in the CLI) | No | Read-only: eleven analysis tools that cannot create or mutate. Expect it to lift investigate and resolve while leaving build flat, which makes it a finding to publish rather than a launch row. |

So `-no-skills` is the baseline's honest name: those runs still have the CLI and a live API key. It is not a documentation-only agent, and the page should not imply one.

Both runtimes load skills lazily ([progressive disclosure](https://ai-sdk.dev/cookbook/guides/agent-skills)): only each skill's name+description is in the system prompt, and the agent pulls a skill's full instructions on demand. They differ only in how the body is fetched, because the tools-mode agent has no filesystem:

- **Local-stack (sandbox) mode:** skills are installed into the workspace with [Vercel's `skills` CLI](https://github.com/vercel-labs/skills) (baked into the sandbox image, sourced from the local `skills/` directory — never the network) under `.claude/skills/`. When a task matches, the agent reads `.claude/skills/<name>/SKILL.md` (and any files it references) with its file tools.
- **Tools mode:** no filesystem, so a `load_skill` tool returns a skill's full instructions when the agent calls it with the skill's name.

## Framework Checks

```bash
pnpm check
```

Runs typechecks plus local smoke tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidance on adding evals and experiments, and submitting changes.
