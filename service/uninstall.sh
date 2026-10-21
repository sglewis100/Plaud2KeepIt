#!/bin/sh
# Stops the Plaud2KeepIt LaunchAgent and removes it (run with npm run dev instead).
LABEL=com.plaud2keepit.server
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL"
