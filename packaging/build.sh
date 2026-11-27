#!/usr/bin/env bash
# Build Linux artifacts from an explicit, inspectable staging tree.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$package_dir/.." && pwd)"
stage_dir="$package_dir/stage"
dist_dir="$package_dir/dist"
package_version="${PACKAGE_VERSION:-0.1.0}"

# Record immutable source identity before build/toolchain/staging effects.
# Only this source root may supply HEAD; never discover an ancestor checkout.
source_error() { echo "PACKAGE_SOURCE_SHA: $*" >&2; exit 2; }
explicit_source="${PACKAGE_SOURCE_SHA-}"
if [ "${PACKAGE_SOURCE_SHA+x}" = x ] && [[ ! "$explicit_source" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  source_error "must be a full 40-hex source commit"
fi
checkout_source=""
if [ -e "$repo_root/.git" ]; then
  source_git() { env -i PATH="$PATH" HOME="${HOME:-}" GIT_CONFIG_NOSYSTEM=1 git -C "$repo_root" "$@"; }
  checkout_top="$(source_git rev-parse --show-toplevel 2>/dev/null)" || source_error "cannot verify source checkout Git metadata"
  [ "$(cd "$checkout_top" && pwd -P)" = "$(cd "$repo_root" && pwd -P)" ] || source_error "Git metadata identifies another checkout"
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

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

[[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || {
  echo "PACKAGE_VERSION must be a semver value such as 0.1.0, got: $package_version" >&2
  exit 1
}
require_command go
require_command node

# shellcheck source=deb-version.sh
. "$package_dir/deb-version.sh"
# Both Debian paths read these, so dpkg-deb and nFPM cannot disagree about the version.
PACKAGE_DEB_VERSION="$(deb_upstream_version "$package_version")"
export PACKAGE_DEB_VERSION
PACKAGE_DEB_FULL_VERSION="$(deb_full_version "$package_version")"
export PACKAGE_DEB_FULL_VERSION

. "$package_dir/nfpm.env"

nfpm_package() {
  local packager="$1"
  local target="$2"

  if command -v nfpm >/dev/null 2>&1; then
    (
      cd "$package_dir"
      PACKAGE_VERSION="$package_version" nfpm package \
        --config nfpm.yaml \
        --packager "$packager" \
        --target "$target"
    )
    return
  fi

  require_command docker
  # Keep the release toolchain hermetic when a developer does not have nFPM.
  # The bind mount lets nFPM see the same relative paths declared in nfpm.yaml.
  docker run --rm --user "$(id -u):$(id -g)" \
    -e PACKAGE_VERSION="$package_version" \
    -e PACKAGE_DEB_VERSION="$PACKAGE_DEB_VERSION" \
    -e PACKAGE_DEB_FULL_VERSION="$PACKAGE_DEB_FULL_VERSION" \
    -v "$package_dir:/work" \
    -w /work \
    "$NFPM_IMAGE" \
    package --config nfpm.yaml --packager "$packager" --target "$target"
}

rm -rf "$stage_dir"
mkdir -p "$stage_dir/usr/lib/faravan/bin" \
  "$stage_dir/usr/lib/faravan/lib" \
  "$stage_dir/usr/lib/faravan/coordinator" \
  "$stage_dir/usr/lib/faravan/public" \
  "$stage_dir/usr/bin" \
  "$stage_dir/usr/lib/systemd/user" \
  "$stage_dir/usr/share/applications" \
  "$stage_dir/usr/share/icons/hicolor/512x512/apps" \
  "$stage_dir/etc/xdg/autostart" \
  "$dist_dir"

# Faravan's own files; the scope is explicit (packaging/stage-app.sh), never the rest of the repository.
"$package_dir/stage-app.sh" "$stage_dir/usr/lib/faravan" "$package_version"
printf '{"schemaVersion":1,"sourceSha":"%s","version":"%s"}\n' "$source_sha" "$package_version" > "$stage_dir/usr/lib/faravan/installed-source.json"


(cd "$repo_root/tray" && go build -trimpath -o "$stage_dir/usr/lib/faravan/faravan-tray" ./cmd/faravan-tray)

# Stage integrations too, so Debian and tarball payloads have the same files.
install -m 0644 "$package_dir/assets/faravan-app.service" "$package_dir/assets/faravan-coordinator.service" "$package_dir/assets/faravan-tray.service" "$stage_dir/usr/lib/systemd/user/"
install -D -m 0755 "$package_dir/assets/faravan-tray-start" "$stage_dir/usr/lib/faravan/bin/faravan-tray-start"
install -D -m 0644 "$package_dir/assets/faravan-session-environment.sh" "$stage_dir/usr/lib/faravan/lib/session-environment.sh"
install -m 0644 "$package_dir/assets/faravan-open-link.desktop" "$stage_dir/usr/share/applications/"
# The launcher gives Faravan a dock and app-grid entry (the only one on a desktop with no tray),
# and notifications name it through the desktop-entry hint.
install -m 0644 "$package_dir/assets/faravan.desktop" "$stage_dir/usr/share/applications/"
install -m 0644 "$stage_dir/usr/lib/faravan/public/v1/icon-512.png" "$stage_dir/usr/share/icons/hicolor/512x512/apps/faravan.png"
install -m 0644 "$package_dir/assets/faravan-tray.desktop" "$stage_dir/etc/xdg/autostart/"

# D6: the Node.js runtime ships inside the package, so no system Node is needed. FARAVAN_NODE_BIN
# (development) or FARAVAN_NODE_TARBALL (offline) override the pinned download; see bundle-node.sh.
"$package_dir/bundle-node.sh" linux x64 "$stage_dir/usr/lib/faravan"
"$package_dir/bundle-guest-runtime.sh" linux x64 "$stage_dir/usr/lib/faravan"

# nFPM preserves source directory modes. Do not let a developer's permissive
# umask turn application paths into group-writable package paths.
chmod -R go-w "$stage_dir"
find "$stage_dir" -type d -exec chmod 0755 {} +

# The launcher finds the bundled runtime from its own location, so it works at /usr or anywhere the
# tree is unpacked, and it never looks for a system node.
cat >"$stage_dir/usr/bin/faravan" <<'EOF'
#!/bin/sh
set -eu

self=$(readlink -f "$0")
root=$(cd "$(dirname "$self")/../lib/faravan" && pwd)
if [ ! -x "$root/runtime/bin/node" ] || [ ! -f "$root/bin/faravan" ]; then
  echo "Faravan cannot start: bundled Node or product entrypoint is missing. Reinstall the complete Faravan package; system Node is not a substitute." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Faravan cannot start: Python 3 is required for verification. On Ubuntu run: sudo apt install python3. Then retry; do not skip verification." >&2
  exit 1
fi
exec "$root/runtime/bin/node" "$root/bin/faravan" "$@"
EOF
chmod 0755 "$stage_dir/usr/bin/faravan"

# Verify the final layout only after bundled runtimes and launchers exist.
node "$package_dir/check-staged-runtime.mjs" "$stage_dir/usr/lib/faravan" --linux-package "$package_dir/nfpm.yaml" nfpm


# dpkg-deb builds the same package from the same staging tree when nFPM and Docker are not available
# (or when PACKAGE_DEB_TOOL=dpkg-deb). The content is the stage tree; only the control data is written here.
dpkg_deb_package() {
  local target="$1" root
  require_command dpkg-deb
  # The scratch root must share a filesystem with the stage tree: cp -al cannot hard-link across
  # devices, and $TMPDIR is often tmpfs (/tmp). dist/ is git-ignored and sits beside the stage.
  mkdir -p "$dist_dir"
  root="$(mktemp -d "$dist_dir/.deb-root.XXXXXX")"
  cp -al "$stage_dir/." "$root/" # hard links: the runtime is large
  mkdir -p "$root/DEBIAN"
  cat >"$root/DEBIAN/control" <<EOF
Package: faravan
Version: ${DEB_EPOCH}:${PACKAGE_DEB_VERSION}-${DEB_REVISION}
Architecture: amd64
Maintainer: Alex Example <maintainers@example.invalid>
Section: utils
Priority: optional
Homepage: https://github.com/tnunamak/faravan
Depends: python3
Suggests: docker-sbx
Installed-Size: $(du -sk "$stage_dir" | cut -f1)
Description: Local Faravan app, browser UI, and native tray helper
 Carries its own Node.js runtime; no system Node.js is needed.
EOF
  # Check the actual fallback control data as well as nFPM declarations.
  node "$package_dir/check-staged-runtime.mjs" "$root/usr/lib/faravan" --linux-package "$root/DEBIAN/control" deb-control
  install -m 0755 "$package_dir/scripts/preinstall.sh" "$root/DEBIAN/preinst"
  install -m 0755 "$package_dir/scripts/postinstall.sh" "$root/DEBIAN/postinst"
  install -m 0755 "$package_dir/scripts/remove.sh" "$root/DEBIAN/prerm"
  install -m 0755 "$package_dir/scripts/remove.sh" "$root/DEBIAN/postrm"
  dpkg-deb --root-owner-group "-Z${DEB_COMPRESSION:-xz}" --build "$root" "$package_dir/$target" >/dev/null
  rm -rf "$root"
}

# The nFPM target stays relative to packaging/ so the same config works for a
# local executable and the Docker fallback (where this directory is /work).
if [ "${PACKAGE_DEB_TOOL:-}" = dpkg-deb ] || { ! command -v nfpm >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; }; then
  dpkg_deb_package "dist/faravan_${package_version}_amd64.deb"
else
  nfpm_package deb "dist/faravan_${package_version}_amd64.deb"
fi
# nFPM does not provide a portable tar packager. Archive the same staged
# filesystem tree, which keeps the fallback payload byte-for-byte aligned with
# the Debian package's runtime.
tar -C "$stage_dir" -czf "$dist_dir/faravan_${package_version}_linux_amd64.tar.gz" usr etc

# Public previews use a marked portable tree; the dated isolated launcher stays opt-out.
if [[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]{8}\.[0-9]+$ ]]; then
  "$package_dir/linux-download.sh" "$stage_dir" "$dist_dir"
fi

printf 'built:\n  %s\n  %s\n' \
  "$dist_dir/faravan_${package_version}_amd64.deb" \
  "$dist_dir/faravan_${package_version}_linux_amd64.tar.gz"
