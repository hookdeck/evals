#!/usr/bin/env bash
# Open or update one `regression-alert` issue per failing scenario.
#
# The first version kept a single issue and commented on whichever
# `regression-alert` issue was open. So every failure landed on the same
# thread whatever caused it: a harness `fetch failed` in
# `regression-verification-001-generic-hmac` on 26 October was appended to an
# issue about a rubric in `regression-filtering-001-regex-capability`, and read
# as more of the same. One issue per scenario keeps "this guard keeps failing"
# readable as one problem, and keeps unrelated failures off it.
#
# Each failing cell is classified by the step that failed, because the
# difference is the first thing a reader needs: a red check is either a
# guarded mistake returning or a scorer being wrong, and an errored eval step
# means the cell has no verdict — usually the harness, a provider or the agent
# CLI, not the agent's answer.
#
# Everything that is not a verdict on a scenario goes to one run-level issue:
# a job outside the matrix (`prepare`, `publish-results`), a cancelled cell,
# and above all a provider refusal. A refusal uploads a `provider-refused-*`
# artifact and cancels the run (#103), so every remaining cell arrives
# cancelled; filing those per scenario would open an issue for each guard
# over one empty credit balance.
#
# Env: GH_REPO, RUN_ID, RUN_URL. DRY_RUN=1 prints instead of writing.
set -euo pipefail

: "${GH_REPO:?}" "${RUN_ID:?}" "${RUN_URL:?}"
dry_run="${DRY_RUN:-0}"

RUN_LEVEL_TITLE="Weekly regression run is failing"

jobs="$(gh api --paginate "repos/${GH_REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
  --jq '.jobs[]' | jq -s '.')"

refused="$(gh api --paginate "repos/${GH_REPO}/actions/runs/${RUN_ID}/artifacts?per_page=100" \
  --jq '.artifacts[].name | select(startswith("provider-refused-")) | ltrimstr("provider-refused-")')"

# One line per failed cell: eval_id <TAB> experiment <TAB> what failed.
# Matrix job names are `run-evals (<eval_id>, <experiment>, <suite>, <suite>)`,
# and GitHub cuts them at 100 characters with "...". The current ids leave the
# first two fields intact with room to spare; a cell whose id or experiment
# was cut is not filed under a guessed scenario, but goes to the run-level
# issue under its full job name.
# Failed only: a cancelled cell is not a verdict on its scenario.
# shellcheck disable=SC2016 # $q is a jq variable, not a shell one
truncated='(.name | ltrimstr("run-evals (") | split(", ")) as $q
  | ($q | length) < 3 or ($q[0] | endswith("...")) or ($q[1] | endswith("..."))'
cells=""
if [ -z "$refused" ]; then
  cells="$(jq -r "
    .[]
    | select(.name | startswith(\"run-evals (\"))
    | select(.conclusion == \"failure\")
    | select(${truncated} | not)"'
    | (.name | ltrimstr("run-evals (") | rtrimstr(")") | split(", ")) as $p
    | ([.steps[]? | select(.conclusion == "failure")][0].name // "") as $step
    | [
        $p[0], $p[1],
        (if $step == "Check the regression suite passed" then "checks failed: the scorer recorded a red check"
         elif $step == "Run evals" then "errored: no verdict; usually the harness, a provider or the agent CLI, not the agent'"'"'s answer"
         elif $step == "" then "failed, with no failed step recorded"
         else "failed at step \"" + $step + "\"" end)
      ]
    | @tsv' <<<"$jobs")"
fi

other_failures="$(jq -r --arg refused "$refused" "
  .[]
  | select(.name != \"regression-alert\")
  | select(.conclusion == \"failure\" or .conclusion == \"cancelled\")
  | select((\$refused != \"\")
      or (.name | startswith(\"run-evals (\") | not)
      or .conclusion == \"cancelled\"
      or (${truncated}))"'
  | "- `\(.name)`: \(.conclusion)"' <<<"$jobs")"

open_issues="$(gh issue list --label regression-alert --state open --limit 100 \
  --json number,title)"

guidance="Regression scenarios guard mistakes we have already seen and fixed, so
every agent passing is the expected state. A cell whose **checks failed** is one
of two things: the guarded mistake came back, or the scorer is wrong about a
correct answer. Read the transcript in the cell's \`raw-results-*\` artifact
before deciding which; the agent's own report is usually the fastest answer.
A cell that **errored** has no verdict: usually the harness, a provider or the
agent CLI, not the agent's answer."

# Comment on the open issue whose title matches exactly, or open one.
post() {
  local title="$1" body="$2"; shift 2
  local number
  number="$(jq -r --arg t "$title" '[.[] | select(.title == $t)][0].number // empty' <<<"$open_issues")"
  if [ "$dry_run" = "1" ]; then
    echo "=== ${number:+comment on #$number}${number:-create}: $title"
    echo "$body"
    return
  fi
  if [ -n "$number" ]; then
    gh issue comment "$number" --body "$body"
  else
    gh issue create --title "$title" --label regression-alert "$@" --body "$body"
  fi
}

if [ -n "$cells" ]; then
  while IFS= read -r eval_id; do
    lines="$(awk -F'\t' -v id="$eval_id" '$1 == id { printf "- `%s`: %s\n", $2, $3 }' <<<"$cells")"
    body="The weekly regression run failed \`${eval_id}\`: ${RUN_URL}

${lines}

${guidance}"
    post "Regression failing: ${eval_id}" "$body" --label scenario
  done < <(cut -f1 <<<"$cells" | sort -u)
fi

if [ -n "$refused" ]; then
  refusing="$(awk '{ printf "- `%s`\n", $0 }' <<<"$refused")"
  body="The weekly regression run was cancelled because a provider refused: ${RUN_URL}

Refused in:
${refusing}

A refusal is a credit, quota or auth failure, and the run cancels itself so
the remaining cells do not run and bill. No scenario has a verdict from this
run. Fix the provider account, then dispatch the regression suite.

Jobs that failed or were cancelled:
${other_failures:-- none recorded}"
  post "$RUN_LEVEL_TITLE" "$body" --label harness
elif [ -n "$other_failures" ] || [ -z "$cells" ]; then
  body="The weekly regression run failed outside any single scenario verdict: ${RUN_URL}

${other_failures:-- no failed job recorded; the run was failed or cancelled before any cell finished}

This is the pipeline rather than an agent's answer: discovery, a provider
preflight, publishing, or a cancelled cell. Read the failed job's log first."
  post "$RUN_LEVEL_TITLE" "$body" --label harness
fi
