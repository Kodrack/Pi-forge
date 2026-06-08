#!/usr/bin/env bash
# searxng-up.sh — start a local, keyless SearXNG for PiForge web_search.
# Self-hosted search backend: no API key, no browser, fully private.
# web-search.ts queries http://localhost:8888/search?format=json
#
# Usage:
#   bash searxng-up.sh          # create config (first run) + start/restart container
#   docker stop searxng         # stop it
#   docker start searxng        # start it again later
set -e

PORT="${SEARXNG_PORT:-8888}"
CONF_DIR="${SEARXNG_CONF:-$HOME/searxng}"
SETTINGS="$CONF_DIR/settings.yml"

if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker daemon not running. Start Docker Desktop first (open -a Docker), then re-run."
  exit 1
fi

# ---- 1. Config (JSON format is DISABLED in SearXNG by default — enable it) ----
mkdir -p "$CONF_DIR"
if [ ! -f "$SETTINGS" ]; then
  SECRET="$(openssl rand -hex 32)"
  cat > "$SETTINGS" <<YAML
# PiForge SearXNG config — minimal override merged onto SearXNG defaults.
use_default_settings: true
server:
  secret_key: "$SECRET"
  bind_address: "0.0.0.0"
  limiter: false          # no rate-limit for local single-user use
  image_proxy: false
search:
  formats:
    - html
    - json                # REQUIRED so ?format=json works for web_search
YAML
  echo "✓ wrote $SETTINGS (JSON format enabled, limiter off)"
else
  echo "• using existing $SETTINGS"
fi

# ---- 2. (Re)create the container ----
docker rm -f searxng >/dev/null 2>&1 || true
docker run -d --name searxng \
  -p "${PORT}:8080" \
  -v "$CONF_DIR:/etc/searxng" \
  --restart unless-stopped \
  searxng/searxng:latest >/dev/null
echo "✓ searxng container started on http://localhost:${PORT}"

# ---- 3. Wait for it to answer JSON ----
echo -n "  waiting for JSON endpoint"
for i in $(seq 1 30); do
  n=$(curl -s -m 5 "http://localhost:${PORT}/search?q=test&format=json" 2>/dev/null \
      | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('results',[])))" 2>/dev/null || echo "")
  if [ -n "$n" ] && [ "$n" != "0" ]; then
    echo " — OK ($n results for 'test')"
    echo "✓ ready. web_search will use http://localhost:${PORT}"
    exit 0
  fi
  echo -n "."
  sleep 2
done
echo ""
echo "⚠ container is up but JSON endpoint isn't returning results yet."
echo "  Check: docker logs searxng   |   curl 'http://localhost:${PORT}/search?q=test&format=json'"
exit 1
