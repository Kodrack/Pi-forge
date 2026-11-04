#!/usr/bin/env bash
# dory-console.sh — run Dory in THIS terminal, in the foreground.
#
# One console, everything visible: every job Dory does (chat replies, plans,
# revisions, executor runs — full PiForge session output including thinking and
# tool calls) streams here, separated by a banner. Each job is a brand-new
# `pi` instance, so context is reset before every task by construction.
#
# The board UI still works at http://localhost:4747 (this IS the board server,
# just attached to your terminal instead of detached). Ctrl+C stops Dory.
#
# Usage: bash ~/.pi/organizer/dory-console.sh [mind-dir]   (default ~/dev-mind)
set -e

MIND_DIR="${1:-$HOME/dev-mind}"
SERVER="$(dirname "${BASH_SOURCE[0]}")/board/server.mjs"

# Take over from any detached server (spawned by the ù key) — one Dory only.
if pkill -f "board/server.mjs" 2>/dev/null; then
  echo "· stopped the detached board server — Dory now runs in this terminal"
  sleep 1
fi

echo "🐟 Dory console — mind: $MIND_DIR · board: http://localhost:${PORT:-4747}"
echo "   every task below runs in a FRESH pi instance (context reset per task)"
exec node "$SERVER" "$MIND_DIR"
