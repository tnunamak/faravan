# Faravan packaging

This directory packages the existing Faravan Node CLI, static UI, and Go
tray without changing their application logic. Linux packages install runtime
assets in `/usr/lib/faravan`, the public commands in `/usr/bin`, the user
systemd unit in `/usr/lib/systemd/user`, XDG tray autostart in
`/etc/xdg/autostart`, and the `faravan://` link handler with a `faravan://`
compatibility alias (`faravan-open-link.desktop`, `Exec=faravan open-link %u`)
in `/usr/share/applications`.

## Build Linux packages

Install Go. `build.sh` uses a local `nfpm` when present and otherwise runs the
official `goreleaser/nfpm` image through Docker, so a release build does not
depend on a workstation-specific packaging tool.

```bash
PACKAGE_VERSION=0.1.0 \
packaging/build.sh
```

The Go tray binary is built during that command with:

```bash
cd tray && go build ./cmd/faravan-tray
```

Artifacts:

- `packaging/dist/faravan_0.1.0_amd64.deb`
- `packaging/dist/faravan_0.1.0_linux_amd64.tar.gz`
- `packaging/stage/` — inspectable package filesystem tree; it is regenerated
  on every build and is not a release artifact.

The `.deb` has no Node.js dependency (it bundles the runtime, see "Bundled runtime") and `Suggests: docker-sbx`.
`docker-sbx` is deliberately not a hard package dependency; the installed
doctor command evaluates and explains the real local backend readiness. The
package bundles the Faravan CLI entry points, all Faravan runtime
modules, static UI, native tray binary, systemd user units, and XDG autostart
entry. It installs one command, `faravan`.

The Debian postinstall works only in the installing non-root user's existing session (or the invoking sudo caller's
session). It also clears any enabled `faravan-daemon.service` left by a preview install, best-effort, without
stopping outstanding work; that unit is no longer packaged.

- **First install**: enables and starts `faravan-app.service`.
- **Upgrade**: keeps the person's choices. It does not enable a disabled unit and does not start an app that
  was stopped. A running app still runs the old code, so it is restarted: `faravan app quit --yes` (which
  refuses while a lent job runs or a review waits, and proves no sandbox is left), then
  `systemctl --user start faravan-app.service`. Only a quit the app accepted lets the unit restart. If the app
  refuses (a job or review), or does not answer at all (no discovery file, a wedged process, a 15 s probe or
  90 s quit timeout), it is left running and the installer prints what to run later
  (`faravan app quit --yes && systemctl --user restart faravan-app.service`, or a bare
  `systemctl --user restart` that ends any job). "Restarted" is printed only after the running app reports
  the new version through its API (`faravan update status --json` against `/usr/lib/faravan/VERSION`);
  otherwise the message says the restart is unconfirmed. A running tray is relaunched in the same desktop
  session, and the installer says so only when every old tray is gone and a new tray process runs.

Root/headless installs and unavailable user buses print these commands instead; they never start a root
service or enable lingering, and startup failure does not fail package installation:

```sh
systemctl --user daemon-reload
systemctl --user enable --now faravan-app.service
```

Run them as your normal user, or run `faravan` to open the app directly.

On removal, the package asks each active user's app to quit through its local API and normal cessation check. Quit
fences new lending without changing the saved lending intent. A running job or pending review blocks removal; the units
and tray stay running until the work is safe to finish. When
the user manager is unavailable, removal is canceled before package files are removed. Removal does not purge member
keys, the ledger, or `FARAVAN_HOME` data.

### Debian version

A release `0.1.0` is Debian `1:0.1.0-1`, and a preview `0.1.0-preview.YYYYMMDD.N` is
`1:0.1.0~preview.YYYYMMDD.N-1` (`deb-version.sh`, used by both the dpkg-deb and the nFPM path). Debian sorts a
hyphen above the release, so the old form would never upgrade to stable; the tilde sorts below it. The epoch
`1:` is permanent: previews 1 to 6 shipped with the hyphen form, which sorts above the tilde form, and the epoch
is what lets preview 7 install over them. Never lower or drop it. File names keep the plain release version.

The package also includes a `faravan-coordinator.service` systemd
**user** unit. `faravan host` uses it for a hosted collective,
because it is the same user-scoped lifecycle primitive already packaged for
the local app: no root service, no hand-managed PID, and restart on
failure. Gozar is installed with Faravan's production dependencies. The interim
package lock points at the checked-in candidate tarball. The package build copies
that archive into the staged tree before the offline install.

For a disposable package journey, run:

```bash
PACKAGE_VERSION=0.1.0 \
packaging/smoke.sh
```

It uses plain Docker (not Docker Sandboxes) and a fresh Ubuntu 24.04 container with no Node.js and no curl, so every
check uses the package's bundled runtime. It installs the generated `.deb`, checks the Debian version, the app
unit, installed `public/v1` assets, help verbs, and that no daemon unit is shipped. It then starts `faravan app`
as a non-root user with a temporary `FARAVAN_HOME`, reads the private `v1/app.json` discovery record, rejects an
unauthenticated `/api/status`, accepts an authenticated one, and checks that the app reports the package's
version. A check that cannot run fails the smoke test. It does not sign in or run lending/provider work. This
container has no user session.

To prove an upgrade the way a person does it, with a real systemd user session, run:

```bash
packaging/upgrade-smoke.sh OLD.deb NEW.deb TRANSITION.deb
```

It starts disposable privileged containers with systemd (its own cgroup namespace; the host's systemd is not
used), installs `OLD.deb` with `sudo apt install`, installs `NEW.deb` over it, and checks: the new version sorts
above the old one; the running app reports the new version through its API; a disabled unit stays disabled and a
stopped app stays stopped; an app that refuses to quit (a running job) is left running with the restart command
printed; a running tray is replaced by a new process in the same session; and a package whose postinst fails fails the harness.

### Isolated Linux preview

#### Obtain and open the dated archive

For a dated isolated preview, obtain faravan-preview-LABEL_linux_amd64.tar.gz and the inviter's trusted digest for that exact asset. LABEL below is a placeholder, not a published release claim. Extract the whole archive into a fresh directory you will retain, then run `./usr/bin/faravan-preview-LABEL-launch` from that directory as your normal desktop user. Do not use sudo or substitute `./usr/bin/faravan app`: that bypasses this launcher's preview environment. The archive is not an apt package.

Download only the inviter-designated asset for the stated release and architecture. Before extracting or installing, compare sha256sum of the downloaded file with the trusted SHA-256 supplied for that exact asset. A digest from an untrusted copy of the same download page is not independent source authentication. If the asset name, release, architecture or digest is missing or differs, stop and ask the inviter; do not run an alternate installer. This generator does not publish a checksum or signature.

- packaging/dist/faravan-preview-LABEL_linux_amd64.tar.gz contains usr/ and MIGRATION.md. It contains no etc/ entry and this generator installs no XDG autostart entry. Keep the complete extracted tree; read the included migration guidance before replacing an older preview.

The launcher is `usr/bin/faravan-preview-LABEL-launch` inside the extracted archive. Replace `LABEL` with the inviter-confirmed label; it is not a literal release name.

Use the dated launcher only to open this preview; appending circle, doctor, quit or uninstall arguments does not turn it into a general CLI. Join through the confirmed preview app's invitation field. Use a registered channel command for other actions only after confirming it selects this LABEL and profile; bare faravan may select another installation. The launcher starts two systemd user services, so closing its terminal or pressing Ctrl-C is not proof the preview has stopped. Do not use the historical faravan-friend-* or normal faravan-app.service names to control it.

#### Runtime prerequisites and evidence limits

This dated archive is named linux_amd64; use an x86-64 Linux machine. The runtime uses the archive's executable Node binary and complete usr/ tree, /bin/sh, /usr/bin/env, readlink -f, dirname, sha256sum, flock, stat -c and sleep with fractional seconds, plus a working systemd user manager with systemctl and systemd-run (default paths /usr/bin/systemctl and /usr/bin/systemd-run). Extract with tar/gzip. Launch as the logged-in desktop user with an established HOME. An explicitly absolute XDG_DATA_HOME and the parent of any baked-in preview root must already exist and be accessible. The tray needs a usable desktop session; missing tray integration does not establish that the app failed.

This launcher needs x86-64 Linux, a systemd user manager and a logged-in desktop session. ARM64 and headless logins are not supported. Building the archive is a separate maintainer workflow and requires system Node for channel validation in addition to the documented staging/build tools.

#### Profile, units and migration

The launcher passes `FARAVAN_DATA_HOME=<data-home>/Faravan Preview LABEL` to the app, tray and final CLI. `<data-home>` is canonicalized to an absolute path: an absolute XDG_DATA_HOME when supplied, otherwise .local/share under the launching user's HOME (a relative XDG_DATA_HOME is ignored). It explicitly removes FARAVAN_HOME and FARAVAN_HOME. The default auxiliary root is the launching user's home-relative path .faravan-preview-LABEL; FARAVAN_PREVIEW_ROOT is a build-time override baked into the launcher, not a launch-time switch. CODEX_HOME is $root/codex-home, CLAUDE_CONFIG_DIR is $root/claude-config, and both coordinator-home variables point to $root/state/coordinator. The generated environment does not redirect all XDG profile directories into $root. These paths are not a filesystem sandbox.

The app and tray use a fixed PATH: the preview's `usr/bin` and Node runtime bins, then system directories.

Units are `faravan-preview-app-LABEL-<identity>.service` and `faravan-preview-tray-LABEL-<identity>.service`, where `<identity>` is SHA-256 of the canonical auxiliary root, the bundle path and the build identity (a hash of the packaged files and launcher), each followed by a newline. Migration/launch serialization instead locks `<data-home>/.faravan-preview-migration-<data-identity>.lock`, where `<data-identity>` hashes the channel-data path followed by a newline. Two bundles with the same LABEL may have different units but share channel data and this lock. Labels are limited to 80 characters, start with a letter or digit, use letters, digits, dots and hyphens, and cannot end in -tray. A failed unit is reset and creation retried only when its exact description matches this preview; unrelated units are not reset.

The migration/launch lock is released before the final CLI; it is not lifetime exclusivity for the services.

The launcher invokes the bundled migration helper before starting the units, passing $root/state, the channel-data directory and `<data-home>`; helper errors stop launch. Preserve both the old auxiliary root and channel-data directory until migration and release behavior have been verified. Do not delete a migration lock or edit discovery records as a repair. FARAVAN_NO_AUTOSTART=1 and FARAVAN_NO_UPDATE=1 disable these startup/update routes for this preview. Installing a newer archive is a separate deliberate action.

Before first launch, follow the included `MIGRATION.md`: stop all versions and their writers safely, back up both profiles, and retain backups. If migration ownership cannot be established, leave files and locks intact and ask the inviter. These instructions do not certify the migration helper's internals or power-loss safety.

#### Opening, joining and sign-in

The launcher requests no automatic browser opening and strips desktop variables from the app and final CLI, while supplying caller session variables to the tray. If no window appears, use the preview's tray affordance if available; otherwise capture the redacted terminal error and ask the inviter rather than trying a guessed localhost URL. Starting a unit is not proof onboarding is ready. The launcher waits up to 15 seconds for a changed discovery record for a newly started app, but it does not verify a version or HTTP readiness before continuing. Tray start failure is reported while the app remains available.

Desktop environment propagation uses the bundled session-environment helper; the launcher clears DBUS_SESSION_BUS_ADDRESS, DISPLAY, WAYLAND_DISPLAY, XDG_CURRENT_DESKTOP, KDE_SESSION_VERSION, XDG_SESSION_TYPE, XDG_RUNTIME_DIR and XAUTHORITY before forwarding the caller variables selected for the tray. Do not infer the complete forwarding allowlist from this paragraph.

Provider sign-in for this preview uses its isolated Codex/Claude configuration homes; an existing system CLI sign-in is not proof the preview is signed in. Borrowing does not require provider accounts. For lending, sign in personally through Setup and confirm readiness separately; keep lending off when sign-in or safety checks fail.

For hosting or joining, use a fresh private invitation and a release-specific onboarding guide. Installing the archive does not create the historical public circle from the friend walkthrough.

#### Replacement, support and removal

Do not unpack a replacement over a running preview. This launcher reuses already-active units and does not compare their version with the extracted files or stop an older process. First finish or safely cancel work through the app and quit the old preview; confirm its exact app and tray units are inactive. Keep the old bundle until that is confirmed. A new build or bundle directory changes the unit names, but the same LABEL still selects the same channel-data directory. A different LABEL selects a different default profile; migration of an old profile is not guaranteed by changing LABEL. Confirm the running app's release before calling the replacement successful.

If launch fails, send the inviter the exact release label and asset name, SHA-256 digest, Linux distribution/version and architecture, desktop/session type, the exact failed step, and redacted terminal error. Include whether the app and tray units are active/failed and the exact unit names shown by systemctl --user. For the specific preview tray unit, journalctl --user -u UNIT may contain startup diagnostics; review and redact it before sharing. App-unit stdout/stderr are discarded by this launcher, so an empty journal is not proof of health. Do not send the launcher's app JSON file, cookies/tokens, provider configuration, passwords, sign-in or invitation links/codes, private prompts, or whole data directories. Stop retries if migration or ownership is uncertain; preserve the old files and ask the inviter.

To remove this dated preview, first finish or explicitly cancel active work through the app and quit it safely. Verify the exact preview app and tray units are inactive. Confirm the correct channel's supported uninstall route and its data-retention/owned-circle choices before deleting anything. Do not use apt remove for this extracted archive, and do not assume deleting its extraction directory removes its separately stored channel data, provider configuration, coordinator state or registered command. Keep data unless you deliberately authorize its removal.

#### Maintainer build (not an installation step)

`packaging/linux-preview.sh LABEL` makes the dated archive from a staged tree. Run `packaging/build.sh` first. The generator refuses a stage without `usr/lib/faravan/faravan-tray` and the bundled session-environment helper. System Node is required for channel-identity validation.

```bash
packaging/linux-preview.sh LABEL
```

The output directory is `packaging/dist/faravan-preview-LABEL/`; the archive path is listed above. No actual release label, asset availability or trusted digest is asserted here.

## Public Linux preview download

`packaging/build.sh` also produces `packaging/dist/faravan-linux-x64-VERSION.tar.gz` for preview versions. To rebuild only this archive from an existing stage, run `packaging/linux-download.sh STAGE DIST`. Extract it into a dedicated, user-writable directory and start `usr/bin/faravan app` inside that directory. Keep the directory in place so updates can replace its runtime. Do not unpack it over a package install or an isolated preview.

This archive uses the normal relocatable commands and carries the tarball install marker. Its fixed channel is `preview-20261028`, with bundle identity `com.faravan.preview.20261028`, matching Mac. Its data uses that channel's normal data folder. It does not copy the dated launcher's provider configuration or migration environment. Existing isolated-preview users must finish active work and migrate deliberately; this archive does not change their install or data.

The public release must upload this archive as `faravan-linux-x64-VERSION.tar.gz`, rather than renaming the isolated `faravan-preview-20261026_linux_amd64.tar.gz`. Sign its bytes with `packaging/sign-update.mjs --linux-channel faravan --linux-arch x64` and an absolute HTTPS `--tarball-url`. Keep the Mac asset's existing channel and bundle identity. The signed Linux asset must have the same URL, size and hash as the manifest's top-level tarball fields. Publish both manifest files only after the matching archive is available.

The normal tarball updater checks the pinned release key and archive hash, waits for idle work state, retains the previous runtime and checks that the new runtime starts. Hosted circles use the existing coordinator stop/restart and rollback transaction. The separate dated side-by-side launcher still disables updates: its install and provider environment remain isolated.

## Channel command ownership

Stable command setup owns `~/.local/bin/faravan`. A preview uses its channel's
`linuxPrefix` on Linux and macOS, for example `faravan-preview-20261026-2`.
Preview metadata cannot select `faravan`, `faravan`, or a path as its command.
Links and shell profiles use the account home; the `command-path-installed`
ownership record lives in the active data home and names its command and launcher.
Each command has its own profile marker, so removing a preview leaves stable's
PATH setup intact. The old shared marker gives no authority to repair a link.

The Mac tray reads `Contents/Resources/faravan/channel.json` before considering
any alternate layout. A valid installed file wins over a stray file in
`Contents/MacOS`; malformed installed metadata or wrong-layout-only metadata is
an installation error. Windows command setup remains unsupported and writes no
alias or ownership record.

## Curl installer

`bin/faravan-install.sh` is the public Linux installer. It first checks that the
computer can run Faravan (Linux on x86-64, glibc 2.28 or newer for the bundled
Node.js; on a Mac, Apple silicon and macOS 14 or later) and names each problem
before it downloads anything. It also reports whether `/dev/kvm` is usable for
lending, without blocking a borrower. `FARAVAN_CHANNEL` picks the route:

- `preview` (default, the only public route): reads the public signed feed
  (`FARAVAN_FEED_URL`, default the app's own update feed), checks its
  signature and the Linux tarball, unpacks it beside the channel's folder
  (`$XDG_DATA_HOME/<linuxPrefix>`), proves the runtime starts, then renames it
  into place. It adds `<linuxPrefix>.desktop` to the applications menu and
  opens the app. An existing install is kept and opened; the app updates it. It
  does not take the stable `faravan` command or `~/.local/lib/faravan`. On a
  Mac it stops after the check and points to the Mac app download.
- `stable`: the signed apt repository (see below), then the latest release's
  `.deb`, then the release portable tarball under `~/.local` when `dpkg` is
  unavailable or installation fails. During development, `FARAVAN_RELEASE_API`
  and `FARAVAN_INSTALL_ROOT` point it at a staging release and a temporary
  destination.

The `.deb` and portable tarball include Node.js, so installed users do not need
system Node. A source checkout requires Node.js 22.13 or newer.

Publish the installer for each release as `install.sh` at the root of the
updates site (`https://tnunamak.github.io/faravan-updates/install.sh`), from
the same commit as the release. The install guides give that URL.

## Homebrew

The source-building `brew/faravan.rb` is the old preview formula. The new Mac
path is a prebuilt cask, prepared under [homebrew-tap](homebrew-tap/README.md).
It bundles Node and the universal tray; users need neither Go nor Node. The tap
is not published. Its cask renderer requires a real versioned public HTTPS zip
and hashes the exact bytes. Homebrew owns updates for cask installs.

## macOS preview

See [macos/README.md](macos/README.md) for the bundle contract, the Mac-host build,
the merge gate and unsigned installation steps. Release builds run on a Mac host.
Apple signing is off until a protected
signing stage passes [SIGNING.md](SIGNING.md).

## Windows

See [windows/README.md](windows/README.md). The WinGet files are a deliberately
non-submittable skeleton until a signed installer exists.

## Signed apt repository and updates

Linux packages currently ship as `.deb` and portable tarball, not `.rpm`. Borrowing with a Git project needs the Git-project path and Git installed. A no-project message or files job does not. Lending separately needs a supported Docker Sandboxes backend and passing readiness checks.

`packaging/apt/build-repo.sh` turns `.deb` files into a signed apt repository
directory (`dists/`, `pool/`, `InRelease`, the public keyring). It uploads nothing.
[`packaging/apt/README.md`](apt/README.md) says how the real signing key is made and
how a release is published.

- **apt install**: `bin/faravan-install.sh` adds the repository (a dedicated keyring
  and `Signed-By`, never `apt-key`) and runs `apt-get install faravan`. It pins the key
  by fingerprint. While `APT_KEY_FPR` is still the placeholder, or the repository is not
  reachable, it falls back to the release `.deb` and then to the tarball. After that,
  `sudo apt upgrade` keeps Faravan current.
- **Tarball install**: the app updates itself between jobs (`lib/v1/self-update.mjs`).
  A release publishes `update.json` and `update.json.sig` (an Ed25519 signature made
  by `packaging/sign-update.mjs`). The updater checks the signature against the key
  pinned in `lib/v1/update-key.mjs`, then the tarball's hash, applies only when no job,
  review or claim is open, keeps the previous tree in `lib/faravan.prev`, and rolls back if
  the new tree does not start. `faravan update [--check]` does the same by hand. A
  package or checkout has no `.installed-via` marker, so it never replaces itself.
  `FARAVAN_NO_UPDATE=1` turns it off.

## Desktop details

- **Notifications** (`tray/internal/faravantray/notify*.go`): the tray shows
  request notifications with Review and Not now. Linux talks to the desktop's
  notification service over D-Bus (no `notify-send`: its AppArmor profile on recent
  Ubuntu denies `GetCapabilities`, which makes libnotify drop the buttons), and the
  install's launcher gives it a name and icon: `faravan.desktop` for the stable channel,
  `<linuxPrefix>.desktop` for a dated channel. The app name is that launcher file's `Name=`
  (`Faravan` when there is none). The icon is the shipped `public/v1/icon-512.png` beside the tray
  (or the checkout's `public/` one level up), sent as an absolute path when it decodes as an image;
  an absolute `Icon=` in the launcher file replaces it. Without any usable file, the themed `faravan`
  icon is named. `notify-send` stays as a fallback.
  macOS uses a signed helper app built by `macos/build-notify-helper.sh`; the
  tray finds it through `FARAVAN_NOTIFY_HELPER` and otherwise falls back to
  text with no buttons. Windows uses a PowerShell toast under the AUMID
  `Faravan.Desktop`, which the tray registers under HKCU on start.
- **No tray (Linux)**: the tray helper checks for `org.kde.StatusNotifierWatcher`
  on the session bus and reports `tray: false` to the app
  (`/api/status` → `desktop`). The notifications and `faravan.desktop` keep working.

## Uninstall

`faravan uninstall [--keep-data]` (lib/v1/uninstall.mjs) stops lending and asks the app
to finish or hold active work before it stops services. It removes login activation and,
for a portable install, the command. `--keep-data` keeps owned circles and all device data. `--delete-hosted-circles` closes each owned circle through
its owner lifecycle, then leaves it. Without either option, an owned circle blocks uninstall.
Leaving a joined circle sends the owner a signed leave request (docs/protocol/v1.md section
5.2); the owner's computer removes this one from the signed member list automatically when
it is online. If the owner cannot be asked (an older coordinator or owner), uninstall says
to ask them.

For a Debian package, `sudo apt remove faravan` stops services and disables tray and user-unit
login activation but keeps member keys, the ledger and `FARAVAN_HOME`. Use
`sudo apt purge faravan` only when you also want reachable per-user device data deleted; the hook first drains
work and closes hosted circles through the owner lifecycle. It reports data that it kept, such
as profiles with no active user session. Run purge while the package is installed. If you already ran
`apt remove`, a later purge reports that purge preparation did not run before package files were removed;
it keeps `FARAVAN_HOME` because the program needed to close hosted circles is no longer available.
Reinstall Faravan, then purge directly. For Debian upgrades, see the guarded restart behavior above; this is separate from the dated isolated-preview launcher, which reuses active units. On macOS,
`brew uninstall faravan` removes the package separately from per-user device data.
The macOS app menu item ("Uninstall Faravan…") and the Windows uninstaller hook are not
built: there is no signed `.app` or installer yet. They should call this command.

## Quit dialog (`tray.mac-quit`)

"Quit Faravan…" asks before it does anything, and says what happens to lending and to a running
job. With a job running the buttons are Pause after this job, Stop the job and quit, and Cancel; the
plain quit refuses if a job began while the dialog was open, and only the explicit stop button stops a
job. Quit asks the app to shut itself down (`POST /api/shutdown`): the app fences lending and checks for a running job in one step, stops the
confirmed run, and closes through its own cleanup. The tray waits for it to exit and never kills it. With lending off, "Quit Faravan"
quits with no question. Dialogs: macOS `osascript` (three buttons, as the mockup),
Linux `zenity` or `kdialog` (zenity), Windows a PowerShell MessageBox
(its buttons are fixed Yes/No/Cancel, so the text says what each does). With no dialog
tool the same question appears as lines in the tray menu. An older app without `/api/shutdown` is not quit from the tray.

## Bundled runtime

Faravan ships its own Node.js, so no system Node is needed. `node-runtime.env` pins the version and the
SHA-256 of each official archive; `bundle-node.sh OS ARCH DEST` downloads from nodejs.org (or takes
`FARAVAN_NODE_TARBALL`) and refuses a mismatch. `build.sh` puts the Linux x64 runtime in
`/usr/lib/faravan/runtime`. The `faravan` launcher finds it from its own path (`readlink -f`), so it needs no
`node` on PATH; the app, the tray's start command, the coordinator unit and a tarball update all use it.
The tarball and the `.deb` both carry it. `FARAVAN_NODE_BIN=FILE` (development only, not pinned) uses a local
binary. This script builds the Linux x64 target. macOS uses `macos/build-app.sh`; Windows has no supported build.

## Signing (preparation only)

`SIGNING.md` describes the macOS notarization and signed MSIX scripts, their environment variables, and the
"clean-machine install" gate. Native signing is not enabled in this release.
The explicit unsigned-preview path uses ad-hoc signatures and no notarization.
Developer ID signing waits for authorized inputs.

The guest job guard uses `guest-runtime/linux-<arch>/node`, checked against the generated `guest-runtime/manifest.json`. Linux packages reuse `runtime/bin/node` through a relative symlink. Mac packages carry both Linux architectures so native legs have identical resources for universal merging. These ELF binaries and their manifest are resources sealed by the outer app signature; they are not Mach-O code to sign separately. The Linux archive layout remains `bin/node` inside the official `tar.xz`, including when built on macOS.

Offline Mac builds can provide `FARAVAN_GUEST_NODE_TARBALL_linux_x64` and `FARAVAN_GUEST_NODE_TARBALL_linux_arm64` separately from the host `FARAVAN_NODE_TARBALL`; all archives still pass the pinned checks.

## Usage reports and screen recordings

Packaged builds include the pinned PostHog browser SDK and recorder in the local UI bundle. **Help improve Faravan** controls both app reports and browser recordings. The first-start notice appears before collection starts; explicit Off choices survive upgrades. On sends usage, model, plan, computer and allowance data. Screen recordings are a separate choice, off by default, and hide private content when on. One random install UUID links the app, command line, MCP and full-app browser sessions. Off removes the local ID and queued reports; it cannot recall data already sent.

The package requires no secret PostHog credentials. The public project token and fixed ingestion host are bundled. Only JSON configuration can be fetched from the PostHog asset host; the UI CSP blocks remote scripts. PostHog plan defaults apply.
