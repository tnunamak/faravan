#!/usr/bin/env bash
# Builds a signed apt repository directory from one or more .deb files.
#
#   packaging/apt/build-repo.sh --out DIR --key KEYID [--gnupghome DIR] \
#       [--suite stable] [--origin Faravan] FILE.deb...
#
# Result (serve DIR over HTTPS as the repository root):
#   pool/main/s/faravan/*.deb
#   dists/<suite>/main/binary-amd64/Packages{,.gz,.xz}
#   dists/<suite>/Release, InRelease (clearsigned), Release.gpg (detached)
#   faravan-archive-keyring.gpg  (binary, for signed-by) and .asc (armored)
#
# Building one suite never removes another: the suite is built and signed in a candidate tree and then
# swapped in, and its index lists exactly the .deb files given. Run it once per suite.
#
# This only writes files under --out. It never uploads anything. The signing key
# is read from the GnuPG home (--gnupghome or the default); it is never copied.
# See packaging/apt/README.md for how the real key is made and kept.
set -euo pipefail

out="" key="" gnupghome="" suite="stable" origin="Faravan" debs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    --gnupghome) gnupghome="$2"; shift 2 ;;
    --suite) suite="$2"; shift 2 ;;
    --origin) origin="$2"; shift 2 ;;
    --*) echo "unknown option: $1" >&2; exit 2 ;;
    *) debs+=("$1"); shift ;;
  esac
done
[ -n "$out" ] && [ -n "$key" ] && [ ${#debs[@]} -gt 0 ] || { echo "usage: build-repo.sh --out DIR --key KEYID [--gnupghome DIR] [--suite stable] FILE.deb..." >&2; exit 2; }
for tool in apt-ftparchive gpg gzip xz dpkg-deb; do
  command -v "$tool" >/dev/null 2>&1 || { echo "need '$tool' (apt-utils, gnupg, dpkg)" >&2; exit 1; }
done
gpg_cmd=(gpg --batch --yes)
[ -z "$gnupghome" ] || gpg_cmd+=(--homedir "$gnupghome")

# Check everything that can be checked before anything on disk changes. A bad suite name or a bad
# .deb must not leave a half-built repository, and the suite name becomes a directory name.
[[ "$suite" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "invalid suite name: $suite (lowercase letters, digits and hyphens)" >&2; exit 2; }
declare -A seen_names=()
for deb in "${debs[@]}"; do
  [ -z "${seen_names[${deb##*/}]:-}" ] || { echo "two inputs share the file name ${deb##*/}; the pool keeps one file per name" >&2; exit 1; }
  seen_names[${deb##*/}]=1
  [ -f "$deb" ] || { echo "no such file: $deb" >&2; exit 1; }
  case "$(dpkg-deb --field "$deb" Package)" in
    faravan|faravan) ;;
    *) echo "$deb is not a Faravan or transitional package" >&2; exit 1 ;;
  esac
  # Only amd64 index exists. An arm64 .deb listed there would install a binary that cannot run.
  [ "$(dpkg-deb --field "$deb" Architecture)" = amd64 ] || { echo "$deb is not an amd64 package" >&2; exit 1; }
done

mkdir -p "$out"
out="$(cd "$out" && pwd)"

# Build the whole suite in a candidate tree, sign it there, and only then put it in place. Other
# suites under dists/ are never touched, and a failed build (including a failed signature) changes
# nothing in $out. $candidate holds only this suite's .deb files, so its Packages index lists
# exactly the files given and never a .deb that another suite published into the shared pool.
candidate="$(mktemp -d "$out/.candidate.XXXXXX")"
pool_partial=() # a pool file being written; removed if the build stops before its rename
cleanup() { rm -rf -- "$candidate"; [ ${#pool_partial[@]} -eq 0 ] || rm -f -- "${pool_partial[@]}"; }
trap cleanup EXIT
pool_path=pool/main/s/faravan
dist="$candidate/dists/$suite"
mkdir -p "$candidate/$pool_path" "$dist/main/binary-amd64"
for deb in "${debs[@]}"; do install -m 0644 "$deb" "$candidate/$pool_path/"; done

# Package paths in the index are relative to the repository root.
(cd "$candidate" && apt-ftparchive packages pool > "dists/$suite/main/binary-amd64/Packages")
gzip -9nk "$dist/main/binary-amd64/Packages"
xz -9k "$dist/main/binary-amd64/Packages"

# Release lists every index with its hash. No Valid-Until: an offline-key
# repository that releases rarely must not stop working because it is quiet.
(cd "$dist" && apt-ftparchive \
  -o "APT::FTPArchive::Release::Origin=$origin" -o "APT::FTPArchive::Release::Label=$origin" \
  -o "APT::FTPArchive::Release::Suite=$suite" -o "APT::FTPArchive::Release::Codename=$suite" \
  -o "APT::FTPArchive::Release::Architectures=amd64" -o "APT::FTPArchive::Release::Components=main" \
  release . > "$candidate/Release.tmp")
mv "$candidate/Release.tmp" "$dist/Release"
"${gpg_cmd[@]}" --local-user "$key" --clearsign -o "$dist/InRelease" "$dist/Release"
"${gpg_cmd[@]}" --local-user "$key" --armor --detach-sign -o "$dist/Release.gpg" "$dist/Release"

# The public half of the key leaves the key store here, into the candidate, so a failed export changes nothing published.
"${gpg_cmd[@]}" --export "$key" > "$candidate/faravan-archive-keyring.gpg"
"${gpg_cmd[@]}" --armor --export "$key" > "$candidate/faravan-archive-keyring.asc"
fingerprint="$("${gpg_cmd[@]}" --with-colons --fingerprint "$key" | awk -F: '/^fpr:/ {print $10; exit}')"
[ -n "$fingerprint" ] || { echo "no fingerprint for key $key" >&2; exit 1; }
printf '%s\n' "$fingerprint" > "$candidate/faravan-archive-keyring.fingerprint"

# Every check that can refuse the build comes before the first change to $out.
# 1. A published .deb name is immutable. The pool is shared, and any suite's signed index names the hash of the
#    bytes it was built with, so a file with the same name and other bytes breaks every client holding that
#    index (and a later rollback of the index would then name bytes that are gone). Ship a new version instead.
mkdir -p "$out/$pool_path" "$out/dists"
for staged in "$candidate/$pool_path/"*.deb; do
  target="$out/$pool_path/${staged##*/}"
  if [ -e "$target" ] && ! cmp -s "$staged" "$target"; then
    echo "refusing to replace ${staged##*/}: a published file of that name has different contents. Build a new version." >&2
    exit 1
  fi
done
# 2. One keyring serves every suite, and a key change cannot be committed together with a suite swap. Do not change
#    the published key in place: build the rotated repository into a new --out and publish that.
if [ -s "$out/faravan-archive-keyring.fingerprint" ] && [ "$(cat "$out/faravan-archive-keyring.fingerprint")" != "$fingerprint" ]; then
  echo "refusing to sign with a different key than the one published in $out. To rotate keys, build into a new --out." >&2
  exit 1
fi
# 3. A build stopped between the two directory renames below leaves the old suite under dists/.previous-<suite>.*;
#    put it back before building on top of it.
if [ ! -e "$out/dists/$suite" ]; then
  for leftover in "$out"/dists/.previous-"$suite".*; do
    [ -d "$leftover" ] || continue
    mv -T "$leftover" "$out/dists/$suite"
    break
  done
fi

# Promote. A .deb is written beside its name and renamed, so a client never reads half a file, and an identical file is left alone.
for staged in "$candidate/$pool_path/"*.deb; do
  target="$out/$pool_path/${staged##*/}"
  if [ -e "$target" ] && cmp -s "$staged" "$target"; then continue; fi
  pool_partial+=("$target.new")
  install -m 0644 "$staged" "$target.new"
  mv -f "$target.new" "$target"
done
# Then this suite's directory. The old one is set aside outside the candidate and put back if the swap fails.
previous="$out/dists/.previous-$suite.$$"
if [ -e "$out/dists/$suite" ]; then mv -T "$out/dists/$suite" "$previous"; fi
if ! mv -T "$dist" "$out/dists/$suite"; then
  if [ -e "$previous" ]; then mv -T "$previous" "$out/dists/$suite"; fi
  echo "could not put suite $suite in place; the previous $suite was restored" >&2
  exit 1
fi
rm -rf -- "$previous"
for artifact in faravan-archive-keyring.gpg faravan-archive-keyring.asc faravan-archive-keyring.fingerprint; do
  mv -f "$candidate/$artifact" "$out/$artifact"
done
echo "repository: $out"
echo "fingerprint: $fingerprint"
