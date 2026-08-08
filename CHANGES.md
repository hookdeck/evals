# Changes from supabase/evals

Hookdeck Evals is derived from [supabase/evals](https://github.com/supabase/evals),
imported verbatim at commit `3672889f714cd7db96b22d419d449d4ef1ec5f4d` and modified
from there. This file states those modifications, as section 4(b) of the Apache
License, Version 2.0 requires.

The import is the first commit in this repository, so `git log` shows the derivation
and every change since.

## Removed

- `packages/platform-lite`, the in-process mock of the Supabase Management API and
  Postgres. Hookdeck is SaaS with a complete public API, so scoring queries real
  project state instead of a mock.
- The Supabase local stack: `packages/sandbox/src/supabase.ts` and
  `packages/sandbox/src/local-stack-runtime.ts`, which installed the Supabase CLI and
  ran `supabase start` inside the container.
- The local-stack branch of the suite runner, and with it the `tools` / `local-stack`
  mode distinction. Every run is now what upstream called tools mode.
- The framework demo and smoke scripts (`executor-demo`, `mcp-demo`,
  `smoke-framework`, `project-runner`, `platform-backend`, `mcp-tools`,
  `agent-driver`), which exercised the Supabase runtime.
- All upstream scenarios (`evals/`) and experiment configs (`experiments/`). Ours
  replace them.
- `.github/workflows/append-gh-pages-history.yml`, which appended each results
  commit to a `gh-pages` branch. There is no `gh-pages` branch and no published
  scoreboard here yet; restore it from the first commit when there is.

## Replaced

- `ToolScoringContext` described a Supabase Management API client, a supabase-js
  client, an in-process SQL query function, and an edge-function invoker. It now
  describes a leased Hookdeck project: `{ projectId, acquiredAt, api }`.
- `platformLiteRuntime()` is replaced by a Hookdeck project provisioner implementing
  the same `EvalRuntime` interface.
- The sandbox image carries the Hookdeck CLI in place of the Supabase CLI. The base
  image was already product-agnostic upstream, so this is a pinned `npm install -g`
  and a rename.
- `McpServerDefinition.createConfig()` takes a Hookdeck project context rather than a
  platform-lite one.
- `.github/workflows/eval-refresh.yml` is manual-only. Upstream ran nightly on a
  schedule and on PR labels, and published through a GitHub App. Scoring here runs
  against one shared project, so the matrix is `max-parallel: 1` and the workflow
  takes a queueing concurrency group; results are committed to the dispatched
  branch rather than opened as a self-merging PR.

## Retained

Substantially unchanged from upstream:

- The Claude Code, Codex, and OpenCode agent runners, and their transcript parsers.
- The container sandbox (`packages/sandbox/src/docker-sandbox.ts`) and skills
  installation.
- Eval and experiment discovery, the suite runner, retry and concurrency handling.
- The LLM judge, transcript serialization, and the docs/skills usage extraction.
- Results export and the results web app.

## Extracted

Three helpers lived in files that were otherwise removed, and were moved rather than
deleted:

- `toAgentSandbox`, `resolveSandboxPath`, and `truncateOutput` moved from
  `local-stack-runtime.ts` to `packages/sandbox/src/agent-sandbox.ts`.
- The sandbox image build and its retry helper moved from `supabase.ts` to
  `packages/sandbox/src/image.ts`.
