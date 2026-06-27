#!/usr/bin/env bash
# Build mtg-all into ./build and deploy to caddy01.
#
#   ./deploy.sh
#
# Env overrides:
#   BULK=/path/to/default-cards.json   (else the latest is downloaded from Scryfall)
#   DEPLOY_HOST=caddy01                 (ssh host)
#   DEPLOY_PATH=/srv/www/foiltilt-mtg-all
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
DEPLOY_HOST="${DEPLOY_HOST:-caddy01}"
DEPLOY_PATH="${DEPLOY_PATH:-/srv/www/foiltilt-mtg-all}"
BULK="${BULK:-$ROOT/default-cards.json}"

# 1. Scryfall bulk default_cards (printing-level, with images + prices)
if [ ! -f "$BULK" ]; then
  echo "Downloading Scryfall default_cards bulk export..."
  URL=$(curl -s https://api.scryfall.com/bulk-data \
    | python3 -c "import json,sys;print([b['download_uri'] for b in json.load(sys.stdin)['data'] if b['type']=='default_cards'][0])")
  curl -s "$URL" -o "$BULK"
fi

# 2. assemble build/ from source (no data yet)
rm -rf "$BUILD"; mkdir -p "$BUILD/scripts" "$BUILD/styles"
cp "$ROOT/index.html" "$ROOT/404.html" "$ROOT/favicon.ico" "$ROOT/favicon-16.png" "$ROOT/favicon-32.png" "$ROOT/apple-touch-icon.png" "$ROOT/og-image.jpg" "$ROOT/ft-mark.png" "$ROOT/foiltilt-wordmark.png" "$BUILD/"
cp "$ROOT/scripts/"*.js "$BUILD/scripts/"
cp "$ROOT/styles/"*.css "$BUILD/styles/"

# 3. generate per-year data (streamed, constant memory)
BULK="$BULK" OUT="$BUILD/data" python3 "$ROOT/gen_data.py"

# 4. copy the year shell into each year folder (year is read from the URL at runtime)
for f in "$BUILD/data/"*.json; do
  y="$(basename "$f" .json)"; [ "$y" = "years" ] && continue
  mkdir -p "$BUILD/$y"; cp "$ROOT/year-template.html" "$BUILD/$y/index.html"
done

# 5. deploy
echo "Deploying to $DEPLOY_HOST:$DEPLOY_PATH ..."
rsync -az --delete --rsync-path="sudo rsync" "$BUILD/" "$DEPLOY_HOST:$DEPLOY_PATH/"
ssh "$DEPLOY_HOST" "sudo chown -R caddy:caddy $DEPLOY_PATH \
  && sudo find $DEPLOY_PATH -type d -exec chmod 755 {} + \
  && sudo find $DEPLOY_PATH -type f -exec chmod 644 {} +"
echo "Done."
