#!/usr/bin/env bash
# Build FaravanNotify.app, the notification helper (UNUserNotificationCenter, see notify/main.swift).
# build-app.sh nests it at Faravan.app/Contents/Helpers/FaravanNotify.app; it is signed with the app after
# the universal merge. Run on macOS with Xcode command line tools.
#   packaging/macos/build-notify-helper.sh DEST.app [VERSION] [TARGET]
#   TARGET defaults to this machine, e.g. arm64-apple-macos14.0. Never a cross target.
# Standalone development only: SIGN_IDENTITY (or "-" for ad hoc) signs the result, so the tray can use it
# through FARAVAN_NOTIFY_HELPER on the build Mac. That is not enough for another person's Gatekeeper.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="${1:?destination FaravanNotify.app}"; version="${2:-0.0.0}"
min_macos=14.0
target="${3:-$(uname -m)-apple-macos$min_macos}"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
MACOSX_DEPLOYMENT_TARGET="$min_macos" swiftc -O -target "$target" -o "$app/Contents/MacOS/faravan-notify" "$here/notify/main.swift"
sed -e "s#@@VERSION@@#$version#g" -e "s#@@MIN_MACOS@@#$min_macos#g" -e "s#@@HELPER_BUNDLE_ID@@#${HELPER_BUNDLE_ID:-com.faravan.app.notify}#g" -e "s#@@APP_NAME@@#${APP_NAME:-Faravan}#g" "$here/notify/Info.plist" >"$app/Contents/Info.plist"
if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --sign "$SIGN_IDENTITY" "$app"
  echo "$app/Contents/MacOS/faravan-notify"
  echo "Point the tray at it with FARAVAN_NOTIFY_HELPER."
fi
