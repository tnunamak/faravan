#!/usr/bin/env bash
# Build the pinned pi payload that kits/wf-pi unpacks into a sandbox with no network.
#   scripts/build-pi-payload.sh OUT.tgz
# Inputs: packaging/pi-payload/package.json and package-lock.json (every package pinned by integrity).
# `npm ci` needs the registry (or a primed npm cache) here, on the build host. The guest never does.
# The archive is deterministic (sorted names, zero times and owners, gzip without a name), so its sha256 is
# the pin in kits/wf-pi/files/home/.faravan/pi-payload.sha256. Pass --check to compare with that pin.
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo "Build pi-payload.tgz on Linux; pass that pinned artifact to packaging via FARAVAN_PI_PAYLOAD." >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
check=0; [ "${1:-}" = --check ] && { check=1; shift; }
out=${1:?usage: build-pi-payload.sh [--check] OUT.tgz}
work=$(mktemp -d "${TMPDIR:-$HOME/.tmp}/faravan-pi-payload.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$here/packaging/pi-payload/package.json" "$here/packaging/pi-payload/package-lock.json" "$work/"
(cd "$work" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null)
tar -C "$work" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - node_modules | gzip -n -9 > "$out"
sha=$(sha256sum "$out" | cut -d' ' -f1)
echo "pi-payload sha256=$sha bytes=$(stat -c %s "$out")"
if [ "$check" = 1 ]; then
  pinned=$(cut -d' ' -f1 "$here/kits/wf-pi/files/home/.faravan/pi-payload.sha256")
  [ "$sha" = "$pinned" ] || { echo "payload differs from the pin $pinned" >&2; exit 1; }
fi
