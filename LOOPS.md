# Improvement loops

What the benchmark found, what was changed because of it, and whether the change
worked.

A loop is only worth recording if it closes: a finding, one attributable change, and a
re-run that says what the change bought. A finding without a re-run is an issue, not a
loop, and belongs in [GitHub Issues](https://github.com/hookdeck/evals/issues).

## How a loop runs

1. **Pin the before.** Note the scenario, the experiments, the failing checks and the
   run that produced them. Results are immutable per run in `results/runs/`, so the
   before-state stays checkable after `latest.json` moves on.
2. **Read the transcript**, not the check name. The raw artifacts carry what the agent
   actually did; the published row only carries whether it passed. This is where the
   cause comes from, and it is why artifacts are kept for 90 days.
3. **Change one thing in one place.** A docs page, a skill, the CLI, an MCP tool
   description. One change, or the delta is not attributable to anything.
4. **Re-run the same scenarios and experiments** with at least three attempts, so a
   fix is distinguishable from variance. A run dispatched at the default single
   attempt cannot do this, so ask for three.
5. **Record it below**, including when the change did not work. A loop that failed is
   more informative than one that succeeded, and hiding it makes the rest less
   believable.

**The fix has to be to the product, the docs or the skills.** Changing the scenario so
it passes proves nothing, and is the one move this file exists to make visible.

---

## Loop 1: the CLI was not safe to run without a terminal

**Status:** closed. No measurable improvement; the failures were variance.

### What the benchmark found

Two failures, months apart in symptom and identical in cause.

A weak model reported success having configured everything inside a temporary guest
project rather than the user's. Later, in
`verification-001-stripe-express`, a weak model given the `event-gateway` skill hit
the same wall and stopped:

> "I also tried Hookdeck CLI account access, but the provided API key failed
> authentication in this sandbox, so I left the local `hookdeck listen` setup
> documented rather than creating cloud resources here."

It created nothing in the project. The same model without the skill read the
documentation, found the REST API, and passed.

### The cause

At the pinned CLI version (2.3.1), `hookdeck listen` did not read `HOOKDECK_API_KEY`
at all. Without a prior `hookdeck ci`, the CLI created a temporary guest account and
carried on. The failure was silent: commands appeared to work, against a project with
no delivery history, retries or issue triggers.

Upstream framed the class precisely, in
[hookdeck-cli#340](https://github.com/hookdeck/hookdeck-cli/issues/340): *the CLI
silently does something other than what the caller asked, and the first symptom is
missing traffic rather than an error.*

### The change

CLI 2.5.0 ([hookdeck-cli#342](https://github.com/hookdeck/hookdeck-cli/pull/342))
closed nine issues under that epic, including
[#334](https://github.com/hookdeck/hookdeck-cli/issues/334), "listen ignores
HOOKDECK_API_KEY and silently creates a guest account". The sandbox pin moved from
2.3.1 to 2.5.0.

The skill gap is a **separate** change, deliberately not made at the same time:
[agent-skills#27](https://github.com/hookdeck/agent-skills/pull/27) documents
`hookdeck ci`, which the skill never mentioned. It is held until this loop closes, so
the two deltas stay attributable.

### Before

CLI 2.3.1, one attempt per pair.

| Scenario | CC+ | CC- | 5.6+ | 5.6- | mini+ | mini- | |
|---|---|---|---|---|---|---|---|
| `localdev-001-listen-locally` | pass | pass | pass | pass | pass | pass | 6/6 |
| `verification-001-stripe-express` | pass | pass | pass | pass | **fail** | pass | 5/6 |
| `verification-002-elevenlabs-callbacks` | pass | pass | **fail** | **fail** | **fail** | pass | 3/6 |

Headroom is four cells of eighteen. `localdev-001` is already at ceiling, so it can
only regress here, which makes it the useful control.

### After

Two runs, both three attempts per pair. One on the new CLI, one on the old, so the
CLI is the only difference between them.

| Scenario | Original, 1 attempt, 2.3.1 | 3 attempts, **2.3.1** | 3 attempts, **2.5.0** |
|---|---|---|---|
| `localdev-001-listen-locally` | 6/6 | not re-run | 6/6 |
| `verification-001-stripe-express` | 5/6 | 5/6 | 5/6 |
| `verification-002-elevenlabs-callbacks` | 3/6 | **6/6** | **6/6** |

Runs: [31809988720](https://github.com/hookdeck/evals/actions/runs/31809988720) on
2.5.0, [31819501415](https://github.com/hookdeck/evals/actions/runs/31819501415) on
2.3.1.

### What it bought

**Nothing this benchmark can measure.** Every failure the CLI fix was supposed to
address recovers on the old CLI too, once the scenario is run more than once.

The four cells that failed originally:

| Cell | On old CLI, 3 attempts |
|---|---|
| `verification-001` x `mini+` | passes, attempt 1 |
| `verification-002` x `5.6+` | passes, attempt 1 |
| `verification-002` x `5.6-` | passes, attempt 2 |
| `verification-002` x `mini+` | passes, attempt 1 |

The prediction recorded before the run was that two of these were the CLI and two were
variance. All four were variance.

**`verification-001` is worse than flaky, it is unstable.** It scores 5/6 on both CLI
versions with a *different* cell failing each time, and a third culprit in the
original run. Three runs, three different "failing models", one scenario. Both
failures are `attempts=3`, so the agent tried three times and failed all three: this
does not average out at n=3. Tracked as #14.

### What this loop actually found

The change was right and the evidence for it was not. The CLI defect is real,
documented upstream at
[hookdeck-cli#340](https://github.com/hookdeck/hookdeck-cli/issues/340), and worth
fixing on its own terms: an agent operating inside a guest project while reporting
success is a genuine product problem, and one this benchmark surfaced.

What this benchmark cannot do is show that fixing it improved anything, because the
failures used to justify the loop were manufactured by single-attempt measurement.
The transcript that made the case, an agent reporting that its API key failed
authentication, was one attempt out of a distribution nobody had sampled.

Three consequences, all more useful than the improvement would have been:

1. **Single-attempt results are not evidence.** Every conclusion drawn from a
   single-attempt run before 14 August is suspect, including the skills delta in #2
   and the Codex concentration in #4. The scheduled matrices went on running at
   `runs=1` until 28 September, the last before the benchmark came off the schedule,
   so the same applies to every September delta.
2. **The published page presents single attempts as settled results.** Every
   published snapshot so far came from `runs=1`, on a page comparing named
   vendors. #14.
3. **A loop needs its control run.** The isolation run cost about $5 and half an hour,
   and it is the only reason this entry says "variance" rather than "the CLI fix
   worked".

The skill change ([agent-skills#27](https://github.com/hookdeck/agent-skills/pull/27))
is unaffected in substance: the skill genuinely never documented `hookdeck ci`. But it
cannot be justified by these four failures either, and needs its own controlled
measurement before being called a fix.

**Status: closed, no measurable improvement.**

---

## Loop 2: the harness never told agents the Outpost project existed

**Status:** closed. The measured skills win was our own defect; the real delta is
about a tenth of what the first run claimed.

### What the benchmark found

Four Outpost scenarios were run across six experiments on 21 August. The result was
stark: **`+skills` 9, `-no-skills` 0**. Every cell with skills passed; every cell
without failed. It read as the clearest evidence yet that the Hookdeck skills earn
their place, and it was hours from being published as exactly that.

Reading the transcripts said otherwise. Across the twelve baseline cells,
`OUTPOST_API_KEY` was used as a credential **zero times**. Nine of the twelve agents
reported *success* — having built the task on `api.hookdeck.com`, in the wrong product
entirely. Two reported, with authority, that the harness had handed them the wrong
credential.

The cause was one sentence of ours. The prompt addendum told every agent:

> You have a Hookdeck project. The Hookdeck CLI is installed and `HOOKDECK_API_KEY` is
> set in your environment, so both the CLI and the REST API are available to you.

It named one project and silently injected a second. The only artefact in the sandbox
that named `OUTPOST_API_KEY` was the Outpost skill's own reference files — so "skills
help" and "we forgot to mention a credential" were the same measurement, and nothing
in the scoreboard could tell them apart.

### The change

The addendum now names the Outpost project when a scenario uses one, gated on the
scenario's seed rather than on the machine having a key. The `+skills` arm also
receives the `outpost` skill, which no experiment had ever loaded — Outpost scenarios
were being given `event-gateway`, whose only Outpost content is a line telling the
agent to go elsewhere.

### What it bought

The same 24 cells, re-run: **`+skills` 12/12, `-no-skills` 10/12.** A delta of **2
cells in 24**, in different models on different scenarios, against 9–0 before.

A later 30-cell run put it closer still: 28/30 overall, with one skills-arm failure
being an agent that asked for confirmation rather than one that could not do the task.

**Roughly seven of the original nine cells were measuring our own omission.**

### What it cost to learn, and why it nearly was not

Three independent reviews were run against the first result. Two concluded the harness
was sound and the 0/12 was genuine — and they were right about the harness. It took a
third, instructed specifically to *refute the interpretation* rather than check the
mechanism, to find that the skill was the only thing naming the variable.

Had only the first two run, this would have shipped.

Three consequences:

1. **Assume most of an apparent skills win is our own instrument until proven
   otherwise.** This is the second loop in a row where a striking result dissolved
   under a control.
2. **A review that checks whether a result is *real* is not the same as one that
   checks whether it means what you think.** Only the adversarial framing found it.
3. **Every product finding in this period came from a transcript; none came from the
   scoreboard.** A pass rate cannot distinguish "the agent could not" from "we misled
   it". `pnpm --filter @hookdeck-evals/framework triage` now flags the cells worth
   reading, because the convention alone kept being skipped — including by whoever
   wrote it down.

**Status: closed. The instrument was wrong, the correction is measured, and the
corrected delta is small enough that it should not be published as a headline.**

---

## Loop 3: the skill never said how to authenticate the CLI without a terminal

**Status:** closed. Agents with the skill now authenticate first instead of after an
error. No score moved that this can be credited with.

### What the benchmark found

This is the skill half of Loop 1, held back so the two changes stayed separately
attributable. The `event-gateway` skill never mentioned `hookdeck ci`, the command that
authenticates the CLI from `HOOKDECK_API_KEY` without a browser. The transcript that
raised it was the weak model in Loop 1 deciding its API key had been rejected and
leaving `hookdeck listen` documented rather than set up. Loop 1 then showed that
particular failure was variance, so the skill change needed a measurement of its own.

The question in #27 was whether documenting `hookdeck ci` stops agents giving up on CLI
authentication.

### The change

[agent-skills#27](https://github.com/hookdeck/agent-skills/pull/27), merged 19 August,
adds an "Authenticating without a browser" section to the `event-gateway` skill: run
`hookdeck ci`, then `hookdeck whoami`. It reached no run until #102 moved the skills pin
from `6ea10a4` to `84e59f4` on 5 November.

The same pin move carried two other upstream changes:
[agent-skills#28](https://github.com/hookdeck/agent-skills/pull/28), which is Loop 4,
and [agent-skills#29](https://github.com/hookdeck/agent-skills/pull/29), on rule order
and API versions. Neither touches CLI authentication, and the `hookdeck` router skill
is byte-identical across the move.

### Before and after

Before is 28 September,
[run 36386178039](https://github.com/hookdeck/evals/actions/runs/36386178039): scheduled,
`runs=1`, old pin. Only the weak model's `-no-skills` twin ran that day; the other two
were carried from 1 September. September's raw results also keep no superseded
attempts, which only matters for `outpost-003`. After is Claude Code from
[run 42044644850](https://github.com/hookdeck/evals/actions/runs/42044644850) on
5 November and Codex from
[run 42220222687](https://github.com/hookdeck/evals/actions/runs/42220222687) on
6 November, both `--runs 3`. Codex comes from the second run because its login shells
could not find the pinned CLI in the first (#114).

Counted per attempt, superseded attempts included: of the attempts that called the
`hookdeck` CLI for anything other than help or a version, how many made `hookdeck ci`
the first such call.

| Arm | 28 September | 5–6 November |
|---|---|---|
| `claude-code-sonnet-5` | 0/17 | 14/18 |
| `codex-gpt-5.6` | 0/14 | 17/18 |
| `codex-gpt-5.4-mini` | 0/16 | 17/21 |
| `-no-skills`, same order | –, –, 0/4 | 0/18, 0/20, 0/26 |

The counts depend on what is parsed as a CLI call and move by one or two with it. The
direction does not.

### What it bought

**The order changed, and that is the measured effect.** In the skills arms, attempts
that hit the CLI's "You aren't authenticated yet" error went from 17 of 19 to 4 of 20
for Claude Code, 10 of 19 to 0 of 22 for `codex-gpt-5.6`, and 9 of 19 to 4 of 22 for
`codex-gpt-5.4-mini`.

**Giving up was already rare, because the error names the fix.** CLI 2.5.0's message
for an unauthenticated call without a terminal lists `hookdeck ci --api-key` as the
first way out. On 28 September, before the skill said anything, Claude Code hit that
error in 17 attempts and ran `hookdeck ci` after it in all 17. The ten Codex attempts
that hit it and never ran `hookdeck ci` carried on with the API key directly, and nine
of the ten still passed.

**That is the confound, and the baselines show it.** On 5 and 6 November the
`-no-skills` arms never ran `hookdeck ci` first, and still ran it after the error in
13 of 18 Claude Code attempts, 13 of 16 for `codex-gpt-5.6` and 25 of 25 for
`codex-gpt-5.4-mini`. An agent without the skill learns the command from the CLI. The
skill moves it ahead of the first failed call; it is not what makes the call possible.

**No score is attributable to it.** `localdev-001` passed in every skills arm before and
after. `verification-001` went from fail to pass for `codex-gpt-5.6`, but the before is
one attempt and the after is best of three, and this is the scenario Loop 1 found
unstable (#14). On 5–6 November it needed a second or third attempt in four of its six
cells.

**No guest sessions.** None of the transcripts from these two runs shows the CLI
working in a guest account, which is the failure Loop 1 started from. That is CLI
2.5.0, not the skill: the baselines had no skill and no guest session either.

### What this loop actually found

A skill change can be correct, visible in every transcript, and invisible on the
scoreboard. Agents read it and did what it said, and the product had already closed
most of the gap by putting the command in its error message. The two fixes overlap, and
the CLI's reaches every agent, with or without skills.

**Status: closed. The skill changed the order agents authenticate in. It bought no
score this benchmark can measure, because the CLI's error message was already teaching
the same command.**

---

## Loop 4: the Outpost skill never named the key's project

**Status:** inconclusive. The re-run happened and cannot answer the question.

### What the benchmark found

On 21 August, Claude Code with the `outpost` skill loaded probed the Outpost API with
the wrong project's key, got a `404`, decided Outpost was not provisioned, and built a
workaround on `api.hookdeck.com`. The skill never said the key has to belong to an
Outpost project (#40).

That run is the one Loop 2 found confounded: the harness had not yet told agents the
Outpost project existed. So the finding never had a clean before-state.

### The change

[agent-skills#28](https://github.com/hookdeck/agent-skills/pull/28), merged 1 October,
adds an "API base URL and credentials" section to the `outpost` skill: the base URL, a
project API key for an Outpost project, and a `404` read as the wrong project rather
than as Outpost being absent. It reached the benchmark with Loop 3's pin move.

### Why the re-run says nothing

**There was almost no headroom.** On 28 September the final attempt of every
skills-arm cell on all five Outpost scenarios already used `OUTPOST_API_KEY`, five of
five in each arm. That was after Loop 2's fix named the project in the prompt.

**The transcript signal is now unreadable by search.** The check was whether an agent
says Outpost is "not provisioned". The new skill section contains that phrase, so a
search for it matches transcripts that only read the skill.

**The one cell that moved failed in exactly the way the change addresses.**
`outpost-002` on `codex-gpt-5.4-mini` read fail, pass, pass, pass across the four
September runs, failed all three attempts on 5 November, and passed on 6 November. On
5 November none of the three attempts used `OUTPOST_API_KEY` or called the Outpost API.
Each worked in the Event Gateway project with `HOOKDECK_API_KEY`, built a replacement
connection there, replayed old gateway requests through it and reported the customer
recovered. Two of the three had read `skills/outpost/SKILL.md`, new section included. On
6 November the same cell used the Outpost key and passed first time.

So the weak model can read the guidance and still build on the wrong product, and the
same cell in the next run can use the right key and pass. One cell, split one to one
across two runs, is not a measurement in either direction.

**Status: inconclusive. The change had almost nothing to move, and the one cell it
could move went both ways. The 5 November transcripts are the evidence worth keeping.**
