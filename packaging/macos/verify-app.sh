#!/usr/bin/env bash
# Check a built Faravan.app against the bundle contract: identities, versions, icon, layout, the pinned
# runtime, and that every Mach-O file has exactly the expected slices.
#   packaging/macos/verify-app.sh APP arm64|x86_64|universal [--allow-dev-runtime]
#   (--arch ARCH is accepted too)
# The structural checks (bundle-tool.mjs) run anywhere. On macOS it also runs plutil, lipo, iconutil and the
# bundled Node; elsewhere it says those native checks were skipped. It never claims a Gatekeeper result.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="${1:?path to Faravan.app}"; shift
[ "${1:-}" != --arch ] || shift
arch="${1:?architecture: arm64, x86_64 or universal}"; shift
allow_dev=""; [ "${1:-}" != --allow-dev-runtime ] || allow_dev=--allow-dev-runtime
case "$arch" in arm64|x86_64|universal) ;; *) echo "verify-app: unknown architecture $arch; use arm64, x86_64 or universal" >&2; exit 2 ;; esac
[ -d "$app/Contents" ] || { echo "verify-app: $app is not an app bundle" >&2; exit 2; }
node="${FARAVAN_BUILD_NODE:-node}"

"$node" "$here/bundle-tool.mjs" verify "$app" --arch "$arch" $allow_dev || { echo "verify-app: $app does not meet the bundle contract" >&2; exit 1; }

if [ "$(uname -s)" = Darwin ]; then
  plutil -lint "$app/Contents/Info.plist" "$app/Contents/Helpers/FaravanNotify.app/Contents/Info.plist"
  want=$([ "$arch" = universal ] && echo "arm64 x86_64" || echo "$arch")
  while IFS= read -r path; do
    for a in $want; do lipo "$app/$path" -verify_arch "$a" || { echo "verify-app: lipo says $path lacks $a" >&2; exit 1; }; done
  done < <("$node" "$here/bundle-tool.mjs" verify "$app" --arch "$arch" $allow_dev | awk '/^  /{print $NF}')
  scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"' EXIT
  iconutil -c iconset -o "$scratch/Faravan.iconset" "$app/Contents/Resources/Faravan.icns"
  if [ -z "$allow_dev" ]; then
    . "$here/../node-runtime.env"
    actual="$("$app/Contents/Resources/faravan/runtime/bin/node" --version)"
    [ "$actual" = "v$NODE_VERSION" ] || { echo "verify-app: bundled Node is $actual, pinned v$NODE_VERSION" >&2; exit 1; }
  fi
  echo "verify-app: native checks passed (plutil, lipo, iconutil, Node version). Gatekeeper is not checked here."
else
  echo "verify-app: native checks skipped: not macOS (no plutil, lipo, iconutil or Node run)"
fi
label=$([ "$arch" = universal ] && echo "universal (arm64 + x86_64)" || echo "$arch")
echo "verify-app: ok, $label (signatures are checked by sign-notarize.sh, not here)"
