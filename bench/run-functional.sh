#!/bin/zsh
# Run functional tests — these import the REAL extension code (via node's type
# stripping) and exercise real I/O, unlike bench/replay which mirrors logic.
# Needs node >= 22.6 for --experimental-strip-types.
# Usage: bash bench/run-functional.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
failed=0
for t in "$DIR"/functional/test-*.mjs; do
  echo "── $(basename "$t")"
  node --experimental-strip-types --disable-warning=ExperimentalWarning "$t" || failed=1
done
if [ "$failed" -eq 0 ]; then
  echo "FUNCTIONAL SUITE: ALL PASS"
else
  echo "FUNCTIONAL SUITE: FAILURES — see above"
fi
exit $failed
