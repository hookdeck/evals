# Contributing

Read [README.md](README.md) for repo concepts and instructions for running evals locally.

## Adding an eval

First, determine the eval suite for your scenario:

- **Regression** evals are suitable for most scenarios. If we notice agents make a narrow mistake, we track it here to reproduce the issue, verify a fix, and monitor for regression. These scenarios are not included in the benchmark so they don't inflate scores.
- **Benchmark** evals are scenarios we've intentionally selected for the published benchmark report. These should be representative of the user journey on Hookdeck and cover a breadth of dimensions.

Then add a folder under `evals/` containing:

1. `PROMPT.md` with frontmatter metadata and the task the agent sees.
2. `EVAL.ts` with the scorer.
3. Optional `remote/` data when the scenario needs to seed hosted project state: sources, connections, destinations, published events, or an Outpost tenant.
4. Optional `local/` files when the scenario needs to seed a workspace on disk, such as the service an agent is asked to receive webhooks into. `${VAR}` in these files expands from the run environment, so a scenario can carry a credential without hardcoding one.

If your scenario contains anything not self-explanatory, consider adding a `README.md` to the folder with a brief explanation of how it's set up and what it's testing.

## Eval criteria

Every new scenario needs a `motivation:` in its `PROMPT.md` frontmatter citing
evidence that developers actually attempt this, ideally a pain point: a support
ticket, a GitHub issue, or a community thread.

**Motivations are published.** Write them so they carry the evidence without
disclosing anything: no internal tool names, no customer names or identifying
detail, no internal ticket URLs. "Support ticket, June 2026. An assistant
described a filtering capability that does not exist" is enough. If a scenario
needs internal context to be understood, that belongs in a comment in `EVAL.ts`,
not in the published frontmatter.

For new **benchmark** scenarios, we need to see at least one agent, ideally more,
failing the new scenario to ensure we're getting signal from results. If agents
are already acing your scenario, consider hardening it with a more ambiguous or
misleading prompt, unusual seed data, or a subtle footgun. Run locally and review
agent failures to ensure they're legitimate reasoning mistakes, not eval
framework limitations.

Regression scenarios are different: they guard against a mistake we have already
seen and fixed, so all agents passing is the expected and desired state. Their
value is catching it coming back.

### Check a scenario against these criteria before proposing it

```bash
pnpm --filter @hookdeck-evals/framework scenario-criteria
```

Reports, per benchmark scenario, whether its motivation carries a citation and
whether any agent has ever failed it, plus what the suite currently covers by
product and stage. **A new benchmark scenario should appear clean in this report
before it is proposed.**

Both rules above were written down before the first scenario existed and neither
was checked until 29 August, by which point no motivation carried a citation and
five scenarios had entered the published benchmark without any agent ever having
failed them. A convention nothing reports on is a convention that gets skipped.

The report does not gate the build. Retro-fitting citations onto scenarios whose
origin nobody can now reconstruct is not work a script should force, and a red
build for unreachable history teaches people to disable the check.

### Where scenarios come from

In rough order of how well they have worked:

1. **Transcripts of runs we have already paid for.** `triage` names the cells
   worth reading; every product finding this benchmark has produced came from
   one. A mistake an agent actually made needs no argument that it is realistic.
2. **Support tickets and recurring support patterns.** Cite them in the
   published form — "Support ticket, June 2026" and what went wrong — never an
   internal URL or a customer name.
3. **The troubleshooting pages of our own docs.** A troubleshooting page exists
   because people hit that problem often enough to write it down, which makes it
   a pre-validated list of failure modes.
4. **GitHub issues** on the CLI, the SDKs and this repository.
5. **A coverage gap**, when the report above shows one. Weakest of the five on
   its own: a scenario written to fill a cell in a matrix has nothing behind it
   saying anyone gets this wrong, which is how four Outpost scenarios came to be
   passed by every agent. Pair it with one of the sources above.

## Writing prompts

Prompts should reflect what a real user would send to an agent. Prompts should NOT reflect deep familiarity with Hookdeck nor specify every detail of a request, as users should expect agents to fill in the gaps themselves. They should be short and casual messages, not highly formatted specs.

Instead of spoonfeeding agents in the prompt, move details into seed data to let agents discover context and infer user intent. For example, a seeded connection can help agents resolve the true names of sources and destinations or a project's naming conventions, a seeded handler can provide a template for desired functionality, and inline comments can help explain a project's structure beyond what the code shows.

## Writing scorers

Prefer deterministic checks where possible for stability and efficiency. Avoid being overly prescriptive with the process an agent takes to reach a solution (unless critical to the scenario), prefer checking the end state by inspecting the project or filesystem.

If deterministic checks are too inflexible or convoluted, use an LLM-as-a-judge check via `judge()` to check semantic correctness.

Prefer building checks declaratively and returning the list in one place instead of accumulating checks within branching logic, so the list remains stable if one path fails.

## Adding an experiment

Add a file under `experiments/` for the agent, model, and runtime setup you want to compare. Here you can configure which skills and MCP servers are available.

Select the experiment's `suite:` depending on your use case. If this experiment should be part of our published benchmark, assign `suite: ["benchmark"]` and include a corresponding `*-no-skills` variant to compare results with and without skills. You can also assign custom experiment suites for grouping related experiments for other head-to-head comparisons as desired.

## Submitting evals for review

Before submitting an eval for review, try running it locally to sanity check that it can complete without errors. It's okay if agents fail the eval, we just don't want them to be scored unfairly for framework limitations.

When you create a PR, use GitHub Actions to refresh the results in CI so we can verify the results in a trusted environment. Currently, results are tracked in Git and committed to the repo, so the refresh results workflow can either commit result changes directly to a branch or generate a PR to propose the change.

You have two options to run evals in CI:

- Dispatch the [Refresh eval results](https://github.com/hookdeck/evals/actions/workflows/eval-refresh.yml) workflow manually, choosing specific evals, experiments, suites and a number of attempts. It commits results to the branch you dispatch it against.
- Run `score-only` locally, which exercises a scorer against real project state for the price of some API calls rather than the price of agents. Use it for any scorer change; it is the cheapest way to tell a scorer defect from an agent one, and most red cells in this repository's history have been the former.

The PR labels upstream uses (`run-evals`, `run-evals-changed`) are not wired up here.

Include refreshed results for PRs with new/changed evals so a reviewer can see results directly from your PR or Vercel preview build.
