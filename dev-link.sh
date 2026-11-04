#!/usr/bin/env bash
# PiForge dev linker — symlink the installed files back to this repo so edits
# are live with no copy step. After editing any extension, just /reload in Pi
# (or restart `pi`) — no re-install needed.
#
# Run once: bash dev-link.sh
# Undo (go back to real copies): bash install.sh
set -e

PIFORGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$HOME/.pi/agent"

mkdir -p "$PI_DIR/extensions" "$PI_DIR/skills/incremental-codegen"

# Limits used to be tuned by editing the installed incremental-guard.ts; linking
# replaces it. Move any such edits into ~/.pi/piforge.json first.
node "$PIFORGE_DIR/migrate-config.mjs" "$PI_DIR/extensions/incremental-guard.ts" \
  "$PIFORGE_DIR/extensions/incremental-guard.ts" "$HOME/.pi/piforge.json" "$PIFORGE_DIR/config/piforge.json"

echo "Linking extensions → repo (live edits)..."
for f in "$PIFORGE_DIR/extensions/"*.ts; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  ln -sfn "$f" "$PI_DIR/extensions/$base"
  echo "  ~/.pi/agent/extensions/$base → repo"
done

# Skill + /guide doc (edited less often, but link them too for consistency)
ln -sfn "$PIFORGE_DIR/skills/incremental-codegen/SKILL.md" "$PI_DIR/skills/incremental-codegen/SKILL.md"
ln -sfn "$PIFORGE_DIR/config/piforge-self.md" "$HOME/.pi/piforge-self.md"

# Global AGENTS.md — Pi loads ~/.pi/agent/AGENTS.md natively in every project
ln -sfn "$PIFORGE_DIR/project-template/AGENTS.md" "$PI_DIR/AGENTS.md"
echo "  ~/.pi/agent/AGENTS.md → repo project-template/AGENTS.md (global contract)"

# Drop CLAUDE.md from Pi's context-file candidates (see patch-pi-loader.sh).
# Patches Pi's own dist/, so it is independent of the symlinks above.
bash "$PIFORGE_DIR/patch-pi-loader.sh"

echo ""
echo "✓ Linked. Edit any extension in the repo, then /reload in Pi to load it."
echo "  Config files (models.json, settings.json, piforge.json) are intentionally"
echo "  NOT linked — those are tuned per-machine in ~/.pi/. Run install.sh to revert."
