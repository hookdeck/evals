"""Saturation figures for other vendor benchmarks, from their published data.

    python3 .plans/eval-reviews/scripts/external.py supabase
    python3 .plans/eval-reviews/scripts/external.py vercel
    python3 .plans/eval-reviews/scripts/external.py convex
    python3 .plans/eval-reviews/scripts/external.py stripe

Each fetches the suite's live data, so the figures are as of the day it runs.
The sources move: if one 404s, find the file again from the suite's README and
update the URL here rather than reading numbers off a leaderboard page.

What each reports, in the terms the review compares on:
  supabase  mean pass rate over runs (pass@1), best of k per cell (pass@k),
            scenarios passed on every run by every experiment, and by every
            experiment at best of k
  vercel    per experiment base and AGENTS.md success (the board is pass@4),
            and scenarios passed by every current ("tier 1") model
  convex    for the top ten models' latest run, evals passed by all of them,
            with and without guidelines
  stripe    scenarios scored 1.0 by every model (best of three, partial credit)
"""

import csv
import io
import json
import sys
import urllib.request
from collections import defaultdict

SOURCES = {
    "supabase": "https://raw.githubusercontent.com/supabase/evals/main/apps/web/src/data/eval-results.json",
    "vercel": "https://raw.githubusercontent.com/vercel/next-evals-oss/main/agent-results.json",
    "convex": "https://fabulous-panther-525.convex.cloud/api/query",
    "stripe": "https://raw.githubusercontent.com/stripe/ai/main/benchmarks/benchmarks-results-2026-02-26.csv",
}


def get(url, body=None):
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"} if body else {})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode()


def supabase():
    rows = [r for r in json.loads(get(SOURCES["supabase"])) if r.get("suite") == "benchmark"]
    cells = defaultdict(list)
    for r in rows:
        cells[(r["eval"], r["experiment"])].append(bool(r["passed"]))
    evals = sorted({e for e, _ in cells})
    exps = sorted({x for _, x in cells})
    k = sorted({len(v) for v in cells.values()})
    print(f"{len(evals)} benchmark scenarios, {len(exps)} experiments, runs per cell {k}")
    print(f"pass@1 (mean over runs): {100 * sum(map(sum, cells.values())) / len(rows):.1f}%")
    print(f"best of k, cells: {sum(any(v) for v in cells.values())}/{len(cells)}")
    every_run = sum(all(all(cells[(e, x)]) for x in exps if (e, x) in cells) for e in evals)
    every_exp = sum(all(any(cells[(e, x)]) for x in exps if (e, x) in cells) for e in evals)
    print(f"scenarios passed on every run by every experiment: {every_run}/{len(evals)}")
    print(f"scenarios passed by every experiment at best of k: {every_exp}/{len(evals)}")
    for x in exps:
        v = [cells[(e, x)] for e in evals if (e, x) in cells]
        print(f"  {x:40} pass@1 {100 * sum(map(sum, v)) / sum(map(len, v)):5.1f}%")


def vercel():
    d = json.loads(get(SOURCES["vercel"]))
    meta = {e["name"]: e for e in d["metadata"]["experiments"]}
    arms = {"base": defaultdict(dict), "agents-md": defaultdict(dict)}
    evals = set()
    for exp, rows in d["results"].items():
        for r in rows:
            evals.add(r["evalPath"])
            if r.get("baseResult") is not None:
                arms["base"][exp][r["evalPath"]] = r["baseResult"]["success"]
            if r.get("result") is not None:
                arms["agents-md"][exp][r["evalPath"]] = r["result"]["success"]
    tier1 = [e for e in d["results"] if meta[e].get("tier") == 1]
    print(f"{len(d['results'])} experiments, {len(evals)} evals, {len(tier1)} tier 1 (current models)")
    for name, arm in arms.items():
        ran = {v: [e for e in tier1 if v in arm[e]] for v in evals}
        counted = [v for v in evals if ran[v]]
        allp = [v for v in counted if all(arm[e][v] for e in ran[v])]
        print(f"{name}: evals passed by every tier-1 model that ran them {len(allp)}/{len(counted)}")
        hard = sorted((sum(arm[e][v] for e in ran[v]), len(ran[v]), v) for v in counted)[:5]
        print("  hardest: " + ", ".join(f"{v} {p}/{n}" for p, n, v in hard))


def convex():
    def q(path, args):
        body = json.dumps({"path": path, "args": args, "format": "json"}).encode()
        return json.loads(get(SOURCES["convex"], body))["value"]

    for args, label in (({}, "with guidelines"), ({"experiment": "no_guidelines"}, "no_guidelines")):
        top = sorted(q("runs:leaderboardScores", args), key=lambda r: -r["totalScore"])[:10]
        per = defaultdict(dict)
        for r in top:
            for e in q("runs:getRunDetails", {"runId": r["latestRunId"]})["evals"]:
                per[e["evalPath"]][r["model"]] = e["status"]["kind"] == "passed"
        n = len(top)
        allp = sum(1 for v in per.values() if len(v) == n and all(v.values()))
        none = sum(1 for v in per.values() if not any(v.values()))
        print(f"{label}: top {n} models, latest single run each; {len(per)} evals")
        print(f"  passed by all: {allp}   by at least {n - 1}: {sum(1 for v in per.values() if sum(v.values()) >= n - 1)}   by none: {none}")


def stripe():
    rows = list(csv.DictReader(io.StringIO(get(SOURCES["stripe"]))))
    best = defaultdict(dict)
    for r in rows:
        k = (r["eval name"], r["model"])
        best[r["eval name"]][r["model"]] = max(best[r["eval name"]].get(r["model"], 0.0), float(r["score"]))
    full = [e for e, m in best.items() if all(s == 1.0 for s in m.values())]
    print(f"{len(best)} scored rows; scored 1.0 by every model at best of three: {len(full)}/{len(best)}")


if __name__ == "__main__":
    which = sys.argv[1:] or list(SOURCES)
    for name in which:
        print(f"== {name}  ({SOURCES[name]})")
        globals()[name]()
        print()
