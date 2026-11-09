# Eval reviews

A review asks whether this benchmark is still measuring something: whether its
scenarios still separate agents, and whether a pass means our docs and skills
did their job or the scenario was easy. It answers by comparing our results with
how other vendor and research benchmarks create difficulty and report it.

Reviews are kept here so the next one starts from the last one's evidence rather
than from a search engine. Each leaves dated files behind and never edits an
earlier review's: the field moves, and what it looked like on a date is part of
the record.

## When to run one

**A light check before every release.** Free: no agent runs.

```bash
python3 .plans/eval-reviews/scripts/ours.py
```

Read three numbers from it: first attempt against best of N, the count of
scenarios every arm passed on the first attempt, and the no-skills first-attempt
passes with no docs fetched. Apply the graduation rule proposed in #47: a
benchmark scenario every arm passes on the first attempt in three consecutive
full matrices moves to the regression suite. Say in the release notes if any
scenario graduated.

**A full review when any of these holds:**

1. **Half or more of the benchmark scenarios are passed on the first attempt by
   every arm.** The light check reports it. At that point the suite has stopped
   separating agents and a release cannot say much.
2. **The model set changes.** A new frontier model moves where the ceiling is,
   and scenarios calibrated against the old one may now be floors.
3. **The last full review is more than six months old.** This is the one
   calendar trigger, and it is here because the outside world does not wait for
   our releases: Terminal-Bench shipped four major versions in a year, and
   leaderboards re-rank monthly.

Nothing schedules these. The light check belongs to the release checklist, and
a full review is dispatched like a run: against a reason.

## What a full review does

1. **Our figures.** Run `scripts/ours.py`. If the closed-book diagnostic arm
   (#135) has run since the last review, put its results beside these: a
   scenario passed closed-book measures memory, not our docs.
2. **Other suites' figures.** Run `scripts/external.py` for every suite it
   knows. A suite whose data has moved gets its URL fixed in the script, not its
   numbers copied from a board.
3. **Re-survey.** Re-read the previous review's survey files, check each
   benchmark's current version and board, and look for new vendor or research
   benchmarks. Write new dated survey files; mark anything not reproduced from
   data as unverified.
4. **Classify our scenarios** by what makes each one hard and by stage, as the
   previous findings file does, and list the categories the field covers that
   we do not.
5. **Decide.** Which scenarios to harden, graduate or retire; which new ones to
   probe; whether the published metric still fits. Every decision becomes an
   issue, filed under the milestone it belongs to and referenced from #24.
6. **Record.** A dated findings file here, a row in the index below, and the
   pointer in AGENTS.md if the findings file moved.

A full review is research, not runs, and costs agent time rather than matrix
money. Delegate the web survey: it is the largest part, and its output belongs
in the survey files, not in anyone's context.

### Prompt to start one

```text
Run a full eval review for hookdeck/evals, following .plans/eval-reviews/README.md.
Start from the most recent review in its index: read its findings and both survey
files before searching anything. Run scripts/ours.py and scripts/external.py and
record what moved. Re-survey vendor and research agent benchmarks, writing new
dated survey files and marking anything not reproduced from data as unverified.
Reclassify our benchmark scenarios by difficulty mechanism and stage. Write a
dated findings file with recommendations, and draft (do not post) an issue for
each decision.
```

## Index

| Date | Trigger | Findings | Surveys | Issues |
|---|---|---|---|---|
| November 2026 | 113/114 at best of three in v0.5.0; 13 of 19 scenarios passed by every arm on the first attempt | [`../scenario-difficulty-research.md`](../scenario-difficulty-research.md) | [vendors](2026-11-vendor-survey.md), [research](2026-11-research-survey.md) | #134–#142, and a graduation rule on #47 |

## Scripts

- [`scripts/ours.py`](scripts/ours.py): our saturation figures from `results/`.
- [`scripts/external.py`](scripts/external.py): supabase, Next.js, Convex and
  Stripe saturation from their live published data.

Both use the standard library only and print plain text, so their output can be
pasted into a findings file and re-run by whoever checks it.
