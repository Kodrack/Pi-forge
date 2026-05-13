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
for f in "$PIFORGE_DIR/extensions/"*.ts; do
  base="$(basename "$f")"
  cp "$f" "$PI_DIR/extensions/$base"
  echo "    ~/.pi/agent/extensions/$base"
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
echo "✓ piforge.json installed (knowledge-injector, plan-clarify, explore, distill-awareness disabled by default)"

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
echo "  3. Copy project-template/AGENTS.md into any project you work on"
echo "  4. Run: pi"
echo ""
echo "  You should see these on startup:"
echo "    incremental-guard active (max 100 lines / 6000 chars per write/edit)"
echo "    thinking-guard active (max 2000 chars / 60 lines of thinking per turn)"
echo "    context-monitor active — warn at 65%, urgent at 80%"
echo "    analysis-guard active (triggers on responses >1000 chars with no file write)"
echo "    state-guard active — will enforce _state.md read before source files"
echo "    loop-guard active — detects repetition loops via Jaccard similarity"
echo "    purpose-anchor active — will capture session purpose from first prompt"
echo "    session-manager: session-001 — .think/ ready"
echo "    distill levels: L1 N/N (%) | L2 ... (if distilled data exists)"
echo ""
echo "  Commands:"
echo "    /distill [path]              — build codebase knowledge base"
echo "    /l1 /l2 /l3 \"question\"       — query specific distill level"
echo "    /distill-status              — show distill coverage per level"
echo "    /purpose                     — view/set session purpose"
echo "    /purpose-clear               — reset session purpose"
echo "    /sessions                    — list all .think/ sessions"
echo "    /switch-session [session-id] — switch to a previous session"
echo "    /forget <name>              — remove active knowledge"
echo "    /guide                      — load PiForge guide into context"
echo "    /important \"note\"            — persistent note (survives compaction)"
echo "    /important -compact \"note\"  — same + force compaction after"
echo "    /q \"message\"                — queue work for after Pi finishes"
echo "  Pi can also call distill_codebase as a tool autonomously."
echo ""
