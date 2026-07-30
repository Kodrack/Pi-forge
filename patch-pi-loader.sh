#!/usr/bin/env bash
# PiForge — remove CLAUDE.md from Pi's context-file candidates.
#
# WHY: Pi's resource-loader picks ONE context file per directory from
#   ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]  (first match wins)
# and it does this for the cwd AND every ancestor directory up to /.
# In any repo that has a CLAUDE.md but no AGENTS.md, Pi silently loads
# instructions written for Claude Code into a small local model's context —
# often 10KB+ of guidance that does not apply to it.
#
# PiForge's contract is ONE global AGENTS.md (~/.pi/agent/AGENTS.md). This patch
# makes that literal by dropping the CLAUDE.md fallbacks from the candidate list.
#
# Pi exposes no setting for this: --no-context-files is CLI-only and all-or-
# nothing (it would drop the global AGENTS.md too), and ExtensionAPI only has
# getSystemPrompt() with no setter, so an extension cannot strip it either.
#
# Idempotent. Re-run after every `npm i -g @mariozechner/pi-coding-agent`
# (an upgrade replaces dist/ and restores the CLAUDE.md entries).
# Called automatically by install.sh and dev-link.sh.
#
# Revert: mv resource-loader.js.piforge-bak resource-loader.js  (path printed below)

# NOTE: no `set -e` — this must never abort a caller mid-install.

PI_BIN="$(command -v pi 2>/dev/null)"
if [ -z "$PI_BIN" ]; then
  echo "  ⚠ 'pi' not found — skipped context-loader patch"
  exit 0
fi

# Resolve through the bin symlink to the real dist/cli.js (macOS readlink -f is
# not reliable across versions, so use node's realpath).
PI_CLI="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$PI_BIN" 2>/dev/null)"
LOADER="$(dirname "$PI_CLI")/core/resource-loader.js"

if [ ! -f "$LOADER" ]; then
  echo "  ⚠ resource-loader.js not found (looked in $(dirname "$PI_CLI")/core/) — skipped"
  echo "    Pi's layout may have changed; CLAUDE.md may still load into context."
  exit 0
fi

if ! grep -q 'const candidates' "$LOADER"; then
  echo "  ⚠ candidates list not found in $LOADER — skipped"
  echo "    Pi's loader may have been rewritten; verify with:  grep -n 'AGENTS.md' \"$LOADER\""
  exit 0
fi

if ! grep -q 'CLAUDE' "$LOADER"; then
  echo "✓ Pi context-loader already patched (CLAUDE.md not a candidate)"
  exit 0
fi

if [ ! -w "$LOADER" ]; then
  echo "  ⚠ $LOADER is not writable — skipped"
  echo "    Re-run with write access, or:  sudo bash patch-pi-loader.sh"
  exit 0
fi

# Drop `, "CLAUDE.md"` / `, "CLAUDE.MD"` from the candidates line only.
# Backup is written fresh on each real patch, so it always holds pristine upstream.
sed -i.piforge-bak -E '/const candidates/ s/, *"CLAUDE\.(md|MD)"//g' "$LOADER"

if grep -q 'CLAUDE' "$LOADER"; then
  echo "  ⚠ patch did not apply — restoring original"
  mv "$LOADER.piforge-bak" "$LOADER"
  echo "    Candidates line is:"
  grep -n 'const candidates' "$LOADER" | sed 's/^/      /'
  exit 0
fi

echo "✓ Pi context-loader patched — CLAUDE.md no longer loaded as a context file"
echo "    $(grep -n 'const candidates' "$LOADER" | sed 's/^ *//')"
echo "    backup: $LOADER.piforge-bak"
echo "    Re-run install.sh after upgrading pi (upgrades revert this)."
exit 0
