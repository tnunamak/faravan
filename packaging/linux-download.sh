#!/usr/bin/env bash
# Build the public, self-updating Linux preview from build.sh's staged runtime.
# The dated side-by-side launcher remains a separate, non-updating artifact.
set -euo pipefail
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage="${1:-$package_dir/stage}"
dist="${2:-$package_dir/dist}"
version=$(cat "$stage/usr/lib/faravan/VERSION")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]{8}\.[0-9]+$ ]] || {
  echo 'The public preview download needs a dated preview version.' >&2; exit 1;
}
for file in usr/bin/faravan usr/lib/faravan/bin/faravan usr/lib/faravan/runtime/bin/node usr/lib/faravan/faravan-tray; do
  [ -x "$stage/$file" ] || { echo 'The staged download is missing an executable.' >&2; exit 1; }
done
mkdir -p "$dist"
work=$(mktemp -d "$dist/.linux-download.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Only the runtime and relocatable commands belong in an extracted download.
# Package autostart files and the isolated preview launcher do not belong here.
mkdir -p "$work/usr/bin" "$work/usr/lib"
cp -a "$stage/usr/lib/faravan" "$work/usr/lib/"
cp -a "$stage/usr/bin/faravan" "$work/usr/bin/"
printf 'tarball\n' > "$work/usr/lib/faravan/.installed-via"
# Install-life identity matches Mac; it must not change with the release date.
cat > "$work/usr/lib/faravan/channel.json" <<'CHANNEL'
{"id":"faravan","name":"Faravan","dataFolder":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify","launchAgentLabel":"com.faravan.agent","linuxPrefix":"faravan"}
CHANNEL
archive="$dist/faravan-linux-x64-$version.tar.gz"
# A root extraction keeps modes and owners, so the archive must not carry the builder's.
chmod -R go-w "$work/usr"
# Keep incomplete output private and retain the last complete artifact on failure.
# The staging directory is on the destination filesystem; rename publishes the
# completed archive without exposing partially written bytes.
tar -C "$work" --owner=0 --group=0 --numeric-owner -czf "$work/archive.tar.gz" usr
mv -T -- "$work/archive.tar.gz" "$archive"
printf 'built: %s\n' "$archive"
