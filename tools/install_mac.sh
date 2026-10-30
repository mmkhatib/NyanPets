#!/bin/sh
# Builds the Mac app (Release), installs it in /Applications (or
# ~/Applications when /Applications is not writable), and starts it.
#
#   tools/install_mac.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DERIVED="$ROOT/build/DerivedData"

xcodebuild -project "$ROOT/NyAssistant.xcodeproj" -scheme "NyAssistant macOS" -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath "$DERIVED" -allowProvisioningUpdates -quiet build
APP="$DERIVED/Build/Products/Release/NyAssistant.app"

DEST=/Applications
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }

# Quit the running copy, wherever it was started from.
if pgrep -x NyAssistant >/dev/null; then
  osascript -e 'tell application id "com.overlord.nyassistant" to quit' >/dev/null 2>&1 || true
  sleep 1
  pkill -x NyAssistant 2>/dev/null || true
fi

rm -rf "$DEST/NyAssistant.app"
ditto "$APP" "$DEST/NyAssistant.app"
open "$DEST/NyAssistant.app"
echo "Installed $DEST/NyAssistant.app"
