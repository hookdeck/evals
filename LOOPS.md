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
   fix is distinguishable from variance. The weekly cadence runs one attempt and
   cannot do this.
5. **Record it below**, including when the change did not work. A loop that failed is
   more informative than one that succeeded, and hiding it makes the rest less
   believable.

**The fix has to be to the product, the docs or the skills.** Changing the scenario so
it passes proves nothing, and is the one move this file exists to make visible.

---

## Loop 1: the CLI was not safe to run without a terminal

**Status:** in progress. Before-state pinned, re-run under way.

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

_Pending: run [31809988720](https://github.com/hookdeck/evals/actions/runs/31809988720),
CLI 2.5.0, three attempts per pair, skill unchanged._

### What it bought

_Pending._
