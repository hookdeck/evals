# Vendor agent evals, November 2026

Part of the [November 2026 review](README.md#index). Read on 7 November 2026 from
the live repositories and leaderboards; the saturation figures were re-run on
9 November with [`scripts/external.py`](scripts/external.py). Model names are as
each board prints them. "Unverified" means the figure was quoted from a page and
not reproduced from data.

**Bottom line.** Every vendor suite that publishes per-scenario data is less
saturated than ours at the same metric, and the ones that still separate
frontier models do it with repeated runs reported as averages, APIs newer than
the models' training data, and prompts that invite the old answer.

## At a glance

| Suite | What is measured | Scenarios | Scoring | Attempts and metric | Treatment arms |
|---|---|---|---|---|---|
| [supabase/evals](https://github.com/supabase/evals) | Agents (Claude Code, Codex, OpenCode) against a local stack or a mocked hosted platform | 23 benchmark (build 13, deploy 3, investigate 3, resolve 4); plus cli 27, docs 13, regression 13 | AND of checks; 9 of 23 benchmark scorers call a judge | 3 runs per cell, daily; published rate is passed runs over all runs | Skills against `-no-skills`, six models |
| [clerk/clerk-evals](https://github.com/clerk/clerk-evals) | Mostly one-shot code generation; 5 agent tasks with hidden Bun tests | 37 across Next.js, React, iOS, Android | Fraction of graders passed (partial credit); string, regex and judge graders | pass@k and pass^k code exists ([audit](https://github.com/clerk/clerk-evals/blob/main/docs/eval-suite-audit.tsv)); the board shows category averages | Baseline, MCP, skills, both |
| Vercel [next-evals-oss](https://github.com/vercel/next-evals-oss), scenarios in [vercel/next.js](https://github.com/vercel/next.js/tree/canary/evals/evals) | Coding agents in a Vercel Sandbox on small Next.js apps; withheld vitest graders plus a build | 28 published | Deterministic, scenario level | Board is pass@4 (`runs: 4, earlyExit: true`); release monitoring is pass@1 with two confirmation reruns | Base against AGENTS.md pointing at bundled docs |
| [get-convex/convex-evals](https://github.com/get-convex/convex-evals) | One-shot backend code generation, deployed to Convex and tested with vitest; no agent loop | 112 in eight categories, plus a 108-question multiple-choice bank | Binary per eval; provider failures count as failures | Mean over N runs with error bars | Guidelines, none, none with web |
| [Stripe](https://github.com/stripe/ai/tree/main/benchmarks) ([post](https://stripe.com/blog/can-ai-agents-build-real-stripe-integrations), 2 March 2026) | A goose agent against live Stripe test mode, with bash, files, computer use and a docs-search MCP | 11 environments, 17 scored rows: migrations, SDK upgrades in .NET, Java and Ruby, full-stack checkout, "gym" sets | Deterministic API and UI tests; partial credit; best run reviewed by a person | Best of three, averaged by category | None |
| [auth0/auth0-evals](https://github.com/auth0/auth0-evals) | Single calls and agent loops (Claude Code, Copilot, Gemini) | 11 product areas | Eight weighted dimensions ([methodology](https://github.com/auth0/auth0-evals/blob/main/docs/SCORING_METHODOLOGY.md)), letter grades | Not stated | Baseline, agent, skills, MCP, both; published only as without against with both |
| [upstash/upstash-mcp-evals](https://github.com/upstash/upstash-mcp-evals) | Seven agent harnesses using the Upstash MCP server against a live account | 15 tasks, 11 on the phase-2 board: ops, config, safety (`delete-prod`), investigate | Pass or fail against live state | 3 runs per cell, as passes over runs | Before and after MCP fixes |
| LangChain [skills-benchmarks](https://github.com/langchain-ai/skills-benchmarks) ([post](https://www.langchain.com/blog/evaluating-skills), 5 March 2026) | Claude Code in Docker | 20 task directories | Test scripts | Not stated | Skills against control |
| Arize ([post](https://arize.com/blog/mcp-vs-cli-skills-for-agents-what-our-eval-found-and-which-you-should-use/), May 2026) | Opus 4.6 using GitHub tools on a fake repository | 25 tasks in four tiers | Judge | 5 runs × 4 arms | GitHub MCP, two `gh` skills, bare shell |
| Microsoft [Scope](https://opensource.microsoft.com/blog/2026/10/19/introducing-scope-open-source-evaluation-for-ai-coding-agents/) (19 October 2026) | Framework for SDKs, CLIs, MCP servers and skills; criteria form a dependency graph | Cosmos DB case: 8 scenarios × 5 languages | Judge against criteria | Not stated | Bare model against Agent Kit |

**Not found:** Neon, Prisma, PostHog, Sentry, Cloudflare, Mastra, Inngest,
Temporal, Twilio, MongoDB, Shopify and Pydantic publish no product-agent
benchmark that a GitHub org search for "eval" turned up. `getsentry/vitest-evals`
is a framework, not a benchmark.

## Published results

| Suite | Latest results |
|---|---|
| supabase | 7 November: Opus 5.5 92.8%, Sonnet 5.5 85.5%, GPT-6.1 Sol 81.2%, GPT-6 Luna 76.8% (mean over three runs) |
| Clerk | [Board](https://clerk.com/llm-leaderboard), 30 September: top average 92%, fifteen models within 86–92%; GPT-6.1 Sol 86.7% baseline, 86.7% MCP, 88.6% skills. Column meanings are unlabelled; the first column was read as the average |
| Next.js | [Board](https://nextjs.org/evals), 30 October: five models at 100% in both arms |
| Convex | [Board](https://www.convex.dev/llm-leaderboard), version `92a60e0b`: Gemini 4 Argon 98.8%, Sonnet 5.5 98.0%, Opus 5.5 97.5% with guidelines; best without guidelines 89.7% (GPT-6 Astra) |
| Stripe | February 2026, older models: Opus 4.5 backend 85%, full-stack 92%, gym 65% |
| Auth0 | [Page](https://auth0.com/agent-experience), October: section averages 85–93% without, 97–98% with MCP and skills |
| Upstash | 24 October: frontier agents 27/33; after the MCP fixes, Opus, Sonnet and Codex went from 67% to 100% |
| LangChain | 82% with skills against 9% without |
| Arize | Correctness 0.834 MCP, 0.826 and 0.833 skills, 0.845 bare shell; tiers one and two at 100% in every arm |
| Scope | One behaviour went from 47% to 100%; 20 Agent Kit and 27 docs issues fixed |

## Saturation, from published data

Reproduce with `python3 .plans/eval-reviews/scripts/external.py <suite>`.

| Suite | How | 9 November |
|---|---|---|
| supabase | `eval-results.json`, 828 rows: 12 experiments × 23 benchmark scenarios × 3 runs | pass@1 mean 82.6%; best of three 252/276 (91.3%); 6/23 passed on every run by every experiment; 14/23 passed by every experiment at best of three |
| Next.js | `agent-results.json`, 16 current-tier experiments | Base 16/28 passed by every current model, AGENTS.md 23/28. Hardest: `agent-048-prefetch-url-data` 8/16, `agent-029-use-cache-directive` 9/16 |
| Convex | Latest single run of each top-ten model, public `runs:leaderboardScores` and `runs:getRunDetails` | With guidelines 92/112 passed by all ten; without 73/112, seven passed by none. One run per model, so noisier than the board's mean |
| Stripe | Results CSV, best of three | 6/17 scored 1.0 by every model; some capped for every model, e.g. `ruby-invoice-partial-payments` at 0.25–0.5 |
| Upstash | `scoreboard.md` | 9/11 passed 3/3 by every frontier agent; the two failures are a missing MCP tool and a safety test, both product gaps |

## How the discriminating ones create difficulty

1. **APIs newer than the training data, and prompts that invite the old one.**
   Vercel's [AGENTS.md post](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)
   says it added evals for Next.js 16 APIs "not in training data". The grader
   for `agent-031-proxy-middleware` says it is "Tricky because agents trained on
   pre-16 data reach for middleware.ts", and its prompt asks for "a Next.js
   middleware". Clerk re-graded to Core 3 (`@clerk/react`, `Show`).
2. **Deliberate hardening.** supabase's CONTRIBUTING requires a failing agent
   and says to harden "with a more ambiguous or misleading prompt, unusual seed
   data, or subtle footgun". Its hardest scenarios (`build-dataapi-001`,
   `build-functions-005`, `investigate-auth-001`,
   `investigate-reliability-003-…-correlation`) bundle several requirements,
   one of them security, or need several signals correlated.
3. **Unprompted choice.** Convex's `choose_*` evals describe a need and check
   the model picks a particular component. That is where its no-guidelines arm
   falls to zero.
4. **Partial credit and long horizons.** Stripe's best runs averaged 63 turns.
   Its own finding matches ours: agents "pass in nonexistent Stripe data,
   observe 400s, and consider the task complete".
5. **Live product gaps.** Upstash tasks failed on a missing tool, logs that did
   not exist and lagging stats, with nothing in the product saying so.

## Treatment arms and what they measured

- **supabase, skills minus no-skills, pass@1 over three runs:** Opus 5.5 +2.9,
  Sonnet 5.5 +8.7, GPT-6 Luna +7.2, GPT-6.1 Sol +2.9, Grok 4.7 −1.5,
  Kimi K3 −2.9. Mixed sign, as ours is.
- **Next.js AGENTS.md:** +0 for every frontier model, up to +32 for older ones
  (Sonnet 4.6 43 → 75). The January post reported 53% baseline, 53% with a
  skill available, 79% with a skill and explicit instructions, 100% with an
  8KB AGENTS.md docs index. The skill went uninvoked in 56% of cases. Attempts
  were "with retries", with no pass@k stated.
- **Convex guidelines:** median +16.7 points across 41 models (range +7.4 to
  +43.3).
- **Clerk:** MCP and skills barely move frontier models.
- **Auth0:** +5 to +27 points, published only with MCP and skills combined.
- **LangChain:** 82% against 9%. Invocation is the bottleneck: one skill was
  never called, a prompt only raised invocation to 70%, and consolidating about
  twenty skills to twelve fixed mis-selection.
- **Arize:** bare shell was the best arm on correctness, and MCP cost more than
  six times as much on tier-four tasks.

## Prompt style

- **Convex writes requirement lists.** Its README asks for the full schema,
  exact function names, argument and return types, and "what NOT to do"; sample
  `TASK.txt` files are bullet specifications.
- **Clerk writes numbered specifications**, for example `auth/machine-tokens`,
  and prefixes every prompt with "Do not ask clarifying questions. Complete the
  task with the information provided." (`src/runners/agents/shared.ts:85`).
- **Vercel writes short task statements.** `agent-031`, `agent-038` and
  `agent-048` on `canary` are one to three sentences each, checked again on
  9 November.

## Unverified

- Stripe's attempts per run beyond "best of three", and its partial credit
  (inferred from fractional scores).
- The Next.js "success" field read as pass@4, from the experiment configs and
  the board's own text ("an eval passes if any of four attempts passes").
- Run counts for Auth0 and Scope, which are not published.
