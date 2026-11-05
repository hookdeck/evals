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
# Only two failures are a verdict on a scenario, and only they are filed per
# scenario:
#
# - the regression check failed: a red check, so the guarded mistake came back
#   or the scorer is wrong about a correct answer;
# - the eval step errored: the cell has no verdict, usually the harness, a
#   provider or the agent CLI rather than the agent's answer. Filed per
#   scenario because it is about that cell, labelled `harness` when no cell of
#   the scenario has a red check.
#
# Everything else goes to one run-level issue: a job outside the matrix
# (`prepare`, `publish-results`), a cell that failed at setup (a missing
# secret, a registry outage, which would otherwise open an issue for every
# scenario), a cancelled or timed-out cell, a cell whose job name GitHub cut
# short, and above all a provider refusal. A refusal uploads a
# `provider-refused-*` artifact and cancels the run (#103), so every remaining
# cell arrives cancelled and none has a verdict.
#
# A same-title issue that was closed is reopened rather than duplicated, so a
# guard that regresses again keeps its history in one thread.
#
# If the run cannot be read, the script still alerts: a red job that tells
# nobody is the failure this exists to prevent.
#
# Env: GH_REPO, RUN_ID, RUN_URL; RUN_ATTEMPT (default 1).
# DRY_RUN set to anything but 0 or empty prints instead of writing.
set -euo pipefail

: "${GH_REPO:?}" "${RUN_ID:?}" "${RUN_URL:?}"
attempt="${RUN_ATTEMPT:-1}"
case "${DRY_RUN:-0}" in
  0 | "") dry_run=0 ;;
  *) dry_run=1 ;;
esac

RUN_LEVEL_TITLE="Weekly regression run is failing"
CHECK_STEP="Check the regression suite passed"
EVAL_STEP="Run evals"

# GitHub's API answers the odd 502: three turned up in a 40-run sweep of the
# jobs endpoint. Retry each read before deciding the run is unreadable. Each
# attempt's output is captured whole, so a paginated read that fails partway
# does not leave its first pages behind to be repeated by the next attempt.
retry() {
  local n out
  for n in 1 2 3; do
    if out="$("$@")"; then
      printf '%s\n' "$out"
      return 0
    fi
    if [ "$n" -lt 3 ]; then sleep $((n * ${RETRY_DELAY:-5})); fi
  done
  return 1
}

issues=""
issues_read=0
if issues="$(retry gh issue list --label regression-alert --state all --limit 200 \
  --json number,title,state)"; then
  issues_read=1
fi

# Comment on the open issue with this exact title; reopen and comment on a
# closed one; otherwise open one. Without the issue list it opens one: a
# duplicate can be closed, a silent failure cannot be noticed.
post() {
  local title="$1" body="$2" label="$3"
  local match="" number="" state=""
  if [ "$issues_read" = 1 ]; then
    match="$(jq -r --arg t "$title" '
      [.[] | select(.title == $t)]
      | (map(select(.state == "OPEN")) + map(select(.state != "OPEN")))[0]
      | if . == null then "" else "\(.number) \(.state)" end' <<<"$issues")"
  fi
  if [ -n "$match" ]; then
    number="${match%% *}"
    state="${match#* }"
  fi

  if [ "$dry_run" = 1 ]; then
    local action="create"
    if [ "$state" = "OPEN" ]; then
      action="comment on #${number}"
    elif [ -n "$number" ]; then
      action="reopen #${number} and comment"
    fi
    echo "=== ${action}: ${title} [${label}]"
    echo "$body"
    return
  fi

  if [ -z "$number" ]; then
    gh issue create --title "$title" --label regression-alert --label "$label" \
      --body "$body"
    return
  fi
  if [ "$state" != "OPEN" ]; then
    gh issue reopen "$number"
  fi
  gh issue comment "$number" --body "$body"
}

if ! jobs="$(retry gh api --paginate \
  "repos/${GH_REPO}/actions/runs/${RUN_ID}/attempts/${attempt}/jobs?per_page=100" \
  --jq '.jobs[]')"; then
  post "$RUN_LEVEL_TITLE" "The weekly regression run failed, and its jobs could not be read to say which scenarios: ${RUN_URL}

GitHub's API did not answer after three attempts. Open the run and read the failed jobs directly." harness
  exit 0
fi
jobs="$(jq -s '.' <<<"$jobs")"

# Artifacts are listed for the whole run, every attempt included, so on a
# re-run keep only those made since this attempt started: a refusal before a
# credit top-up must not suppress the scenario issues of the re-run after it.
started="1970-01-01T00:00:00Z"
if [ "$attempt" -gt 1 ]; then
  started="$(retry gh api "repos/${GH_REPO}/actions/runs/${RUN_ID}/attempts/${attempt}" \
    --jq '.run_started_at')" || started=""
fi
refused=""
refusal_unknown=0
if [ -z "$started" ] || ! refused="$(retry gh api --paginate \
  "repos/${GH_REPO}/actions/runs/${RUN_ID}/artifacts?per_page=100" \
  --jq ".artifacts[]
        | select(.created_at >= \"${started}\")
        | .name | select(startswith(\"provider-refused-\"))
        | ltrimstr(\"provider-refused-\")")"; then
  refusal_unknown=1
  refused=""
fi

# Matrix job names are `run-evals (<eval_id>, <experiment>, <suite>, <suite>)`,
# and GitHub cuts them at 100 characters with "...". The current ids leave the
# first two fields intact with room to spare; a cell whose id or experiment was
# cut is not filed under a guessed scenario.
# shellcheck disable=SC2016 # jq variables, not shell ones
defs='
  def is_cell: .name | startswith("run-evals (");
  def fields: .name | ltrimstr("run-evals (") | rtrimstr(")") | split(", ");
  def cut_short: (.name | ltrimstr("run-evals (") | split(", ")) as $q
    | ($q | length) < 3 or ($q[0] | endswith("...")) or ($q[1] | endswith("..."));
  def failed_step: [.steps[]? | select(.conclusion == "failure")][0].name // "";
  def per_scenario($check; $eval):
    is_cell and .conclusion == "failure" and (cut_short | not)
    and (failed_step as $s | $s == $check or $s == $eval);
'

# One line per scenario cell: eval_id <TAB> experiment <TAB> kind.
cells=""
if [ -z "$refused" ] && [ "$refusal_unknown" = 0 ]; then
  cells="$(jq -r --arg check "$CHECK_STEP" --arg eval "$EVAL_STEP" "${defs}"'
    .[]
    | select(per_scenario($check; $eval))
    | fields as $p
    | [$p[0], $p[1], (if failed_step == $check then "check" else "error" end)]
    | @tsv' <<<"$jobs")"
fi

other_failures="$(jq -r --arg check "$CHECK_STEP" --arg eval "$EVAL_STEP" \
  --arg filed "$([ -n "$cells" ] && echo 1 || echo 0)" "${defs}"'
  .[]
  | select(.name != "regression-alert")
  | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")
  | select($filed == "0" or (per_scenario($check; $eval) | not))
  | "- `\(.name)`: \(.conclusion)"
    + (failed_step as $s | if $s == "" then "" else " at \"\($s)\"" end)' <<<"$jobs")"

guidance="Regression scenarios guard mistakes we have already seen and fixed, so
every agent passing is the expected state. A cell whose **checks failed** is one
of two things: the guarded mistake came back, or the scorer is wrong about a
correct answer. Read the transcript in the cell's \`raw-results-*\` artifact
before deciding which; the agent's own report is usually the fastest answer.
A cell that **errored** has no verdict: usually the harness, a provider or the
agent CLI, not the agent's answer."

if [ -n "$cells" ]; then
  while IFS= read -r eval_id; do
    lines="$(awk -F'\t' -v id="$eval_id" '$1 == id {
      if ($3 == "check") what = "checks failed: the scorer recorded a red check"
      else what = "errored: no verdict; usually the harness, a provider or the agent CLI, not the agent'"'"'s answer"
      printf "- `%s`: %s\n", $2, what
    }' <<<"$cells")"
    label="harness"
    if awk -F'\t' -v id="$eval_id" '$1 == id && $3 == "check" { found = 1 } END { exit !found }' <<<"$cells"; then
      label="scenario"
    fi
    post "Regression failing: ${eval_id}" "The weekly regression run failed \`${eval_id}\`: ${RUN_URL}

${lines}

${guidance}" "$label"
  done < <(cut -f1 <<<"$cells" | sort -u)
fi

if [ -n "$refused" ]; then
  refusing="$(awk '{ printf "- `%s`\n", $0 }' <<<"$refused")"
  post "$RUN_LEVEL_TITLE" "The weekly regression run was cancelled because a provider refused: ${RUN_URL}

Refused in:
${refusing}

A refusal is a credit, quota or auth failure, and the run cancels itself so
the remaining cells do not run and bill. No scenario has a verdict from this
run. Fix the provider account, then dispatch the regression suite.

Jobs that failed, were cancelled or timed out:
${other_failures:-- none recorded}" harness
elif [ "$refusal_unknown" = 1 ]; then
  post "$RUN_LEVEL_TITLE" "The weekly regression run failed, and its artifacts could not be read, so a provider refusal cannot be ruled out: ${RUN_URL}

No scenario issue was opened, because filing a refused run per scenario would
blame every guard for one credit balance. Check the run's artifacts for
\`provider-refused-*\` before reading the cells below as agent results.

Jobs that failed, were cancelled or timed out:
${other_failures:-- none recorded}" harness
elif [ -n "$other_failures" ] || [ -z "$cells" ]; then
  post "$RUN_LEVEL_TITLE" "The weekly regression run failed outside any single scenario verdict: ${RUN_URL}

${other_failures:-- no failed job recorded; the run was failed or cancelled before any cell finished}

This is the pipeline rather than an agent's answer: discovery, setup, a
provider preflight, publishing, or a cancelled cell. Read the failed job's log
first." harness
fi
