#!/usr/bin/env bash
# Merge two native legs from build-app.sh into one universal Faravan.app.
#   packaging/macos/build-universal.sh ARM64_APP X86_64_APP OUTPUT/Faravan.app
# The legs may differ only inside Mach-O files, and each must be a thin binary of its own architecture.
# Any other difference (a file, a mode, a symlink target, a file in one leg only), a symlink that is absolute
# or leaves the bundle, a signed leg, or the development Node runtime stops the merge before lipo runs.
# The result is built beside OUTPUT and replaces it only after verify-app.sh passes. It is UNSIGNED: sign
# with sign-notarize.sh, after this step, never before.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arm="${1:?arm64 Faravan.app}"; x64="${2:?x86_64 Faravan.app}"; out="${3:?output Faravan.app}"
name="$(basename "$out")"
# The lock strips this exact suffix. A case-only alias must not get a separate lock.
if [ "${name: -4}" != '.app' ]; then
  echo "build-universal: output basename must end in lowercase .app" >&2
  exit 2
fi
node="${FARAVAN_BUILD_NODE:-node}"
for leg in "$arm" "$x64"; do [ -d "$leg/Contents" ] || { echo "build-universal: $leg is not an app bundle" >&2; exit 2; }; done

machos="$("$node" "$here/bundle-tool.mjs" compare "$arm" "$x64")" || { echo "build-universal: the legs differ in more than their Mach-O files; nothing was merged" >&2; exit 1; }

mkdir -p "$(dirname "$out")"
parent="$(cd "$(dirname "$out")" && pwd -P)"
out="$parent/$name"
# Share the single-leg builder's output lock for Faravan.app.
stem="$(basename "$out" .app)"
lock="$parent/.$stem.build.lock"
mkdir "$lock" 2>/dev/null || { echo "build-universal: another build owns $lock; leave it alone until that build exits" >&2; exit 2; }
stage=""
published=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$stage" ] && { [ -e "$stage/rollback/previous.app" ] || [ -L "$stage/rollback/previous.app" ]; } && [ "$published" = 0 ]; then
    if [ -e "$out" ] || [ -L "$out" ] || ! mv "$stage/rollback/previous.app" "$out"; then
      echo "build-universal: could not restore previous app; preserved at $stage/rollback/previous.app" >&2
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
stage="$(mktemp -d "$parent/.$stem.build.XXXXXX")"
# Caller-selected basenames cannot alias rollback storage or lipo scratch.
mkdir "$stage/payload" "$stage/rollback"
partial="$stage/payload/$name"
cp -pR "$arm" "$partial"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  # Write into the copied file, so it keeps the mode cp -p gave it (stat flags differ between BSD and GNU).
  lipo -create "$arm/$path" "$x64/$path" -output "$stage/merged.lipo"
  cat "$stage/merged.lipo" >"$partial/$path"
  rm -f "$stage/merged.lipo"
done <<<"$machos"
"$here/verify-app.sh" "$partial" universal
# Keep the old tree intact until verification, then retain it until publication succeeds.
if [ -e "$out" ] || [ -L "$out" ]; then
  mv "$out" "$stage/rollback/previous.app"
fi
mv "$partial" "$out"
published=1
echo "build-universal: $out is universal (arm64 + x86_64) and unsigned"
