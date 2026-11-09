# Research agent benchmarks, November 2026

Part of the [November 2026 review](README.md#index). Read on 7 November 2026
from the live leaderboards, posts and papers. Model names are as each board
prints them. Nothing here was reproduced from data; "unverified" marks figures
taken from secondary sources or search snippets rather than the primary page.

**Bottom line.** The benchmarks built on long or expert tasks (Terminal-Bench,
SWE-bench Pro, MCPMark, ITBench, τ³ banking) score frontier agents at roughly
35–65% on a single attempt, and the same models we run fail most tasks
on them. Our 113/114 at best of three sits where Anthropic's guidance puts a
regression suite.

## At a glance

| Benchmark | What, and domain | Tasks | Difficulty comes from | Scoring | Attempts and metric | Latest, top to bottom |
|---|---|---|---|---|---|---|
| SWE-bench Verified | Python repository issues | 500 | Hidden tests | Unit tests, binary | pass@1 | Top rose 74.9% → 80.9% in the six months to February 2026 ([OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)); 96.4% quoted by an aggregator in September, unverified |
| SWE-bench Pro (Scale) | Copyleft public, private startup and held-out repositories | 731 / 276 / 858 | Contamination-resistant sources; under-specified issues kept | Tests, with people checking relevance and flakiness | pass@1, 250-turn cap | Muse Spark 1.1 61.5% → codestral 1.5% ([board](https://labs.scale.com/leaderboard/swe_bench_pro_public)) |
| Terminal-Bench 2.0 / 2.1 | Terminal tasks in Docker | 89 | Real workflows chosen from 229 by difficulty, three-reviewer QA | Tests on final container state, with an oracle solution | Over 32,000 trials across agents and models | 2.0: frontier under 65%, small models about 15% ([paper](https://arxiv.org/abs/2601.11868)); 2.1: GPT-5.3-Codex 79.1% ([post](https://www.tbench.ai/news/terminal-bench-2-1)) |
| Terminal-Bench 3.0 | Seven domains: database snapshots, RTL designs, proofs, CAD | 74 | Expert-authored; judge, agent and "cheating agent" review | Verifier in a separate container | Pass rate | GPT-5.6 Sol 34.4%, Sonnet 5 14.6%, GLM 5.2 5.1% ([post](https://www.tbench.ai/news/terminal-bench-3-0)) |
| Terminal-Bench 4.0 (28 August 2026) | Continuous, versioned | 66 | Drops tasks every model class solves 5/5; eight-hour timeout | As 3.0 | Five trials per task (inferred), with intervals | Opus 5.5 64.8% → Gemini 3.7 Flash 11.2%; Sonnet 5 12.4%, GPT-5.6 Sol 37.3% ([board](https://snorkel.ai/leaderboard/terminal-bench-4-0/)) |
| τ / τ² / τ³-bench (Sierra) | Retail, airline, telecom with dual control, banking with 698 documents, voice | e.g. 97 banking | Simulated user, policy documents, a user who also acts | Final database state against an annotated goal | Introduced pass^k; boards show pass^1 | τ²: Qwen3.5-397B 87.9%; τ³ banking: Qwen 3.8 Max 55.2%, Opus 5 48.7% ([board](https://taubench.com/)) |
| MCPMark | GitHub, Notion, Postgres, Playwright, filesystem over MCP | 127 | Curated start states; three to five expert hours a task | Programmatic verification | Four runs: pass@1, pass@4, pass^4 | gpt-5-medium 52.6 / 68.5 / 33.9; gpt-4.1-nano 0 ([paper](https://arxiv.org/html/2509.24002v1)) |
| MCP-Atlas (Scale) | 36 real MCP servers, 220 tools | 500 public, 500 held out | 5–10 distractor tools a task, no tool names in the prompt, two or more servers, a third branch on earlier results | Judged claims; pass at coverage ≥ 0.75 | Pass rate with intervals | Gemini-4-Argon 90.7, gpt-5.6 (sol) 81.8, gpt-5.4-mini 56.7, haiku-4.5 40.2 ([board](https://labs.scale.com/leaderboard/mcp_atlas), updated April 2026) |
| MCP-Universe (Salesforce) | Six domains | Not stated | Real servers | Evaluators | Success rate | Gemini-3-Pro-Preview 44.6% ([site](https://mcp-universe.github.io/)) |
| MCP-Bench, LiveMCPBench | 28 servers and 250 tools; 70 servers and 527 tools | 104; 95 | Large toolsets | Not verified | — | No current scores found |
| AppWorld | 9 apps, 457 APIs | 750 | Normal and challenge splits | State-based tests that also check for collateral damage | — | GPT-4o about 49% normal, 30% challenge; no current board read ([site](https://appworld.dev/appworld)) |
| ToolSandbox (Apple) | Stateful tools | Not stated | Implicit state dependencies, simulated user, insufficient-information tasks | Milestones | — | Hard for the strongest models ([paper](https://arxiv.org/abs/2408.04682)) |
| BFCL v4 | Function calling | — | — | AST and execution | — | 88.5% quoted by an aggregator, unverified |
| ITBench-AA (IBM, Artificial Analysis) | Kubernetes root-cause analysis on offline incident snapshots | 40 public, 19 held out | Alerts, traces, logs and topology; must name the minimal set of root causes | Any missed cause scores zero; extra guesses cost precision | Three repeats, 100-turn cap | Opus 4.7 47%, GPT-5.5 46%, Gemini 3.1 Pro 30% (27 May 2026) ([post](https://artificialanalysis.ai/articles/itbench-aa-launch)) |
| OpenRCA, OpenRCA 2.0, ORCA-bench | Root-cause analysis over telemetry | 335 (OpenRCA) | Correlating signals | Exact root-cause set | — | 11.34% best; 2.0 about 20.7% exact; ORCA 25.3% medium, 10% hard. From search snippets, unverified |

## Saturation, and how each responded

- **SWE-bench Verified → Pro.** OpenAI stopped reporting Verified on
  23 February 2026 after auditing 138 problems o3 did not solve consistently:
  59.4% had flawed tests or descriptions, and every frontier model it
  red-teamed could reproduce some gold patches. It now recommends Pro.
- **Terminal-Bench 1 → 4.** 2.0 replaced poor verification and flaky tasks
  ([post](https://www.tbench.ai/news/announcement-2-0)); 2.1 fixed 28 of 89
  tasks; 3.0's stated reason was that "many tasks saturated, scores clustered
  in a narrow range", and the gap between two Claude models widened from 4.9 to
  12.7 points. 4.0 makes saturation a rule: a task every model class solves
  5/5 is removed ([post](https://www.tbench.ai/news/terminal-bench-4-0)).
- **τ-bench.** A February 2026 audit fixed more than fifty retail and airline
  tasks for wrong expected actions, ambiguous instructions and impossible
  constraints. A September 2026 paper finds ambiguous policies read as agent
  error and make every model less consistent across trials
  ([arXiv 2609.14400](https://arxiv.org/abs/2609.14400)).

## Metrics

- **Anthropic** ([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
  9 January 2026): pass@k suits tools where one success is enough; pass^k suits
  agents that must be consistent, and 75% per trial is about 42% at pass^3.
  Capability evals should start at a low pass rate; regression evals sit near
  100%, and capability tasks graduate into them once they pass reliably.
- **MCPMark shows the size of the gap**: 68.5% at pass@4 against 33.9% at
  pass^4 for one model.
- **Best of three with stop-on-pass is pass@3** and cannot produce pass^k,
  because passing cells never get another attempt.

## Silent failure and false success

- **MCPMark:** failures where the task looks finished and fails verification
  are the majority of errors, often over half, and over 80% for gpt-5-high.
- **False success** is 45–48% of failures in single-control τ² domains, 3% in
  dual-control telecom and 75.8% of AppWorld traces that make status claims.
  LLM judges detect it at AUROC ≤ 0.65; keyword-weighting detectors reach
  0.83–0.95 ([arXiv 2606.09863](https://arxiv.org/abs/2606.09863)).
- **27–78% of τ-bench's reported successes hide policy violations**
  ([arXiv 2603.03116](https://arxiv.org/abs/2603.03116)). From a search
  snippet; the paper was not read.
- **ImpossibleBench** mutates tests so they conflict with the specification,
  making any pass a cheat; offering an "abort and flag for a person" option cut
  cheating sharply ([arXiv 2510.20270](https://arxiv.org/pdf/2510.20270)). The
  specific rates come from secondary summaries and are unverified.

## Validity: is the task solvable and the scorer right

- **Agentic Benchmark Checklist** (NeurIPS 2025): in τ-bench an agent returning
  empty responses passes the impossible-by-design tasks; flaws like this can
  misstate performance by up to 100% in relative terms
  ([arXiv 2507.02825](https://arxiv.org/abs/2507.02825)).
- **Terminal-Bench 3 and 4:** an oracle solution and a cheating-agent run for
  every task, a verifier in its own container, and community reports triaged as
  true or false positives.
- **MCPMark:** experts mutate the final state to confirm the verifier detects
  both success and failure; tasks no model solved got extra verification.
- **Anthropic:** every task needs a reference solution, and a 0% pass rate "is
  most often a signal of a broken task". Opus 4.5 went from 42% to 95% on
  CORE-Bench once grading and harness bugs were fixed.
- **OpenRCA critique:** some labelled root causes cannot be recovered from the
  telemetry at all
  ([Traversal](https://www.traversal.com/blog/openrca-isnt-root-cause-analysis-why-that-matters)).

## Harness errors against agent failures

- **Infrastructure noise** ([Anthropic](https://www.anthropic.com/engineering/infrastructure-noise),
  5 February 2026): container resources alone moved Terminal-Bench 2.0 by six
  points; infrastructure error rate was 5.8% at 1× resources and 2.1% at 3×. Be
  sceptical of gaps under three points, and run across times of day and days.
- **MCP-Atlas** keeps real API errors rather than mocking them, and in April
  2026 added retry handling for transient tool errors and re-scored every model.
- **Epoch** excludes sixteen SWE-bench Verified samples that do not run reliably
  on its infrastructure ([Epoch](https://epoch.ai/benchmarks/swe-bench-verified)).
- **Terminal-Bench 4.0** reports remaining errors (refusals, output limits) as
  their own category rather than folding them into the score.

## Levers we do not use yet

Distractors and no product hints in the prompt (MCP-Atlas); a minimal-set answer
with a precision penalty (ITBench); correlation across noisy signals (the
root-cause benchmarks); impossible or abort-worthy tasks (ImpossibleBench,
τ-bench); a simulated user who also acts (τ²); held-out task sets.

## Unverified

- SWE-bench Verified and Pro top scores from aggregators.
- BFCL v4, ImpossibleBench and AIOpsLab figures, and current scores for
  MCP-Bench and LiveMCPBench.
- Terminal-Bench 4.0 trials per task, inferred from "171/330".
