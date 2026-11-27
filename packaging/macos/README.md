# macOS preview

For the team preview, follow [Install on Mac](../../docs/team-onboarding.md#install-on-mac)
and use that guide's release asset and verification status. This page describes the app bundle and
how a maintainer builds it on a Mac host.

The preview has **no Developer ID signature or Apple notarization**. Build it on a Mac
host.

## Install an unsigned preview

macOS wording varies by version; the steps below use the names macOS 15 shows.

This route needs the release owner's artifact name, embedded revision and graphical integrity check.
Obtain the exact release asset and revision from the release owner and the [public preview manifest](https://tnunamak.github.io/faravan-updates/preview/update.json).
Do not guess a ZIP filename or assume the URL is live. A graphical integrity check is not available for this route yet:
stop before opening the downloaded app until the release owner supplies a verified graphical integrity-check flow for that artifact.
A Terminal checksum command is not a no-terminal success path. The Finder steps below apply only after that prerequisite is resolved.
The app is ad-hoc signed, not Developer ID signed or notarized. The documented OS warning approval remains allowed;
a paid Developer ID is not a prerequisite for the accepted preview path.

1. Unzip the reviewed preview. Copy `Faravan.app` to `/Applications` before
   opening it. The Mac and MCP guides use this location. Do not run it from
   the zip or Downloads.
2. Open it once in Finder. On macOS 15 and later, expect a security warning for
   this un-notarized app rather than normal first open; exact wording and controls
   vary. For an unverified-app warning,
   dismiss it. The only supported approval path is
   **System Settings → Privacy & Security**, scroll to Security and choose
   **Open Anyway** for Faravan. Authenticate if requested, then choose **Open**
   in the repeated warning.
3. If no override is offered, or the alert says the app is damaged or contains
   malware, stop and contact the release owner. Do not disable Gatekeeper or
   remove quarantine attributes. Managed Macs may prohibit overrides.
4. Confirm the menu icon and browser UI appear. If neither a window nor a menu
   bar icon appears after Open Anyway, quit Faravan and send the launcher
   log described below to the release owner; do not keep reopening it. If no Quit
   control is available, ask the owner for help stopping it. Report a missing log
   rather than retrying to generate one. Automatic invite opening is not
   supported by this Mac preview; paste the invitation in the app. Sending a
   prompt-only job does not require Git, Docker or an agent account.

The approval steps follow [Apple Support](https://support.apple.com/en-us/102445).
Right-click Open is not a supported alternative here.
The cask neither changes Gatekeeper settings nor strips extended attributes.

## Build and inspect

Build from the same clean commit with the same `PACKAGE_VERSION` on each
architecture. Xcode command-line tools, Go and a build-time Node are needed.
The installed app uses its pinned bundled Node, never a system Node.

```sh
# Apple silicon (native)
PACKAGE_VERSION=0.1.0 ARCH=arm64 FARAVAN_RELEASE_BUILD=1 bash packaging/macos/build-app.sh out-arm64
# Intel (native)
PACKAGE_VERSION=0.1.0 ARCH=x64 FARAVAN_RELEASE_BUILD=1 bash packaging/macos/build-app.sh out-x64
# On either Mac, after transferring both native bundles without losing modes:
bash packaging/macos/build-universal.sh out-arm64/Faravan.app out-x64/Faravan.app out-universal/Faravan.app
bash packaging/macos/verify-app.sh out-universal/Faravan.app universal
node scripts/verify-macos-install.mjs out-universal/Faravan.app
```

The build runs natively on an Apple silicon Mac and on an Intel Mac, records the
architecture and toolchain versions, keeps both native zip archives, then merges. The merge checks every file, symlink and
Mach-O dependency, including any `.node`/dylib, rather than merging only the
tray. Nonbinary trees must agree. Developer Node overrides are forbidden in
release mode. Signing follows merging, never precedes it.

The unsigned preview stage applies ad-hoc integrity signatures after merging,
including the notifier bundle. These identify no developer and do not notarize
the app. They do not satisfy Gatekeeper’s Developer ID requirement.

The outer bundle uses its native `faravan-launch` Finder entry, the explicit
`faravan` CLI wrapper, Go/cgo `faravan-tray`, the kernel process-identity helper, nested
`Helpers/FaravanNotify.app` with a separate identity, and
`Resources/Faravan.icns` made from the committed icon set. Application modules,
UI and pinned Node are under `Resources/faravan`.

## Login lifecycle

Launch at login is off by default. Open **You → Profile and devices**.
Under **Launch at login**, choose **Turn on launch at login**, if offered.
If Faravan asks you to move or repair the app, follow that message first.
Or run the installed CLI:

```sh
/Applications/Faravan.app/Contents/MacOS/faravan autostart status --json
/Applications/Faravan.app/Contents/MacOS/faravan autostart on
/Applications/Faravan.app/Contents/MacOS/faravan autostart off
```

The user-scoped `com.faravan.agent` LaunchAgent passes an absolute, XML-escaped
path to `faravan-launch --background` in the GUI session. `RunAtLoad=true` starts
it at login, and `KeepAlive` restarts unsuccessful exits with a three-second throttle.
Opening the app also registers a session-only `com.faravan.agent.resident` job
from the data home's `v1/resident.plist`, so crash recovery does not require login startup.
A saved Quit prevents automatic restarts; opening the app explicitly clears it.
Startup uses the existing lending choice; it does not opt a borrower into lending.
The supervisor retains bounded diagnostics in `<data-home>/v1/logs/launcher.log`
(for the stable build, `~/.faravan/v1/logs/launcher.log`, or `~/.faravan/v1/logs/launcher.log` on a Mac
that ran Faravan before; for a labeled preview build,
`~/Library/Application Support/Faravan Preview LABEL/v1/logs/launcher.log`; a custom data home may differ).
The directory is mode 0700 and file 0600. After a write exceeds 1 MiB, the file is
trimmed to its last 512 KiB. This is launch/tray diagnostic evidence, not a complete
job transcript or a capture of all standard output/error: the app CLI output is
suppressed and tray stderr is inherited, not copied by this logger. The logger
writes supplied messages without general redaction; error messages may include
private details. Review before sending and remove secrets, sign-in/invitation
links or codes, tokens and unrelated private paths. Do not send the entire data home.
Argument and data-home failures can occur before the logger is created, and
logging errors are ignored, so a missing log does not prove a successful launch.
Disabling future login startup leaves the running app alone.
Before moving the app, quit it. After moving it to a different path, log out and back in so launchd replaces the session job's saved launcher path.
A translocated copy cannot register temporary startup paths; copy it to Applications and reopen it first. Open the new copy and update its login item in
the profile. Updating a loaded login item writes its next-login configuration
without stopping the app. Disabling retains a disabled plist so off/on can reuse a running
launcher without stopping it; uninstall removes the plist.
The status reports Faravan’s configured choice; macOS Login Items can still
block background startup. If the app was deleted, remove startup with `autostart off` from another installed
copy, or remove `~/Library/LaunchAgents/com.faravan.agent.plist`.

Use `faravan uninstall --keep-data` before moving the app to Trash or running
`brew uninstall --cask faravan`. It keeps your owned circles, leaves any circles you only joined, and removes startup entries;
keep-data preserves the local data. A cask uninstall does not leave joined circles or remove login preferences;
the app’s uninstall command does both. Cask cleanup is reserved for explicit zap
because Homebrew also runs uninstall stanzas during upgrades.
`brew zap` is a separate deliberate deletion of the default `~/.faravan` data;
custom `FARAVAN_HOME` and legacy data are not removed by the cask.

## Acceptance boundary

The headless installed smoke copies the bundle into a path with spaces,
uses its own private state, checks CLI/runtime/readiness and graceful shutdown,
and removes its copy and state in `finally`. It does not register LaunchServices,
change login items, show notifications or open browser windows. The Mac-host run also passes
`--with-launcher`: this starts only the test copy’s tray and backend, checks
duplicate reuse, force-kills its own native launcher, and asserts both children
exit through the owner pipe. Run that option only in a disposable GUI session.

Intel Macs borrow only; current Docker Sandboxes does not support Intel local lending.
