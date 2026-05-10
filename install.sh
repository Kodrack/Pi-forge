#!/usr/bin/env bash
# PiForge installer
# Sets up the full Pi coding-agent enforcement stack for local LLMs.
# Run from the piforge/ directory: bash install.sh

set -e

PIFORGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$HOME/.pi/agent"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║           PiForge Installer          ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ---------- 1. Check pi is installed ----------
if ! command -v pi &>/dev/null; then
  echo "✗ 'pi' not found. Install it first:"
  echo "  npm install -g @mariozechner/pi-coding-agent"
  echo ""
  exit 1
fi
echo "✓ pi found: $(which pi)"

# ---------- 2. Create ~/.pi/agent directories ----------
mkdir -p "$PI_DIR/extensions"
mkdir -p "$PI_DIR/skills/incremental-codegen"
echo "✓ ~/.pi/agent directories ready"

# ---------- 3. Copy extensions ----------
# distill-v2.ts is the active version — deploy it as distill.ts
# distill.ts (v1) stays in the repo for reference but is NOT deployed
for f in "$PIFORGE_DIR/extensions/"*.ts; do
  base="$(basename "$f")"
  # Skip legacy distill v1
  if [ "$base" = "distill.ts" ]; then
    continue
  fi
  # Deploy distill-v2.ts as distill.ts
  if [ "$base" = "distill-v2.ts" ]; then
    cp "$f" "$PI_DIR/extensions/distill.ts"
    echo "    ~/.pi/agent/extensions/distill.ts (from distill-v2.ts)"
  else
    cp "$f" "$PI_DIR/extensions/$base"
    echo "    ~/.pi/agent/extensions/$base"
  fi
done
echo "✓ Extensions installed"

# ---------- 4. Copy knowledge files ----------
mkdir -p "$HOME/.pi/knowledge"
cp "$PIFORGE_DIR/knowledge/"*.md "$HOME/.pi/knowledge/" 2>/dev/null || true
echo "✓ Knowledge files installed: ~/.pi/knowledge/"
for f in "$PIFORGE_DIR/knowledge/"*.md; do
  [ "$(basename "$f")" = "README.md" ] && continue
  echo "    ~/.pi/knowledge/$(basename "$f")"
done

# ---------- 5. Copy skill ----------
cp "$PIFORGE_DIR/skills/incremental-codegen/SKILL.md" "$PI_DIR/skills/incremental-codegen/SKILL.md"
echo "✓ Skill installed: incremental-codegen"

# ---------- 6. Config files (prompt before overwriting) ----------
# models.json  — LM Studio provider + model list (edit model id to match yours)
# settings.json — defaultProvider/Model, thinking level, compaction tuned for 50k context:
#                 keepRecentTokens=28000, reserveTokens=8192
# piforge.json — extension toggles (knowledge-injector, plan-clarify disabled by default)
cp "$PIFORGE_DIR/config/piforge.json" "$HOME/.pi/piforge.json"
echo "✓ piforge.json installed (knowledge-injector + plan-clarify disabled by default)"

for file in models.json settings.json; do
  src="$PIFORGE_DIR/config/$file"
  dst="$PI_DIR/$file"
  if [ -f "$dst" ]; then
    read -r -p "  $file already exists — overwrite? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      cp "$src" "$dst"
      echo "✓ $file overwritten"
    else
      echo "  $file skipped (keeping existing)"
      echo "  ↳ Check config/$file for recommended values (compaction, thinkingLevel, etc.)"
    fi
  else
    cp "$src" "$dst"
    echo "✓ $file installed"
  fi
done

# ---------- 7. Done ----------
echo ""
echo "╔══════════════════════════════════════╗"
echo "║           Installation done          ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Start LM Studio and load your model (server on :1234)"
echo "  2. Edit ~/.pi/agent/models.json — set your model id to match LM Studio"
echo "  3. Copy project-template/CLAUDE.md into any project you work on"
echo "  4. Run: pi"
echo ""
echo "  You should see these on startup:"
echo "    incremental-guard active (max 80 lines / 6000 chars per write/edit)"
echo "    thinking-guard active (max 2000 chars / 60 lines of thinking per turn)"
echo "    context-monitor active — warn at 65%, urgent at 80%"
echo "    analysis-guard active (triggers on responses >1000 chars with no file write)"
echo ""
echo "  Commands:"
echo "    /distill [path]              — build codebase knowledge base"
echo "    /explore \"question\"           — navigate distilled knowledge"
echo "  Pi can also call distill_codebase and explore_codebase as tools autonomously."
echo ""
