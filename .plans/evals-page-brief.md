# Evals page: answers for design

Answers to the design questionnaire, from the repo rather than from memory. Two of
them change what is buildable, so they are first.

## What the data can and cannot support today

**Run drill-down: checks only.** The exported row carries 16 fields: experiment,
experimentSuite, experimentDisplay, eval, stage, product, topic, suite, passed,
attempts, checks, skills, docs, prompt, promptSourcePath, sourcePath. No transcript,
no tool calls, no agent report, no token or cost usage. A panel showing an agent's
reasoning or a run's cost is not a component away, it is an export change plus a
review of what that publishes. Transcripts are the sensitive case: an agent echoed
its project key into one on the first real run, and the exporter now refuses to write
anything containing a credential.

**Cost and tokens: not available, and asymmetric even if they were.** Claude Code
reports a cost; Codex reports token counts and no cost, because pricing them needs a
table we do not keep. A cost column would be populated for one agent and empty for
the other, which is worse than absent.

**Scale is smaller than the placeholder suggests.** The questionnaire's example reads
"6 experiments x 40 evals". Today: eighteen scenarios, fifteen benchmark and three
regression, against five published experiments, so the public grid is at most
**5 x 15**. The regression suite is deliberately excluded from the scoreboard so
narrow failure cases cannot drag or inflate the published numbers. Design for tens of
cells, not hundreds; a layout that needs density to look intentional will look empty
for months.

**The grid is sparse, and it stays sparse.** Several scenarios have never run against
several experiments, and one is capability-gated behind Outpost credentials so it
deliberately reports a skip. "Not run" is a normal state here, not an edge case, and
it has to read as distinct from a failure.

**Cells in the same grid are not the same age.** Frontier agents and the weak pair run
weekly; the `-no-skills` twins run monthly, because their measured delta is what got
cut to fit the budget. Half the columns can therefore be up to four weeks staler than
the other half. One "last updated" stamp for the table would be a false claim.
Freshness is per experiment.

## The experiments, and what the pairing actually showed

`claude-code-sonnet-5` and `codex-gpt-5.6`, each with a `-no-skills` twin, plus
`codex-gpt-5.4-mini-no-skills` as a deliberately weaker model. A pair is identical
apart from the skills list, so the gap between them is attributable to the skills and
nothing else.

That comparison was assumed to be the headline. It isn't. Skills changed no outcome on
either build scenario and cost 39% and 56% more. Publish the comparison, because a
flat delta honestly reported is worth more than an implied one, but do not build the
page's hierarchy around it.

The spread that carries signal is model capability. The frontier agents pass nearly
everything; the weak model fails several of the same scenarios. Flat at the top of the
range and discriminating below it is a floor, and a floor is worth publishing.

Every arm gets the Hookdeck CLI and a live API key. Nothing here is "documentation
only", and the page should not imply it.

## Scoring shape, which constrains the layout

**Per stage, never blended.** "Build 5/6, Investigate 2/3" rather than "74%". A single
ranked leaderboard needs a blended number to sort by, which is the thing we decided
not to publish. Three stages: build, investigate, resolve. There is no deploy stage.

**Failures are always visible.** Showing where agents fail is what makes the passing
numbers believable, so failure is a normal state to design for rather than an
exception to tuck away.

**A cell is a run with checks.** Each run carries named checks that passed or failed,
some with notes, some with a judge's prose. Four rows covering every state the UI has
to render are in `reference/results-sample.json`, validated against the same schema
the site parses.

## One warning

The results app in this repo is supabase/evals with our data in it. It carries their
logo, a "Back to Supabase" header, a "with a Supabase project" footer, a hero reading
"across Supabase", and a hostname check for supabase.com. The journey-stage
descriptions were theirs too until they were rewritten. Mocking from the app as it
stands copies their branding and their copy. Retargeting it is Phase 3 work and it
gates the page design rather than following it.
