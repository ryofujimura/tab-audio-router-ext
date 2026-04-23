#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST_DIR="$ROOT_DIR/native-host"
HOST_SCRIPT="$HOST_DIR/host.js"
TEMPLATE="$HOST_DIR/com.tab_audio_router.host.json"
OUT_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
OUT_FILE="$OUT_DIR/com.tab_audio_router.host.json"

if [[ "${1:-}" == "" ]]; then
  echo "Usage: ./native-host/install-mac.sh <chrome-extension-id>"
  exit 1
fi

EXT_ID="$1"
mkdir -p "$OUT_DIR"
chmod +x "$HOST_SCRIPT"

sed \
  -e "s#__EXTENSION_ID__#$EXT_ID#g" \
  -e "s#/ABSOLUTE/PATH/TO/tab-audio-router-ext/native-host/host.js#$HOST_SCRIPT#g" \
  "$TEMPLATE" > "$OUT_FILE"

echo "Installed native host:"
echo "  $OUT_FILE"
