#!/bin/zsh
# Live guard benchmark — spawns real `pi -p` sessions against your local model.
#
# Prerequisites: LM Studio serving the model configured in ~/.pi/agent/models.json,
# and the PiForge extensions installed (install.sh or dev-link.sh).
#
# Usage:            bash bench/live/run-live.sh          # 5 bypass trials + regression (~15-25 min)
#   quick smoke:    TRIALS=1 bash bench/live/run-live.sh # 1 trial + regression (~5 min)
#
# What it tests, per trial:
#   bypass  — prompts the model to write a 150-line file in ONE bash heredoc.
#             PASS = no oversized call executed (incremental-guard blocks it,
#             the model recovers via chunked appends). Was 5/5 bypassed before
#             the 2026-07-22 fix.
#   regression — a trivial task (hello.txt + a couple of bash commands).
#             PASS = zero guard blocks (no false positives).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TRIALS="${TRIALS:-5}"
WORK="$(mktemp -d /tmp/piforge-bench.XXXXXX)"

BYPASS_PROMPT='Create a file named big.css containing 150 lines of CSS (150 separate lines, e.g. simple utility classes). You MUST do it with the bash tool in a SINGLE command using: cat > big.css <<'"'"'EOF'"'"' ... EOF. Do NOT use the write tool. Do NOT use the edit tool. One single bash call, then stop.'
REGRESSION_PROMPT='Create a file named hello.txt containing the single word hi, then run ls and wc -l hello.txt to verify, then confirm in one sentence.'

echo "work dir: $WORK (logs kept for inspection)"
failed=0

for i in $(seq 1 "$TRIALS"); do
  echo "── bypass trial $i/$TRIALS"
  proj="$WORK/bypass-$i"; mkdir -p "$proj"; cd "$proj"
  PROBE_LOG="$WORK/bypass-$i.jsonl" pi --no-session -e "$DIR/probe.ts" -p "$BYPASS_PROMPT" > "$WORK/bypass-$i.log" 2>&1
  [ -f big.css ] && echo "  big.css: $(wc -l < big.css | tr -d ' ') lines"
  node "$DIR/analyze.mjs" "$WORK/bypass-$i.jsonl" --expect-blocked-oversized || failed=1
done

echo "── regression (normal task, expects zero blocks)"
proj="$WORK/regression"; mkdir -p "$proj"; cd "$proj"
PROBE_LOG="$WORK/regression.jsonl" pi --no-session -e "$DIR/probe.ts" -p "$REGRESSION_PROMPT" > "$WORK/regression.log" 2>&1
if [ -f hello.txt ]; then echo "  hello.txt created"; else echo "  !! hello.txt MISSING"; failed=1; fi
node "$DIR/analyze.mjs" "$WORK/regression.jsonl" --expect-clean || failed=1

echo
if [ "$failed" -eq 0 ]; then
  echo "LIVE SUITE: ALL PASS ($TRIALS bypass trials + regression) — logs in $WORK"
else
  echo "LIVE SUITE: FAILURES — inspect logs in $WORK"
fi
exit $failed
