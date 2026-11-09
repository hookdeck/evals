# Are the scenarios hard enough? Research, November 2026

Research done on 7 November 2026 against the v0.5.0 snapshot (114 rows, six
experiments, nineteen benchmark scenarios). It asked one question: do frontier
agents pass our scenarios because the scenarios are easy, or because Hookdeck's
docs and skills are good? The issues it produced carry the work; this file
carries the evidence, so the question does not have to be re-researched from
scratch the next time a snapshot reads near the ceiling.

Figures marked *survey* come from other projects' published pages and files,
read on 7 November and not re-derived here. Everything about this repository can
be recomputed with the snippets at the end.

## The answer

**Mostly easy scenarios, then a metric that hides what failure is left.**

1. **Docs do not carry most frontier passes.** In v0.5.0,
   `claude-code-sonnet-5-no-skills` passed eight of nineteen scenarios on the
   first attempt with zero docs fetches: `delivery-001`, `delivery-002`,
   `investigate-001`, `investigate-002`, `localdev-001`, `resolve-001`,
   `resolve-002`, `transform-001`. Zero fetches is not zero outside
   information — `--help` and API errors teach too — and Codex rows are not
   usable for this because its search hits never reach us (#83).
2. **Skills do not carry them either.** First-attempt passes with and without
   skills: Claude Code 18 and 18, GPT-5.6 17 and 18.
3. **Frontier first-attempt pass rate is about 93%.** Pooled across every
   published run except 13 August, 420 of 454 frontier first attempts passed,
   and 247 of 310 for the weak model. Those include harness-defect periods, so
   they understate the agents.
4. **The models are not the ceiling.** *Survey:* the same models score Sonnet 5
   12.4% and GPT-5.6 Sol 37.3% on Terminal-Bench 4.0
   ([board](https://snorkel.ai/leaderboard/terminal-bench-4-0/)), and
   GPT-5.4-mini 56.7% on MCP-Atlas
   ([board](https://labs.scale.com/leaderboard/mcp_atlas)).
5. **Where docs and skills do show, it is Outpost, long-tail providers and
   capability questions.** Every no-skills Claude Code pass on an Outpost
   scenario read two to nine docs pages, and the `ELEVENLABS` source type is
   what the skill supplies in `verification-002`.

So AGENTS.md's own conclusion survives contact with the wider field: signal
comes from scenarios where an agent can finish confidently and be wrong. The
suite simply has few of them.

## Our numbers on the same footing as others

| Measure | Hookdeck v0.5.0 | supabase/evals, 7 Nov | Like for like? |
|---|---|---|---|
| Cells passing at best of three | 113/114 (99.1%) | 252/276 (91.3%) | Yes |
| Scenarios passed by every experiment at best of three | 18/19 | 14/23 | Mostly; they run twelve experiments to our six |
| Scenarios passed by every experiment on every attempt | not computable | 6/23 | No: stop-on-pass never re-runs a passing cell |
| Single-attempt pass rate | 102/114 (89.5%), one draw per cell | 82.6%, mean of three runs | Roughly |
| Scenarios with a failing agent on one attempt | 9/19 on 28 Sep, 6/19 in v0.5.0 | 13/23 on run 1 | Roughly; same experiment-count caveat |
| Unit of score | AND of checks | AND of checks | Yes |

The supabase figures were recomputed from their published
`apps/web/src/data/eval-results.json` (828 rows, three runs per cell).

**Best of three is pass@3**, the most generous of the three metrics in use.
Anthropic's guidance puts a capability suite at a low pass rate and a regression
suite near 100%
([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents));
113/114 is the second.

## Vendor benchmarks

*Survey.*

| Suite | Scenarios | Metric | Saturation | Treatment delta |
|---|---|---|---|---|
| [supabase/evals](https://github.com/supabase/evals) | 23 benchmark | Passed runs over all runs, three per cell | 14/23 passed by all twelve experiments at best of three | Skills −2.9 to +8.7 by model, mixed sign |
| [Next.js evals](https://nextjs.org/evals) | 28 | pass@4 | 16/28 passed by every current model, 23/28 with AGENTS.md | AGENTS.md +0 for frontier, up to +32 for older models |
| [Convex](https://www.convex.dev/llm-leaderboard) | 112 | Mean over N runs with error bars | 93/112 passed by the top ten with guidelines, 74/112 without | Guidelines, median +16.7 points |
| [Clerk](https://clerk.com/llm-leaderboard) | 37, mostly one-shot codegen | Partial credit | Fifteen models within 86–92% | MCP and skills barely move frontier models |
| [Stripe](https://github.com/stripe/ai/tree/main/benchmarks) | 17 | Best of three, partial credit | 6/17 at 1.0 for every model | None |
| [Upstash](https://github.com/upstash/upstash-mcp-evals) | 11 | Passes out of three runs | 9/11 at 3/3 for every frontier agent | Before and after MCP fixes |

How the ones that still discriminate create difficulty:

- **Bait from training data.** Next.js 16 renamed middleware, and `agent-031`
  asks for "a Next.js middleware" so the old file is the trap. Clerk re-graded to
  its Core 3 APIs.
- **Several requirements, one of them security, or several signals correlated.**
  supabase's hardest are `build-dataapi-001`, `build-functions-005`,
  `investigate-auth-001` and an `investigate-reliability-…-correlation`.
- **An unprompted choice.** Convex's `choose_*` evals describe a need and check
  the model picks the right component; that is where its no-guidelines arm falls
  to zero.
- **Long horizon.** Stripe's best runs averaged 63 turns, and its own finding is
  ours: agents pass nonexistent data, see a 400 and call the task complete.

**Prompt style.** Convex writes prompts as requirement lists and Clerk's are
numbered specs with the same "do not ask clarifying questions" line we borrowed.
Vercel's current Next.js prompts are one-to-three-sentence task statements, not
requirement lists (checked: `agent-031`, `agent-038`, `agent-048` on `canary`).

## Research benchmarks

*Survey.*

| Benchmark | Difficulty comes from | Metric | Frontier range |
|---|---|---|---|
| [Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0) | Expert tasks, eight-hour timeout; tasks every model class solves 5/5 are dropped | Pass rate over five trials | Opus 5.5 64.8% to Gemini 3.7 Flash 11.2% |
| [τ³-bench](https://taubench.com/) | Policy documents, a simulated user who also acts | pass^k introduced; boards show pass^1 | Banking: 55.2% top |
| [MCPMark](https://arxiv.org/html/2509.24002v1) | Curated start states, three to five expert hours a task | pass@1, pass@4, pass^4 | gpt-5-medium 52.6 / 68.5 / 33.9 |
| [MCP-Atlas](https://labs.scale.com/leaderboard/mcp_atlas) | Distractor tools, no tool names in the prompt | Claim coverage ≥ 0.75 | 90.7 to 40.2 |
| [ITBench-AA](https://artificialanalysis.ai/articles/itbench-aa-launch) | Kubernetes incidents with alerts, traces, logs; credit only for the full minimal root-cause set | Three repeats | 47% top |
| [SWE-bench Pro](https://labs.scale.com/leaderboard/swe_bench_pro_public) | Contamination-resistant repos | pass@1 | 61.5% top |

Findings that bear on this repository:

- **False success is most of the failure.** MCPMark's "implicit failures", where
  the task looks finished and is not, are the majority of errors. LLM judges
  detect a false success claim at AUROC ≤ 0.65
  ([arXiv 2606.09863](https://arxiv.org/abs/2606.09863)), which supports scoring
  state over judging reports.
- **Saturation is handled by rule, not argument.** Terminal-Bench 4.0 drops a
  task once every model class solves it five times in five. SWE-bench Verified
  was retired by OpenAI after an audit found flawed tasks
  ([post](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)).
- **pass@k and pass^k diverge most on agents.** Stop-on-pass gives pass@k and
  cannot give pass^k.
- **Validity work matches ours.** Reference solutions, a verifier separate from
  the agent, and infrastructure errors reported apart from agent failure.
  Anthropic measured container resources alone moving Terminal-Bench 2.0 by six
  points ([post](https://www.anthropic.com/engineering/infrastructure-noise)).

## Our nineteen scenarios by what makes them hard

Mechanisms: **L** one lookup, **B** multi-step build, **S** a silent failure
that is scored, **P** a plausible wrong answer from memory, **C** several
signals held together, **A** scope judgement. History is first-attempt passes
over observations since 14 August, as Claude Code / GPT-5.6 / GPT-5.4-mini.

| Scenario | Stage | Mechanism | History | Treatment |
|---|---|---|---|---|
| `verification-001-stripe-express` | build | C, S | 8/13 · 11/15 · 11/18 | Keep |
| `verification-002-elevenlabs-callbacks` | build | P, S | 11/11 · 4/13 · 5/16 | Keep |
| `filtering-001-enterprise-orders` | build | P, B | 10/10 · 12/12 · 11/16 | Keep, weak-model floor |
| `filtering-002-high-value-retries` | build | B, S | 10/10 · 11/12 · 9/16 | Keep |
| `transform-001-reshape-payload` | build | B, S on one shape | 10/10 · 12/12 · 12/16 | Keep |
| `alerting-001-delivery-alerts` | build | L as scored, S in reality | 13/14 · 14/16 · 17/20 | Score the outcome (#128) |
| `localdev-001-listen-locally` | build | B | 9/11 · 12/13 · 15/16 | Floor |
| `outpost-001-customer-subscriptions` | build | B, product confusion | 13/14 · 13/14 · 10/18 | Floor |
| `outpost-002-disabled-destination` | resolve | B, ordered | 11/11 · 11/11 · 9/14 | Floor |
| `outpost-003-operator-events` | build | Route guessing | 11/13 · 13/13 · 13/16 | Recast once #34 lands |
| `outpost-004-queue-destination` | build | B | 13/13 · 13/13 · 13/16 | Floor |
| `outpost-005-topic-scoping` | resolve | A, defeated by API shape | 11/11 · 11/11 · 13/14 | Redesign (#47) |
| `dedupe-001-duplicate-events` | build | L, S not probed | 10/10 · 12/12 · 16/16 | Harden (#47) |
| `delivery-001-slow-consumer` | build | L, answer in prompt | 10/10 · 12/12 · 16/16 | Harden or graduate (#47) |
| `delivery-002-rate-limited-endpoint` | build | L | 10/10 · 12/12 · 15/16 | Graduate |
| `investigate-001-failing-deliveries` | investigate | L in tiny state | 11/12 · 13/14 · 16/18 | Replace |
| `investigate-002-partial-outage` | investigate | L | 9/10 · 12/12 · 15/16 | Harden (#47) |
| `resolve-001-paused-connection` | resolve | L | 10/10 · 11/12 · 15/16 | Graduate |
| `resolve-002-scoped-redelivery` | resolve | A in tiny state | 9/10 · 12/12 · 16/16 | Harden with noise |

Totals: seven lookup-shaped as scored, six multi-step builds, four with a scored
silent failure, two with a wrong answer from memory, one needing correlation.
**None** needs investigation of noisy state, a long horizon, resistance to a
wrong approach named in the prompt, or care around a destructive action. The
investigate scenarios seed three to five resources and seven to twelve events,
so the fault is the only anomaly in the project.

## What the field covers that we do not

| Category | Who does it | Ours |
|---|---|---|
| Investigation of noisy state with distractors | ITBench, OpenRCA, Upstash | None |
| Several causes, credit only for all of them | supabase, ITBench | `verification-001` only |
| A wrong approach named in the prompt | Next.js, Clerk | None |
| An unprompted capability choice | Convex | `filtering-001`, partly |
| Collateral damage and destructive actions | AppWorld, Upstash | Negative checks in two scenarios |
| Long horizon | Stripe, Terminal-Bench | None |
| The environment changing mid-run | τ² | None; #129 adds the hook |
| Consistency, pass^k | τ-bench, MCPMark | Not measurable under stop-on-pass |

## Decisions taken from this

- **Metric.** Publish the first-attempt figure beside best of three, and run
  release matrices at three attempts per cell without stop-on-pass, publishing
  pass@1 (mean of three), pass@3 and pass^3. Selecting only the cells that have
  discriminated would bias the sample towards them and mix two sampling
  schemes in one snapshot. Stop-on-pass stays for loop re-runs and scenario
  probes, where the question is whether anything passes.
- **Diagnosis.** A closed-book diagnostic arm, not a published row, separates
  "answerable from memory" from "carried by our docs".
- **Saturation.** A scenario every arm passes on the first attempt in three
  consecutive matrices graduates to the regression suite.
- **New scenarios** target the empty categories above, and each is probed on the
  weak model and one frontier arm before admission, per CONTRIBUTING.

The issues carrying these are linked from the v0.6.0 section of #24.

## Unverified

- SWE-bench Verified top scores quoted by aggregators; BFCL v4; ImpossibleBench
  and AIOpsLab figures; trials per task on Terminal-Bench 4.0 (inferred).
- Stripe's attempt count beyond "best of three", and its partial credit
  (inferred from fractional scores).
- Convex saturation is from one run per model, noisier than its leaderboard mean.
- The cost of a three-attempt matrix without stop-on-pass is scaled from the
  per-pass figures in AGENTS.md, not measured.

## Recomputing our figures

First attempt against best of three, per scenario, from any snapshot:

```bash
python3 -c "
import json
from collections import defaultdict
rows=json.load(open('results/latest.json'))['results']
m=defaultdict(lambda:[0,0,0])
for r in rows:
    m[r['eval']][0]+=1
    m[r['eval']][1]+=r['passed'] and r['attempts']==1
    m[r['eval']][2]+=r['passed']
for e in sorted(m): print(e, 'first', m[e][1], 'best', m[e][2], 'of', m[e][0])
"
```

No-skills Claude Code first-attempt passes with no docs fetched:

```bash
python3 -c "
import json
for r in json.load(open('results/latest.json'))['results']:
    if r['experiment']=='claude-code-sonnet-5-no-skills' and r['passed'] and r['attempts']==1 and not r['docs'].get('calls'):
        print(r['eval'])
"
```
