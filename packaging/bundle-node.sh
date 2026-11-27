#!/usr/bin/env bash
# Put the pinned Node.js runtime into a package tree.
#
#   packaging/bundle-node.sh OS ARCH DEST
#     OS: linux | darwin | win     ARCH: x64 | arm64
#   DEST gets runtime/bin/node (runtime/node.exe on Windows) and runtime/LICENSE.
#
# The download comes from nodejs.org and must match the SHA-256 in node-runtime.env, or nothing is written.
# Offline and test builds:
#   FARAVAN_NODE_TARBALL=FILE   use a local copy of the official archive (still checked against the pin)
#   FARAVAN_NODE_BIN=FILE       development only: copy this node binary and skip the pin (never for a release)
# Only the Linux x64 path has been run. The macOS and Windows paths follow the same archive layout, unrun.
set -euo pipefail

os="${1:?os: linux|darwin|win}"; arch="${2:?arch: x64|arm64}"; dest="${3:?destination directory}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=node-runtime.env
source "$here/node-runtime.env"
mkdir -p "$dest/runtime/bin"

if [ -n "${FARAVAN_NODE_BIN:-}" ]; then
  echo "bundle-node: DEVELOPMENT runtime $FARAVAN_NODE_BIN (not pinned; do not release)" >&2
  install -m 0755 "$FARAVAN_NODE_BIN" "$dest/runtime/bin/node"
  echo "development runtime, not for release" > "$dest/runtime/LICENSE"
  exit 0
fi

ext=tar.xz; [ "$os" = darwin ] && ext=tar.gz; [ "$os" = win ] && ext=zip
name="node-v${NODE_VERSION}-${os}-${arch}"
pin_var="NODE_SHA256_${os}_${arch}"; pin="${!pin_var:-}"
[ -n "$pin" ] || { echo "bundle-node: no pinned hash for $os-$arch" >&2; exit 1; }

archive="${FARAVAN_NODE_TARBALL:-}"
if [ -z "$archive" ]; then
  cache="${FARAVAN_NODE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/faravan-node}"
  mkdir -p "$cache"
  archive="$cache/$name.$ext"
  if [ ! -f "$archive" ]; then
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$name.$ext" -o "$archive.part"
    mv "$archive.part" "$archive"
  fi
fi
[ -f "$archive" ] || { echo "bundle-node: could not get $name.$ext" >&2; exit 1; }
actual="$(sha256sum "$archive" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$archive" | cut -d' ' -f1)"
if [ "$actual" != "$pin" ]; then
  echo "bundle-node: $archive does not match the pinned SHA-256 (got $actual)" >&2
  [ -z "${cache:-}" ] || rm -f "$archive" # a bad cached download is never reused
  exit 1
fi

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
case "$ext" in
  tar.xz) tar -xJf "$archive" -C "$work" "$name/bin/node" "$name/LICENSE" ;;
  tar.gz) tar -xzf "$archive" -C "$work" "$name/bin/node" "$name/LICENSE" ;;
  zip) unzip -q "$archive" "$name/node.exe" "$name/LICENSE" -d "$work" ;;
esac
if [ "$os" = win ]; then install -m 0755 "$work/$name/node.exe" "$dest/runtime/node.exe"
else install -m 0755 "$work/$name/bin/node" "$dest/runtime/bin/node"; fi
install -m 0644 "$work/$name/LICENSE" "$dest/runtime/LICENSE"
echo "bundled Node.js v${NODE_VERSION} for $os-$arch (sha256 $pin)"
