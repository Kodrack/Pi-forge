#!/bin/zsh
# Run all replay tests (no LLM needed — milliseconds).
# Usage: bash bench/run-replay.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
failed=0
for t in "$DIR"/replay/test-*.mjs; do
  echo "── $(basename "$t")"
  node "$t" || failed=1
done
if [ "$failed" -eq 0 ]; then
  echo "REPLAY SUITE: ALL PASS"
else
  echo "REPLAY SUITE: FAILURES — see above"
fi
exit $failed
