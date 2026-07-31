#!/bin/bash
# Hard capability benchmark — how far can the local model get on genuinely
# difficult coding tasks while running under the full PiForge harness?
#
# Unlike bench/live (guard bypass tests), this measures TASK SUCCESS: each task
# has a hidden verifier (bench/hard/tasks/<task>/verify.mjs) that runs the
# produced code from OUTSIDE the trial dir and scores it against a battery of
# cases the model never sees.
#
# Usage:
#   bash bench/hard/run-hard.sh                        # all 5 tasks x 5 iterations
#   ITERS=1 bash bench/hard/run-hard.sh                # quick pass
#   TASKS="regex-lite json-patch" bash bench/hard/run-hard.sh
#   TIMEOUT_S=1800 bash bench/hard/run-hard.sh         # per-run wall clock cap
#
# Requires: LM Studio serving the default model from ~/.pi/agent/models.json,
# extensions installed (dev-link.sh). Runs are sequential (one model instance).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PROBE="$DIR/../live/probe.ts"
ANALYZE="$DIR/../live/analyze.mjs"
ITERS="${ITERS:-5}"
TIMEOUT_S="${TIMEOUT_S:-1200}"
TASKS="${TASKS:-regex-lite csv-kit bug-hunt-lru json-patch spreadsheet}"
WORK="${WORK:-$(mktemp -d /tmp/piforge-hard.XXXXXX)}"
RESULTS="$WORK/results.csv"

echo "task,iter,verdict,score,max,secs,executed,blocked" > "$RESULTS"
echo "work dir: $WORK (logs + trial dirs kept for inspection)"
echo "tasks: $TASKS | iterations: $ITERS | per-run timeout: ${TIMEOUT_S}s"
echo

for task in $TASKS; do
  for i in $(seq 1 "$ITERS"); do
    proj="$WORK/$task-$i"
    mkdir -p "$proj"
    [ -d "$DIR/tasks/$task/setup" ] && cp -R "$DIR/tasks/$task/setup/." "$proj/"

    echo "── $task  iter $i/$ITERS  ($(date +%H:%M:%S))"
    start=$(date +%s)
    (
      cd "$proj"
      PROBE_LOG="$WORK/$task-$i.jsonl" pi --no-session -e "$PROBE" \
        -p "$(cat "$DIR/tasks/$task/prompt.txt")" > "$WORK/$task-$i.log" 2>&1
    ) &
    pid=$!
    waited=0; timedout=0
    while kill -0 $pid 2>/dev/null; do
      sleep 5; waited=$((waited+5))
      if [ $waited -ge $TIMEOUT_S ]; then
        timedout=1
        pkill -TERM -P $pid 2>/dev/null; kill -TERM $pid 2>/dev/null
        sleep 3
        pkill -KILL -P $pid 2>/dev/null; kill -KILL $pid 2>/dev/null
        break
      fi
    done
    wait $pid 2>/dev/null
    secs=$(( $(date +%s) - start ))

    vout=$(node "$DIR/tasks/$task/verify.mjs" "$proj" 2>&1)
    vrc=$?
    echo "$vout" | sed 's/^/    /'
    score=$(echo "$vout" | grep -Eo 'SCORE [0-9]+/[0-9]+' | head -1 | sed 's/SCORE //' | cut -d/ -f1)
    max=$(echo "$vout" | grep -Eo 'SCORE [0-9]+/[0-9]+' | head -1 | sed 's/SCORE //' | cut -d/ -f2)
    score="${score:-0}"; max="${max:-1}"

    if [ "$timedout" -eq 1 ]; then verdict="TIMEOUT"
    elif [ "$vrc" -eq 0 ]; then verdict="PASS"
    else verdict="FAIL"
    fi

    exec_n=0; blocked_n=0
    if [ -f "$WORK/$task-$i.jsonl" ]; then
      stats=$(node "$ANALYZE" "$WORK/$task-$i.jsonl" 2>/dev/null | grep 'calls:' || true)
      [ -n "$stats" ] && exec_n=$(echo "$stats" | awk '{print $2}') && blocked_n=$(echo "$stats" | awk '{print $4}')
    fi

    echo "    → $verdict  score $score/$max  ${secs}s  (tool calls: $exec_n executed, $blocked_n blocked)"
    echo "$task,$i,$verdict,$score,$max,$secs,$exec_n,$blocked_n" >> "$RESULTS"
    echo
  done
done

echo "════════ SUMMARY ════════"
column -t -s, "$RESULTS"
echo
awk -F, 'NR>1 { n[$1]++; if ($3=="PASS") p[$1]++; sc[$1]+=$4; mx[$1]+=$5; s[$1]+=$6; b[$1]+=$8 }
  END { for (t in n) printf "%-14s  pass %d/%d   avg case score %3.0f%%   avg %3.0fs/run   %d guard blocks total\n",
        t, p[t]+0, n[t], 100*sc[t]/mx[t], s[t]/n[t], b[t] }' "$RESULTS" | sort
echo
echo "results: $RESULTS"
