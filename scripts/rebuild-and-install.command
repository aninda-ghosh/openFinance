#!/usr/bin/env bash
# Rebuilds openFinance and replaces /Applications/openFinance.app. Double-click to run.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
./scripts/build-mac.sh
APP="apps/desktop/src-tauri/target/release/bundle/macos/openFinance.app"
[[ -d "$APP" ]] || { echo "Build output not found: $APP"; read -r -p "Press Enter to close"; exit 1; }
osascript -e 'tell application "openFinance" to quit' 2>/dev/null || true
sleep 2
rm -rf /Applications/openFinance.app
cp -R "$APP" /Applications/openFinance.app
xattr -cr /Applications/openFinance.app
open /Applications/openFinance.app
echo "Done: openFinance reinstalled."
read -r -p "Press Enter to close"
