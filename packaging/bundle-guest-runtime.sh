#!/usr/bin/env bash
# Stage Linux runtimes before signing the enclosing package.
set -euo pipefail
os="${1:?host OS}"; arch="${2:?host architecture}"; dest="${3:?package root}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$dest/guest-runtime"
arches=("$arch")
# Both native Mac legs must have identical resources for universal merging.
[ "$os" != darwin ] || arches=(x64 arm64)
for guest_arch in "${arches[@]}"; do
  target="$dest/guest-runtime/linux-$guest_arch"
  mkdir -p "$target"
  if [ "$os" = linux ] && [ "$arch" = "$guest_arch" ]; then
    ln -sf ../../runtime/bin/node "$target/node"
  else
    # A host macOS archive cannot also be the Linux guest archive.
    guest_archive_var="FARAVAN_GUEST_NODE_TARBALL_linux_$guest_arch"
    guest_archive="${!guest_archive_var:-}"
    (unset FARAVAN_NODE_TARBALL
     [ -z "$guest_archive" ] || export FARAVAN_NODE_TARBALL="$guest_archive"
     "$here/bundle-node.sh" linux "$guest_arch" "$target")
    mv "$target/runtime/bin/node" "$target/node"
    mv "$target/runtime/LICENSE" "$target/LICENSE"
    rmdir "$target/runtime/bin" "$target/runtime"
  fi
done
# The host runtime is bundled already; no host PATH lookup is needed.
"$dest/runtime/bin/node" --input-type=module - "$dest" "${arches[@]}" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [dest, ...arches] = process.argv.slice(2);
const manifest = Object.fromEntries(arches.map(arch => [`linux-${arch}`, {
  sha256: createHash('sha256').update(readFileSync(`${dest}/guest-runtime/linux-${arch}/node`)).digest('hex')
}]));
writeFileSync(`${dest}/guest-runtime/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
JS
