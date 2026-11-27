#!/usr/bin/env bash
# Copy Faravan's own files (entry points, runtime modules, UI, schemas, kits, VERSION) into DEST.
# Shared by the Linux package build (build.sh), macOS (macos/build-app.sh) and Windows (windows/build-layout.ps1
# runs the same steps). It does not add a Node runtime or the tray: see bundle-node.sh and the build scripts.
#   FARAVAN_PI_PAYLOAD=/path/to/linux-pi-payload.tgz packaging/stage-app.sh DEST VERSION
set -euo pipefail
dest="${1:?destination directory}"; package_version="${2:?version}"
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$package_dir/.." && pwd)"
# One Linux-built payload serves Linux guests on every installed platform.
# Verify a supplied artifact against this checkout before any staging effects.
pi_pin="$repo_root/kits/wf-pi/files/home/.faravan/pi-payload.sha256"
if [ "${FARAVAN_PI_PAYLOAD+x}" = x ]; then
  [ -n "$FARAVAN_PI_PAYLOAD" ] || { echo "FARAVAN_PI_PAYLOAD must name the pinned Linux-built pi-payload.tgz" >&2; exit 2; }
  node "$package_dir/check-staged-runtime.mjs" --pi-payload "$FARAVAN_PI_PAYLOAD" "$pi_pin"
elif [ "$(uname -s)" != Linux ]; then
  echo "Build scripts/build-pi-payload.sh --check OUT.tgz on Linux, then rerun packaging with FARAVAN_PI_PAYLOAD=/path/to/OUT.tgz." >&2
  exit 2
fi
install_data() {
  mkdir -p "$(dirname "$2")"
  install -m 0644 "$1" "$2"
}
mkdir -p "$dest/bin" "$dest/lib" "$dest/public"
# Keep the package scope explicit: only Faravan entry points and their Node
# modules are staged, never the rest of the Waspflow control plane.
# A read loop rather than `xargs -r`, which BSD xargs on macOS does not document.
find "$repo_root/bin" -maxdepth 1 -type f -name 'faravan*' -print0 |
  while IFS= read -r -d '' path; do install -m 0755 "$path" "$dest/bin/"; done

# bin/faravan is a symlink to the shim. The find above matches regular files only, so copy the link itself.
find "$repo_root/bin" -maxdepth 1 -type l -name 'faravan*' -print0 |
  while IFS= read -r -d '' path; do cp -P "$path" "$dest/bin/"; done
# Runtime modules, recursively (lib/protocol, lib/harnesses, ...), including
# CommonJS worker entry points, plus files they read at runtime: the GitHub
# sbx kit and the v1 JSON Schemas that lib/protocol imports from ../../docs/protocol.
# JSON under lib is runtime data that modules import (price catalog, calibration provenance,
# telemetry catalog, public model list), so stage it by pattern: a new JSON import cannot be missed.
(cd "$repo_root" && find lib -type f \( -name '*.mjs' -o -name '*.cjs' -o -name '*.json' \) -print0 | while IFS= read -r -d '' path; do install_data "$path" "$dest/$path"; done)
# The app refreshes list prices itself in the background. Staging reads the network only
# when price refresh is requested; production dependencies must already be in the npm cache.
if [ "${FARAVAN_REFRESH_PRICES:-0}" = 1 ]; then
  node "$repo_root/scripts/refresh-lending-prices.mjs" "$dest/lib/v1/lending-prices.json"
fi
(cd "$repo_root" && find kits -type f -print0 | while IFS= read -r -d '' path; do install_data "$path" "$dest/$path"; done)
# Never build Darwin node_modules for a Linux guest or use the guest registry.
pi_dest="$dest/kits/wf-pi/files/home/.faravan/pi-payload.tgz"
if [ "${FARAVAN_PI_PAYLOAD+x}" = x ]; then
  node "$package_dir/check-staged-runtime.mjs" --pi-payload "$FARAVAN_PI_PAYLOAD" "$pi_pin" "$pi_dest"
else
  bash "$repo_root/scripts/build-pi-payload.sh" --check "$pi_dest"
  node "$package_dir/check-staged-runtime.mjs" --pi-payload "$pi_dest" "$pi_pin"
fi
# bin/faravan-detect-sbx enforces the sbx version range from this profile.
install_data "$repo_root/profiles/faravan-docker.json" "$dest/profiles/faravan-docker.json"
(cd "$repo_root" && find docs/protocol -maxdepth 1 -type f -name '*.schema.json' -print0 | while IFS= read -r -d '' path; do install_data "$path" "$dest/$path"; done)
# S5.2 evidence for `safety.credential_proxy_verified`; without it the flag stays false.
install_data "$repo_root/docs/security/credential-proxy-evidence.json" "$dest/docs/security/credential-proxy-evidence.json"
(cd "$repo_root" && find public -type f -print0 | while IFS= read -r -d '' path; do install_data "$path" "$dest/$path"; done)
# The Streamable HTTP MCP transport uses the official SDK at runtime. Stage only production dependencies.
install -m 0644 "$repo_root"/package.json "$repo_root"/package-lock.json "$dest/"
# Carry the immutable candidate when the production manifest pins a local SDK archive.
candidate=$(node -e '
  const pin = require(process.argv[1]).dependencies?.["@tnunamak/gozar"];
  if (/^file:vendor\/tnunamak-gozar-\d+\.\d+\.\d+\.tgz$/.test(pin)) process.stdout.write(pin.slice(5));
' "$repo_root/package.json")
if [ -n "$candidate" ]; then
  install_data "$repo_root/$candidate" "$dest/$candidate"
fi
# Prime the cache explicitly from this checkout before an offline build:
#   npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# Use the same npm cache (npm_config_cache, or npm default home cache) for both steps.
# An unprimed cache fails loudly here instead of downloading at build time.
npm ci --offline --prefix "$dest" --omit=dev --ignore-scripts --no-audit --no-fund

# The tarball install reads this to decide whether a newer signed release exists (lib/v1/self-update.mjs).
printf '%s\n' "$package_version" > "$dest/VERSION"
# Faravan's own licence travels with every package.
install_data "$repo_root/LICENSE.md" "$dest/LICENSE.md"
