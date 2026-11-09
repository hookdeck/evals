"""Saturation figures for this benchmark, from the published results.

Run from the repository root:

    python3 .plans/eval-reviews/scripts/ours.py

Prints, for the current snapshot (results/latest.json):
  - first attempt against best of N, per scenario and per experiment
  - scenarios every arm passed on the first attempt
  - no-skills Claude Code first-attempt passes with no docs fetched
and, across every snapshot in results/runs/, first-attempt history per scenario
by model family. Runs listed in EXCLUDE are left out because they are known to
be bad populations (see AGENTS.md on 13 August); add to it, do not edit rows.

Only first attempts are counted as pass@1 draws. Under stop-on-pass a later
attempt exists only because an earlier one failed, so it is not a fair sample.
"""

import glob
import json
from collections import defaultdict

EXCLUDE = ("2026-08-13",)
FAMILIES = {
    "claude-code-sonnet-5": "CC",
    "codex-gpt-5.6": "G56",
    "codex-gpt-5.4-mini": "mini",
}


def family(experiment):
    base = experiment.replace("-no-skills", "")
    return FAMILIES[base] if base in FAMILIES else base


def short(experiment):
    s = family(experiment)
    return s + "-" if experiment.endswith("-no-skills") else s


def first(row):
    return bool(row["passed"]) and row.get("attempts", 1) == 1


latest = json.load(open("results/latest.json"))
rows = latest["results"]
exps = sorted({r["experiment"] for r in rows})
cell = {(r["eval"], r["experiment"]): r for r in rows}
evals = sorted({r["eval"] for r in rows if r.get("suite") == "benchmark"})

print(f"Snapshot {latest['publishedAt']}  runs={latest['counts'].get('runs')}")
print(f"{'scenario':46} " + " ".join(f"{short(e):>6}" for e in exps) + "  first")
all_first = 0
for ev in evals:
    out, n = [], 0
    for e in exps:
        r = cell.get((ev, e))
        if r is None:
            out.append(f"{'-':>6}")
            continue
        a = r.get("attempts", 1)
        out.append(f"{(str(a) if r['passed'] else 'F' + str(a)):>6}")
        n += first(r)
    all_first += n == len(exps)
    print(f"{ev.replace('benchmark-', ''):46} " + " ".join(out) + f"  {n}/{len(exps)}")
print("cell = attempts used; F = failed every attempt")
print(f"Scenarios every arm passed on the first attempt: {all_first}/{len(evals)}")
bench = [r for r in rows if r.get("suite") == "benchmark"]
print(
    f"Cells: first attempt {sum(first(r) for r in bench)}/{len(bench)}, "
    f"best of N {sum(bool(r['passed']) for r in bench)}/{len(bench)}"
)
for e in exps:
    er = [r for r in bench if r["experiment"] == e]
    print(f"  {short(e):6} first {sum(first(r) for r in er):2}  best {sum(bool(r['passed']) for r in er):2}  of {len(er)}")

print("\nNo-skills Claude Code, first-attempt pass with no docs fetched:")
for r in bench:
    if r["experiment"] == "claude-code-sonnet-5-no-skills" and first(r) and not r.get("docs", {}).get("calls"):
        print("  " + r["eval"])

hist = defaultdict(lambda: defaultdict(lambda: [0, 0]))
seen = set()
for f in sorted(glob.glob("results/runs/*.json")):
    name = f.rsplit("/", 1)[-1]
    if name.startswith(EXCLUDE):
        continue
    for r in json.load(open(f))["results"]:
        if r.get("suite") != "benchmark":
            continue
        key = (r["eval"], r["experiment"], r.get("ranAt"))
        if key in seen:
            continue
        seen.add(key)
        h = hist[r["eval"]][family(r["experiment"])]
        h[0] += first(r)
        h[1] += 1

fams = list(FAMILIES.values())
print(f"\nFirst-attempt history, all snapshots except {', '.join(EXCLUDE)}")
print(f"{'scenario':46} " + " ".join(f"{k:>7}" for k in fams))
for ev in sorted(hist):
    print(f"{ev.replace('benchmark-', ''):46} " + " ".join(f"{'%d/%d' % tuple(hist[ev][k]):>7}" for k in fams))
