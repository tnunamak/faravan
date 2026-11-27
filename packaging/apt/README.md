# Faravan apt repository and update keys

Nothing here publishes anything. These steps are for the person who owns releases.

## Two keys, two jobs

| Key | Signs | Used by | Public half lives in |
|---|---|---|---|
| Archive key (OpenPGP, RSA 4096) | the apt `Release` file | `apt` on a `.deb` install | `faravan-archive-keyring.gpg` in the repository; its fingerprint is pinned in `bin/faravan-install.sh` (`APT_KEY_FPR`) |
| Update key (Ed25519) | `update.json` for Linux tarballs and Mac app ZIPs | the app's update verifiers | `lib/v1/update-key.mjs` |

Private halves are never committed. The existing update key's private half is held by the release owner,
**off all CI**; only the public half is shipped. Archive signing is separate.

## Make the archive key once

On an offline or well-protected machine, with a passphrase:

```sh
export GNUPGHOME="$HOME/.faravan-archive-gnupg"; mkdir -m 700 "$GNUPGHOME"
gpg --quick-generate-key "Faravan archive signing key <archive@example.invalid>" rsa4096 sign 5y
gpg --list-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}'   # the fingerprint: put it in APT_KEY_FPR
gpg --armor --export-secret-keys > faravan-archive-private.asc        # back up offline, then delete from the disk
```

A key that expires needs a renewal date in the calendar. Rotation: publish the new
public key, ship a `.deb` that replaces `/usr/share/keyrings/faravan-archive-keyring.gpg`,
and keep signing with both keys for one release. A rotated key fails safely until its
replacement is installed (apt refuses an unknown signer). `build-repo.sh` never changes the key of an
existing `--out`; build the rotated repository into a new `--out`.

## Existing update key

The Ed25519 update key exists, and its public half is pinned as `UPDATE_PUBLIC_KEY` in
`lib/v1/update-key.mjs` (made on 2026-11-02). Do not generate a replacement for a release or put
its private half in CI. Builds before the pin carry no key and refuse updates before making a
request, so a teammate on such a build must reinstall once. Losing the private half strands every
install on its version until a manual reinstall, so keep an offline backup. Keep the private key
outside the repository and use it only on the release owner's signing machine.

## Cut a preview update

After building the final Linux tarball and final Mac arm64 ZIP, run this **on the release owner's machine**:

```sh
VERSION=0.1.0-preview.20261102.45
# Absolute public, unauthenticated URLs for these immutable artifact bytes:
LINUX_URL="https://tnunamak.github.io/faravan-updates/artifacts/linux-${VERSION}.tar.gz"
MAC_URL="https://tnunamak.github.io/faravan-updates/artifacts/mac-arm64-${VERSION}.zip"
node packaging/sign-update.mjs --version "$VERSION" \
  --key "$HOME/.config/faravan-release/update-private.pem" --out packaging/dist/preview \
  --tarball "packaging/dist/faravan-linux-x64-${VERSION}.tar.gz" --tarball-url "$LINUX_URL" \
  --linux-channel faravan --linux-arch x64 \
  --mac-zip packaging/dist/Faravan-arm64.zip --mac-url "$MAC_URL" \
  --mac-channel faravan --mac-bundle-id com.faravan.app
```

The command writes `update.json` plus `update.json.sig`, signing the exact manifest bytes. It uploads nothing.
The manifest keeps the legacy Linux `tarball`, `size`, and `sha256` fields and includes `assets_schema: 1`
with labeled Linux `tarball` and Darwin `macos-app-zip` assets (URL, byte size and SHA-256).
Linux metadata must agree with the legacy fields. `--asset-map` remains available instead of the four
`--mac-*` flags; preview signing also needs `--linux-channel`. Do not duplicate the Linux asset in the map.

As separate release-owner actions, upload both final artifacts to their public URLs, then publish the two
manifest files at `https://tnunamak.github.io/faravan-updates/preview/`. The default feed is
`https://tnunamak.github.io/faravan-updates/preview/update.json` on both platforms; `FARAVAN_UPDATE_URL`
overrides it. Do not use the private GitHub repository's `releases/latest` endpoint for previews.
Verify both downloads and the manifest/signature pair before announcing the release.

The install labels above stay fixed for the install's life, independently of the version's build date.
The Mac ZIP must preserve its channel and bundle identity; Linux must preserve its channel identity.
Versions are ordered numerically by version components, date, then build number, and never cross
between stable and preview. Assets with a different installed label are refused.

## Cut a release (what the release process does)

```sh
PACKAGE_VERSION=0.2.0 packaging/build.sh                      # .deb and tarball into packaging/dist/
packaging/apt/build-repo.sh --out repo --key "$FPR" packaging/dist/faravan_0.2.0_amd64.deb packaging/dist/faravan-transition_0.2.0_amd64.deb
# keep earlier .deb files in the command to keep older versions in the pool
node packaging/sign-update.mjs --tarball packaging/dist/faravan_0.2.0_linux_amd64.tar.gz \
  --version 0.2.0 --key "$HOME/.config/faravan-release/update-private.pem" --out packaging/dist \
  --linux-channel faravan --tarball-url "$TARBALL_URL" \
  --deb packaging/dist/faravan_0.2.0_amd64.deb --deb-arch x64
```

Pass the `.deb` to `sign-update.mjs` so its top-level `deb` object is signed. The object holds the file's arch, channel, size, sha256 and
file name. It sits beside the tarball, not in `assets`: older clients validate `assets` and refuse kinds they do not know, so a deb
asset would break their update check. `--deb` needs `--linux-channel`, which also signs the tarball, so `--tarball-url` must be absolute.
A manifest carries one `.deb` object. The top-level tarball is x64; an arm64 tarball would be an `assets` entry (kind `tarball`, arch `arm64`).
The installer fetches `update.json` and `update.json.sig` from the same release as the file it installs, and fails closed without them.

Then, as separate, deliberate steps that this repository does not automate:

1. Serve `repo/` over HTTPS at the host named in `FARAVAN_APT_BASE` (default `https://sparekin.app/apt`).
2. Attach the tarball, the `.deb`, `update.json` and `update.json.sig` to the GitHub release. `update.json` and `update.json.sig` must sit beside both packages.
3. Fill in `APT_KEY_FPR` in the installer and `UPDATE_PUBLIC_KEY`, in the same release.

## User upgrades

Run `sudo apt update` and `sudo apt upgrade`. The latter can install the new `faravan` dependency through the empty `faravan` transition. Plain `apt-get upgrade` cannot install that new dependency. `docker-sbx` is an optional Suggests because this repository does not serve it; doctor checks whether it is available when local lending is requested.
