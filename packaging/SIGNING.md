# Signing and notarization (D5): preparation only

**Platform-signing status: scripts written and tested with stub tools. Nothing was signed, notarized or installed on a clean
machine by that work. No Apple/Microsoft certificate or account was created or requested.** The separate Ed25519
update-manifest key now exists; its private half is held by the release owner, off CI. What to buy, enroll in or
create is the product owner's decision (T27). Developer ID signing stays off; an explicitly
labelled preview can use ad-hoc integrity signatures without notarization.

## What T27 has to decide

| Platform | Needs | Why it matters |
|---|---|---|
| macOS | An Apple Developer Program membership and a **Developer ID Application** certificate; notarization credentials (a `notarytool` keychain profile, or an App Store Connect API key) | Without them Gatekeeper blocks the app, and `brew install --cask` users see a warning. |
| Windows | A code signing certificate whose Subject becomes the MSIX publisher (an EV or OV certificate, or Azure Trusted Signing exported to the store) | An unsigned or untrusted MSIX does not install by double-click. SmartScreen reputation takes time even when signed. |
| Linux | Done in D3: the apt archive key and the update manifest key (`packaging/apt/README.md`) | Separate keys; neither is used here. |

## macOS: `macos/build-app.sh`, then `macos/sign-notarize.sh`

```sh
# Build the two native legs as described in macos/README.md, then merge:
packaging/macos/build-universal.sh arm/Faravan.app intel/Faravan.app universal/Faravan.app
# Unsigned preview: ad-hoc signatures, no identified developer, no notarization.
FARAVAN_MAC_UNSIGNED_PREVIEW=1 packaging/macos/sign-notarize.sh universal/Faravan.app out
# Protected Developer ID stage, only once authorized inputs are provisioned:
export FARAVAN_MAC_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"
export FARAVAN_NOTARY_PROFILE=faravan-notary    # or FARAVAN_NOTARY_KEY_PATH + _KEY_ID + _ISSUER
packaging/macos/sign-notarize.sh universal/Faravan.app out
```

Use separate unsigned and Developer ID job environments; setting both preview
mode and a signing identity is an error. Both paths require a complete universal
bundle. Build output and the output directory must exist before signing.

The script signs inside out: bundled Node, notifier app, tray, CLI script and
outer app (including the native launcher). Only Node gets the JIT entitlements.
Linux guest Node binaries and `guest-runtime/manifest.json` live under Contents/Resources/faravan and are sealed as resources by the outer app signature. They are ELF data on macOS, so they do not receive Mach-O code signatures. The guest manifest is generated before the outer signing step.

It signs without `--deep`, then verifies the sealed bundle with `--deep --strict`.
The Developer ID path adds secure timestamps, submits the zip, requires Accepted,
staples, assesses with Gatekeeper and writes `Faravan.zip`.

The CLI shell script’s signature is stored in extended attributes; archives and
copies must preserve them with `ditto`. This follows [Apple’s code-signing guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).
Notarization and extracted-zip signature validation remain native acceptance
checks. Do not strip attributes from installers to work around a failed signature.

## Windows: `windows/build-layout.ps1`, then `windows/build-msix.ps1`

```powershell
.\packaging\windows\build-layout.ps1 -Version 0.1.0 -Out dist                     # D6, unrun
$env:FARAVAN_WIN_PUBLISHER = "CN=Example Ltd, O=Example Ltd, C=US"             # must equal the certificate's Subject
$env:FARAVAN_WIN_CERT_THUMBPRINT = "<thumbprint of a certificate in the store>"  # preferred
# or FARAVAN_WIN_CERT_PFX + FARAVAN_WIN_CERT_PASSWORD (the password shows in the process list while signtool runs)
.\packaging\windows\build-msix.ps1 -Layout dist\Faravan -Version 0.1.0 -Out dist
```

It fills `AppxManifest.template.xml` (identity, publisher, a four-part version, the `faravan://` invitation protocol and its `faravan://` compatibility alias), runs
`makeappx pack`, `signtool sign /fd SHA256` with an RFC 3161 timestamp, and `signtool verify /pa`.

## Rules for both

- Identities come from environment variables only. Nothing is read from the repository, and a missing value stops the
  script with exit status 2 and a message naming it.
- No script prints a key, a password or a key file's contents (the tests check this). `-DryRun` / `FARAVAN_SIGN_DRY_RUN=1`
  prints each command and runs none.
- Never commit a key, a certificate or a `.pfx`. Authorized platform-signing inputs in CI belong in a protected
  release job, never a pull-request job. The update-manifest private key stays with the release owner, **off CI**.

## Preview update feed (Mac and Linux)

The release owner signs the final Linux tarball and Mac arm64 ZIP with the existing Ed25519 key,
using the single-command procedure in [`apt/README.md`](apt/README.md#cut-a-preview-update).
This signature is distinct from macOS code signing/notarization. Never sign hashes of an intermediate ZIP.

Publish `update.json` and `update.json.sig` together at
`https://tnunamak.github.io/faravan-updates/preview/`. Both platforms use this public, unauthenticated feed
for preview versions unless `FARAVAN_UPDATE_URL` overrides it. Each artifact URL must be absolute HTTPS,
publicly downloadable without credentials, and immutable. Upload artifacts first; publish the manifest pair
only after both are available. A partially replaced pair fails signature verification safely; retry after publication.

Versions such as `0.1.0-preview.20261102.45` advance by build date, then numeric build number.
They never update stable installs, nor do stable versions update preview installs. Native identity does not
change with the version date: existing Mac installs keep `preview-20261028` and
`com.faravan.preview.20261028`. The public self-updating Linux download uses the same fixed channel,
`preview-20261028`. The older isolated Linux preview keeps `preview-20261026` and disables updates. Signed asset labels must match
the installed `channel.json`; do not rename the bundle, profile, or label to the next build date.
The public key is pinned in `lib/v1/update-key.mjs`. Builds made before the pin carry a null key and
refuse updates, so they need one manual reinstall.

## Linux release assets

Publish `update.json` and `update.json.sig` as release assets beside the tarball and the `.deb`. The installer
reads them from the same release as the file it installs and refuses any file they do not describe.
Pass the `.deb` to `packaging/sign-update.mjs` (`--deb`, `--linux-channel`) so its top-level `deb` object is signed.

The installer accepts a signed release only if it is a stable version (`X.Y.Z`, no preview suffix) at or above
`MIN_INSTALL_VERSION` in `bin/faravan-install.sh`. Raise that constant in the same change as each security release, so an
old signed release cannot be installed again. Without this floor, a validly signed old release could be replayed.

## Gate: clean-machine install — NOT RUN

D5 is done only when a person installs the signed artifact on a computer that never built it and sees no warning beyond
the first-run publisher prompt:

1. macOS 14 or later, Apple silicon, fresh user: download the zip in a browser (so it carries the quarantine flag),
   open the app, and see no "cannot be opened" or "unidentified developer" dialog. `spctl --assess` says `accepted` and
   `source=Notarized Developer ID`.
2. Windows 11, a fresh VM: double-click the `.msix`. The App Installer shows the publisher name, installs, and the app starts.
3. The apt gate was built in D3 and is checked by `packaging/smoke.sh` in Docker (also not run on a clean VM).

## Open questions found while writing this

- **Toast identity under MSIX.** The D1 toasts use the AUMID `Faravan.Desktop`, registered under HKCU for an unpackaged
  install. A packaged app's identity is `<package family name>!Faravan`. Whether a toast sent by the PowerShell child
  process appears under the packaged identity must be checked on Windows.
- **Windows service of the app.** The MSIX launches `faravan-tray.exe`, which starts the app (`faravan app`) from the same
  package folder; that start path has not been run on Windows.

## Universal macOS stage (disabled in preview)

`release-macos.yml` builds unsigned artifacts only. Do not silently fall back to
unsigned in a signing job. To activate signing, add a protected `apple-signing`
environment job **after universal merge**, requiring the lead's authorized Apple
inputs. Download and unpack the merged artifact, verify both Mach-O slices, then:

1. Create an ephemeral runner keychain; import only the authorized Developer ID
   inputs supplied to that job. Do not use another application's identity.
2. Invoke `packaging/macos/sign-notarize.sh Faravan.app out` with the documented
   identity and notarization environment inputs. It signs inner executables,
   nested notifier app and outer app, uses hardened runtime, requires Accepted,
   staples and performs strict signature and Gatekeeper checks.
3. Rebuild the final zip **after** stapling. Hash these final signed bytes and
   pass them to release-manifest signing. Never retain unsigned-preview hashes.
4. Delete the ephemeral keychain and imported temporary files in `always()`
   cleanup, including failure paths. Preserve a failing notarization as a failed
   release, never an unsigned success.

No Apple inputs were inspected or provisioned in cycle 3. Dry-run signing tests
verify command order only; they do not prove signing, notarization, or clean-Mac
acceptance. The protected job remains intentionally absent until authorized
inputs and its cleanup path can be qualified.
