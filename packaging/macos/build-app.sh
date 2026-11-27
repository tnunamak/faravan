#!/usr/bin/env bash
# Build one native leg of Faravan.app (arm64 on Apple silicon, x86_64 on Intel). macOS cannot cross-compile
# this app (cgo tray, Swift helpers), so a universal app is two native legs merged by build-universal.sh.
# Needs macOS, Xcode command line tools (swiftc, iconutil), Go with cgo, npm, and the pinned Node archive.
#
#   FARAVAN_PI_PAYLOAD=/path/to/linux-pi-payload.tgz PACKAGE_VERSION=0.1.0 packaging/macos/build-app.sh [outdir]
#   Build that payload on Linux with scripts/build-pi-payload.sh --check OUT.tgz; both native legs use the same pinned bytes.
#   ARCH=arm64|x64 must match the machine when given. FARAVAN_RELEASE_BUILD=1 refuses development inputs.
#
# Result: <outdir>/Faravan.app, one architecture, UNSIGNED. Merge with build-universal.sh, then sign with
# sign-notarize.sh (or label it an unsigned preview there). Layout, checked by verify-app.sh:
#   Contents/MacOS/faravan-launch              Finder and login entry (packaging/macos/launcher, launcher lane)
#   Contents/MacOS/faravan                     CLI wrapper: the bundled Node, arguments kept
#   Contents/MacOS/faravan-tray                menu bar helper (Go, cgo)
#   Contents/Helpers/FaravanNotify.app         notification helper, its own bundle identity
#   Contents/Resources/Faravan.icns            icon, from icon/Faravan.iconset
#   Contents/Resources/faravan/                app files and runtime/bin/node (pinned, see node-runtime.env)
set -euo pipefail
if [ "$#" -gt 1 ]; then echo "usage: build-app.sh [outdir]" >&2; exit 2; fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; packaging="$(cd "$here/.." && pwd)"; repo="$(cd "$packaging/.." && pwd)"
version="${PACKAGE_VERSION:-0.1.0}"

# Record immutable source identity before build/toolchain/staging effects.
# Only this source root may supply HEAD; never discover an ancestor checkout.
source_error() { echo "PACKAGE_SOURCE_SHA: $*" >&2; exit 2; }
explicit_source="${PACKAGE_SOURCE_SHA-}"
if [ "${PACKAGE_SOURCE_SHA+x}" = x ] && [[ ! "$explicit_source" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  source_error "must be a full 40-hex source commit"
fi
checkout_source=""
if [ -e "$repo/.git" ]; then
  source_git() { env -i PATH="$PATH" HOME="${HOME:-}" GIT_CONFIG_NOSYSTEM=1 git -C "$repo" "$@"; }
  checkout_top="$(source_git rev-parse --show-toplevel 2>/dev/null)" || source_error "cannot verify source checkout Git metadata"
  [ "$(cd "$checkout_top" && pwd -P)" = "$(cd "$repo" && pwd -P)" ] || source_error "Git metadata identifies another checkout"
  checkout_source="$(source_git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || source_error "cannot resolve immutable source HEAD"
  [[ "$checkout_source" =~ ^[0-9A-Fa-f]{40}$ ]] || source_error "HEAD is not a full 40-hex commit"
fi
source_sha="$(printf '%s' "$explicit_source" | tr 'A-F' 'a-f')"
checkout_source="$(printf '%s' "$checkout_source" | tr 'A-F' 'a-f')"
if [ -n "$source_sha" ] && [ -n "$checkout_source" ] && [ "$source_sha" != "$checkout_source" ]; then
  source_error "does not match this source checkout HEAD"
fi
source_sha="${source_sha:-$checkout_source}"
[ -n "$source_sha" ] || source_error "required for an exported source tree without verified Git metadata"
# Source metadata is not a signature, publisher identity or attestation.
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || {
  echo "PACKAGE_VERSION must be a semver value such as 0.1.0" >&2; exit 2
}
# One minimum for every compiler and both Info.plists. Docker Sandboxes need macOS 14 for local lending.
min_macos=14.0
host_arch="$(uname -m)"
case "$host_arch" in
  arm64) ;;
  x86_64) host_arch=x64 ;;
  *) echo "Unsupported native architecture: $host_arch" >&2; exit 2 ;;
esac
arch="${ARCH:-$host_arch}"
case "$arch" in arm64|x64) ;; *) echo "ARCH must be arm64 or x64" >&2; exit 2 ;; esac
[ "$arch" = "$host_arch" ] || { echo "ARCH=$arch does not match native architecture $host_arch; macOS cross compilation is not supported" >&2; exit 2; }
launcher_src="${FARAVAN_LAUNCHER_SWIFT:-$here/launcher/main.swift}"
[ -f "$launcher_src" ] || { echo "build-app: launcher source $launcher_src not found (packaging/macos/launcher/main.swift)" >&2; exit 2; }
if [ -n "${FARAVAN_RELEASE_BUILD:-}" ]; then
  for v in FARAVAN_NODE_BIN FARAVAN_LAUNCHER_SWIFT; do
    [ -z "${!v:-}" ] || { echo "build-app: $v is a development override; FARAVAN_RELEASE_BUILD=1 refuses it" >&2; exit 2; }
  done
fi
machine=$([ "$arch" = arm64 ] && echo arm64 || echo x86_64)
goarch=$([ "$arch" = arm64 ] && echo arm64 || echo amd64)
target="$machine-apple-macos$min_macos"
export MACOSX_DEPLOYMENT_TARGET="$min_macos"

# A preview label builds a side-by-side preview with its own name, bundle id and data folder, in the same format as
# packaging/linux-preview.sh. FARAVAN_CHANNEL_FILE supplies any other channel; neither gives the stable app.
channel_file="${FARAVAN_CHANNEL_FILE:-}"
preview_label="${FARAVAN_PREVIEW_LABEL:-}"
if [ -n "$channel_file" ] && [ -n "$preview_label" ]; then
  echo "set FARAVAN_CHANNEL_FILE or FARAVAN_PREVIEW_LABEL, not both" >&2; exit 2
fi
if [ -n "$preview_label" ]; then
  [[ "$preview_label" =~ ^[0-9A-Za-z][0-9A-Za-z.-]*$ ]] || { echo "FARAVAN_PREVIEW_LABEL must start with a letter or digit and use only letters, digits, dots and hyphens" >&2; exit 2; }
  if [[ "$preview_label" == *-tray || ${#preview_label} -gt 80 ]]; then echo "FARAVAN_PREVIEW_LABEL must be at most 80 characters and must not end in -tray" >&2; exit 2; fi
  channel_json=$(printf '{"id":"faravan","name":"Faravan","dataFolder":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify","launchAgentLabel":"com.faravan.agent","linuxPrefix":"faravan"}\n' \
    "$preview_label" "$preview_label" "$preview_label" "$preview_label" "$preview_label" "$preview_label" "$preview_label")
elif [ -n "$channel_file" ]; then
  [ -f "$channel_file" ] && [ -r "$channel_file" ] || { echo "build-app: custom channel file $channel_file is not a readable regular file" >&2; exit 2; }
  channel_json=$(cat "$channel_file")
else
  channel_json='{"id":"faravan","name":"Faravan","dataFolder":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify","launchAgentLabel":"com.faravan.agent","linuxPrefix":"faravan"}'
fi
channel_values=$(printf '%s' "$channel_json" | CHANNEL_IDENTITY_MODULE="$repo/lib/channel-identity.mjs" "${FARAVAN_NODE_BIN:-node}" --input-type=module -e '
import {pathToFileURL} from "node:url";
  const {isChannelIdentity, plistSedReplacement} = await import(pathToFileURL(process.env.CHANNEL_IDENTITY_MODULE));
let text = "";
for await (const chunk of process.stdin) text += chunk;
try {
  const channel = JSON.parse(text);
  if (!isChannelIdentity(channel)) throw new Error("invalid channel identity");
  console.log([channel.name, channel.bundleId, channel.helperBundleId, plistSedReplacement(channel.bundleId), plistSedReplacement(channel.name)].join("\n"));
} catch (error) {
  console.error("build-app: invalid channel file: " + error.message);
  process.exitCode = 2;
}
')
app_name=$(printf '%s\n' "$channel_values" | sed -n '1p')
bundle_id=$(printf '%s\n' "$channel_values" | sed -n '2p')
helper_bundle_id=$(printf '%s\n' "$channel_values" | sed -n '3p')
bundle_id_sed=$(printf '%s\n' "$channel_values" | sed -n '4p')
app_name_sed=$(printf '%s\n' "$channel_values" | sed -n '5p')

# All caller-controlled flags and channel metadata are valid before the old artifact is removed.
out="${1:-$here/dist}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
app="$out/Faravan.app"
# Build beside the destination, never inside the installed/previous artifact.
# A second builder must not remove or publish over this builder's staging area.
lock="$out/.Faravan.build.lock"
mkdir "$lock" 2>/dev/null || { echo "build-app: another build owns $lock; leave it alone until that build exits" >&2; exit 2; }
stage=""
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$stage" ] && { [ -e "$stage/previous.app" ] || [ -L "$stage/previous.app" ]; } && [ ! -e "$out/Faravan.app" ]; then
    if ! mv "$stage/previous.app" "$out/Faravan.app"; then
      echo "build-app: could not restore previous app; preserved at $stage/previous.app" >&2
      rmdir "$lock" || true
      exit 1
    fi
  fi
  [ -z "$stage" ] || rm -rf "$stage"
  rmdir "$lock" || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
stage="$(mktemp -d "$out/.Faravan.build.XXXXXX")"
app="$stage/Faravan.app"; res="$app/Contents/Resources/faravan"
mkdir -p "$app/Contents/MacOS" "$res"
printf '%s\n' "$channel_json" > "$res/channel.json"

"$packaging/stage-app.sh" "$res" "$version"
printf '{"schemaVersion":1,"sourceSha":"%s","version":"%s"}\n' "$source_sha" "$version" > "$res/installed-source.json"
# The same qualification the Linux build runs: product imports load and the image pins read their file.
"${FARAVAN_BUILD_NODE:-node}" "$packaging/check-staged-runtime.mjs" "$res"
"$packaging/bundle-node.sh" darwin "$arch" "$res"
"$packaging/bundle-guest-runtime.sh" darwin "$arch" "$res"

(cd "$repo/tray" && CGO_ENABLED=1 GOOS=darwin GOARCH="$goarch" CGO_CFLAGS="-mmacosx-version-min=$min_macos" CGO_LDFLAGS="-mmacosx-version-min=$min_macos" \
  go build -trimpath -o "$app/Contents/MacOS/faravan-tray" ./cmd/faravan-tray)
(cd "$repo/tray" && CGO_ENABLED=0 GOOS=darwin GOARCH="$goarch" \
  go build -trimpath -o "$app/Contents/MacOS/faravan-process-identity" ./cmd/faravan-process-identity)
swiftc -O -target "$target" -o "$app/Contents/MacOS/faravan-launch" "$launcher_src"
clang -O2 -target "$target" -o "$app/Contents/MacOS/faravan-update-exchange" "$here/launcher/update-exchange.c"
APP_NAME="$app_name" HELPER_BUNDLE_ID="$helper_bundle_id" env -u SIGN_IDENTITY "$here/build-notify-helper.sh" "$app/Contents/Helpers/FaravanNotify.app" "$version" "$target"

mkdir -p "$app/Contents/Resources"
iconutil -c icns -o "$app/Contents/Resources/Faravan.icns" "$here/icon/Faravan.iconset"
mkdir -p "$app/Contents/Helpers/FaravanNotify.app/Contents/Resources"
cp "$app/Contents/Resources/Faravan.icns" "$app/Contents/Helpers/FaravanNotify.app/Contents/Resources/Faravan.icns"

install -m 0755 "$here/launcher/cli.sh" "$app/Contents/MacOS/faravan"
# The PATH alias uses the same bundled-runtime launcher as the compatibility command.

sed -e "s#@@VERSION@@#$version#g" -e "s#@@MIN_MACOS@@#$min_macos#g" -e "s#@@BUNDLE_ID@@#$bundle_id_sed#g" -e "s#@@APP_NAME@@#$app_name_sed#g" "$here/Info.plist" >"$app/Contents/Info.plist"

dev=(); [ -z "${FARAVAN_NODE_BIN:-}" ] || dev=(--allow-dev-runtime)
"$here/verify-app.sh" "$app" "$machine" ${dev[@]+"${dev[@]}"}
# Publish only the completely verified bundle. If the final rename fails,
# the EXIT trap restores the previous artifact rather than deleting it.
if [ -e "$out/Faravan.app" ] || [ -L "$out/Faravan.app" ]; then
  mv "$out/Faravan.app" "$stage/previous.app"
fi
mv "$app" "$out/Faravan.app"
app="$out/Faravan.app"
echo "built $app ($machine only, unsigned; merge with build-universal.sh before release)"
