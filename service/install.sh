#!/bin/sh
# Installs (or reinstalls) Plaud2KeepIt as a LaunchAgent and starts it.
# Uses the node on your PATH and this checkout's folder. Re-run it after
# switching Node versions or moving the folder.
set -e
cd "$(dirname "$0")/.."
DIR="$(pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node not found on PATH" >&2; exit 1; fi
LABEL=com.plaud2keepit.server
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sed -e "s|__NODE_DIR__|$(dirname "$NODE")|g" -e "s|__NODE__|$NODE|g" -e "s|__DIR__|$DIR|g" \
  service/$LABEL.plist.template > "$DEST"
plutil -lint "$DEST" >/dev/null
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed $DEST (node: $NODE) and started $LABEL"
echo "Open http://localhost:${PORT:-40000}  ·  logs: $DIR/logs/server.log"
