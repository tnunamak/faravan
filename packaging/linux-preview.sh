#!/usr/bin/env bash
# Build the isolated Linux preview: the staged Faravan tree, tray included, plus its dated launcher.
#   packaging/linux-preview.sh LABEL        for example: packaging/linux-preview.sh 20261026-2
#
# Run packaging/build.sh first. It stages usr/ under packaging/stage, and that includes the Linux tray
# (usr/lib/faravan/faravan-tray). This script writes, under packaging/dist:
#   faravan-preview-LABEL/usr                  the tree, with usr/bin/faravan-preview-LABEL-launch
#   faravan-preview-LABEL_linux_amd64.tar.gz   usr/ and MIGRATION.md. It has no etc/ or autostart entry.
# It installs nothing. Unpack the tarball anywhere; the launcher finds its own tree.
#
# Environment, all optional:
#   FARAVAN_PREVIEW_ROOT         isolated state root, baked into the launcher; its parent must exist
#                                 (default: the launching user's $HOME/.faravan-preview-LABEL, resolved at launch)
#   FARAVAN_PREVIEW_SYSTEMCTL    systemctl, baked into the launcher (default: /usr/bin/systemctl)
#   FARAVAN_PREVIEW_SYSTEMD_RUN  systemd-run, baked into the launcher (default: /usr/bin/systemd-run)
#   FARAVAN_PREVIEW_STAGE        staged tree to read (default: packaging/stage)
#   FARAVAN_PREVIEW_DIST         output directory (default: packaging/dist)
# The launcher is generated text, so each of those paths must be plain: letters, digits and ._+/- only.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
label="${1:?usage: linux-preview.sh LABEL, for example 20261026-2}"
[[ "$label" =~ ^[0-9A-Za-z][0-9A-Za-z.-]*$ && "$label" != *..* && "$label" != *. ]] || {
  echo "LABEL must start with a letter or digit and hold only letters, digits, dots and hyphens, got: $label" >&2
  exit 1
}
# Reserve the legacy tray suffix, and bound labels well below systemd's unit-name limit.
if [[ "$label" == *-tray || ${#label} -gt 80 ]]; then
  echo "LABEL must be at most 80 characters and must not end in -tray" >&2
  exit 1
fi
stage="${FARAVAN_PREVIEW_STAGE:-$package_dir/stage}"
dist="${FARAVAN_PREVIEW_DIST:-$package_dir/dist}"
# With no explicit root, the launcher finds the root in the HOME of the person who runs it: a release built on one
# computer must not point every other computer at the builder's home folder.
if [ -n "${FARAVAN_PREVIEW_ROOT:-}" ]; then
  preview_root=$FARAVAN_PREVIEW_ROOT
  root_expr="'$preview_root'"
else
  preview_root=/runtime-home/.local/share/faravan
  root_expr='"${HOME:?HOME must name an established directory}/.local/share/faravan"'
fi
systemctl_bin="${FARAVAN_PREVIEW_SYSTEMCTL:-/usr/bin/systemctl}"
systemd_run_bin="${FARAVAN_PREVIEW_SYSTEMD_RUN:-/usr/bin/systemd-run}"

plain_path() {
  [[ "$2" =~ ^/[A-Za-z0-9._+/-]+$ ]] || {
    echo "$1 must be an absolute path of letters, digits and ._+/- only, got: $2" >&2
    exit 1
  }
}
plain_path FARAVAN_PREVIEW_ROOT "$preview_root"
plain_path FARAVAN_PREVIEW_SYSTEMCTL "$systemctl_bin"
plain_path FARAVAN_PREVIEW_SYSTEMD_RUN "$systemd_run_bin"

# A preview without its tray is the gap this script exists to prevent, so check the tree before writing anything.
for required in usr/bin/faravan usr/lib/faravan/faravan-tray; do
  [ -x "$stage/$required" ] || {
    echo "no executable $required under $stage. Run packaging/build.sh first: it builds the Linux tray." >&2
    exit 1
  }
done
[ -f "$stage/usr/lib/faravan/lib/session-environment.sh" ] || {
  echo "missing usr/lib/faravan/lib/session-environment.sh under $stage. Run packaging/build.sh first." >&2
  exit 1
}

# The runtime and both native consumers use this schema. Reject a label before
# replacing any previous package output if its generated identity is invalid.
channel_json=$(printf '{"id":"faravan","name":"Faravan","dataFolder":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify","launchAgentLabel":"com.faravan.agent","linuxPrefix":"faravan"}\n' \
  "$label" "$label" "$label" "$label" "$label" "$label" "$label")
CHANNEL_JSON="$channel_json" CHANNEL_IDENTITY_MODULE="$package_dir/../lib/channel-identity.mjs" node --input-type=module -e '
import {pathToFileURL} from "node:url";
const {isChannelIdentity} = await import(pathToFileURL(process.env.CHANNEL_IDENTITY_MODULE));
try { if (!isChannelIdentity(JSON.parse(process.env.CHANNEL_JSON))) throw new Error("invalid channel identity"); }
catch (error) { console.error(`LABEL does not produce a valid channel identity: ${error.message}`); process.exit(1); }
'

name="faravan-preview-$label"
out="$dist/$name"
rm -rf "$out"
mkdir -p "$out"
cp -a "$stage/usr" "$out/usr"
cat >"$out/usr/lib/faravan/channel.json" <<CHANNEL
{"id":"faravan","name":"Faravan","dataFolder":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify","launchAgentLabel":"com.faravan.agent","linuxPrefix":"faravan"}
CHANNEL

# Hash the copied tree before adding the generated launcher. Include paths, modes,
# contents and symlink targets, but not timestamps or the build/output directory.
build_identity=$(node --input-type=module - "$out/usr" <<'HASH'
import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, readlinkSync} from 'node:fs';
import {join} from 'node:path';
const root = process.argv[2], hash = createHash('sha256');
function walk(relative) {
  const path = join(root, relative), stat = lstatSync(path);
  const kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file';
  hash.update(JSON.stringify([relative, kind, stat.mode & 0o7777]) + '\n');
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) walk(join(relative, name));
  } else if (stat.isSymbolicLink()) {
    hash.update(JSON.stringify(readlinkSync(path)) + '\n');
  } else if (stat.isFile()) {
    hash.update(createHash('sha256').update(readFileSync(path)).digest('hex') + '\n');
  } else throw new Error('Unsupported staged entry: ' + relative);
}
walk('');
console.log(hash.digest('hex'));
HASH
)

launcher="$out/usr/bin/$name-launch"
sed -e "s|@ROOT_EXPR@|$root_expr|g" -e "s|@LABEL@|$label|g" \
  -e "s|@BUILD_IDENTITY@|$build_identity|g" -e "s|@SYSTEMCTL@|$systemctl_bin|g" -e "s|@SYSTEMD_RUN@|$systemd_run_bin|g" > "$launcher" <<'LAUNCHER'
#!/bin/sh
# Starts the isolated Faravan preview @LABEL@. Generated by packaging/linux-preview.sh: change the generator, not this file.
# The app and the tray each run as one systemd user unit. A launch that finds a unit active starts nothing, so a second
# launch adds neither a second app nor a second icon. The two units and this launch's own exec of the app share one
# Faravan data directory under the preview root below. This is environment isolation, not a filesystem sandbox.
# Before replacing a running build, list its units with systemctl --user list-units
# 'faravan-preview-*-@LABEL@-*.service' and stop the exact old app AND tray unit names.
# Content changes create new unit names; they do not stop old units sharing the data folder.
set -eu

self=$(readlink -f "$0")
bundle=$(cd "$(dirname "$self")/../.." && pwd)
root=@ROOT_EXPR@
root_base="${root%/*}"
case "$root" in "${HOME:-}/.local/share/faravan") root_base=$HOME ;; esac
systemctl='@SYSTEMCTL@'
systemd_run='@SYSTEMD_RUN@'
# Refuse unsupported system mv before creating roots, locks, or migration stages.
"$bundle/usr/lib/faravan/runtime/bin/node" "$bundle/usr/lib/faravan/lib/preview-migration.mjs" --mkdir "$root" "$root_base"
root=$(cd "$root" && pwd -P)
. "$bundle/usr/lib/faravan/lib/session-environment.sh"
unit_path="$bundle/usr/bin:$bundle/usr/lib/faravan/runtime/bin:/usr/local/bin:/usr/bin:/bin"
data_home=${XDG_DATA_HOME:-}
case "$data_home" in
  /*) data_base=$data_home ;; # An explicit XDG root must already exist.
  *) data_base=${HOME:?HOME must name an established directory}; data_home=$data_base/.local/share ;;
esac
"$bundle/usr/lib/faravan/runtime/bin/node" "$bundle/usr/lib/faravan/lib/preview-migration.mjs" --mkdir "$data_home" "$data_base"
data_home=$(cd "$data_home" && pwd -P)
channel_data="$data_home/Faravan"
build_identity='@BUILD_IDENTITY@'
identity=$(printf '%s\n%s\n%s\n' "$root" "$bundle" "$build_identity" | sha256sum)
identity=${identity%% *}
app_unit="faravan-preview-app-@LABEL@-$identity.service"
tray_unit="faravan-preview-tray-@LABEL@-$identity.service"
# Migration ownership follows the actual shared destination, even when roots or bundles differ.
data_identity=$(printf '%s\n' "$channel_data" | sha256sum)
data_identity=${data_identity%% *}
exec 9>"$data_home/.faravan-preview-migration-$data_identity.lock"
if ! flock -x -w 15 9; then
  echo "Another preview launch is still preparing your data. Wait for it to finish; if it is stuck, keep both terminals and ask the person who invited you." >&2
  exit 1
fi

start_unit() {
  unit=$1
  shift
  owner="Faravan preview $identity $unit"
  if "$systemctl" --user is-active --quiet "$unit"; then return 0; fi
  if "$systemd_run" --user --unit="$unit" --description="$owner" --collect "$@" >/dev/null; then return 0; fi
  # Never reset an unrelated unit or hide an ordinary process-start error.
  description=$("$systemctl" --user show --property=Description --value "$unit") || return 1
  state=$("$systemctl" --user show --property=ActiveState --value "$unit") || return 1
  if [ "$description" = "$owner" ]; then
    case "$state" in
      active|activating) return 0 ;; # A concurrent launch won the create race.
      failed)
        "$systemctl" --user reset-failed "$unit" || return 1
        if "$systemd_run" --user --unit="$unit" --description="$owner" --collect "$@" >/dev/null; then return 0; fi
        # A second launcher may have won after reset; do not reset again.
        description=$("$systemctl" --user show --property=Description --value "$unit") || return 1
        state=$("$systemctl" --user show --property=ActiveState --value "$unit") || return 1
        if [ "$description" = "$owner" ]; then
          case "$state" in active|activating) return 0 ;; esac
        fi
        ;;
    esac
  fi
  echo "Unable to start preview unit $unit (state=$state); refusing further recovery" >&2
  return 1
}

# NAME=VALUE words for env(1). Keep the OS profile unchanged; isolate only
# Faravan's data for this second install.
set -- \
  "FARAVAN_DATA_HOME=$channel_data" \
  "CODEX_HOME=$root/codex-home" \
  "CLAUDE_CONFIG_DIR=$root/claude-config" \
  "FARAVAN_NO_AUTOSTART=1" \
  "FARAVAN_NO_UPDATE=1" \
  "FARAVAN_NO_BROWSER=1"

# The bundled helper owns the complete profile transaction. Any uncertainty
# stops here, before either service or foreground CLI can initialize data.
"$bundle/usr/lib/faravan/runtime/bin/node" \
  "$bundle/usr/lib/faravan/lib/product-home-move.mjs" "$channel_data"
# The app unit starts asynchronously. Note its discovery record now, so the final exec can wait for the unit's app.
app_record="$channel_data/v1/app.json"
app_record_before=$(stat -c '%i %y' "$app_record" 2>/dev/null || echo none)
app_was_active=no
if "$systemctl" --user is-active --quiet "$app_unit"; then app_was_active=yes; fi
app_diagnostics="$data_home/.Faravan.diagnostics/preview-app-stderr.log"
app_failure() {
  echo "Preview app diagnostics (private, redacted, at most 64 KiB): $app_diagnostics" >&2
}
# --app runs the arguments after the executable (here: faravan app --json).
# The wrapper retains private bounded stderr diagnostics and forwards signals/status.
# Strip even stale manager desktop variables from the deliberately headless app.
start_unit "$app_unit" \
  --property=KillMode=control-group --property=StandardOutput=null --property=StandardError=null \
  -- /usr/bin/env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY -u WAYLAND_DISPLAY \
  -u XDG_CURRENT_DESKTOP -u KDE_SESSION_VERSION -u XDG_SESSION_TYPE \
  -u XDG_RUNTIME_DIR -u XAUTHORITY -u FARAVAN_HOME -u FARAVAN_HOME \
  "PATH=$unit_path" "$@" "$bundle/usr/lib/faravan/runtime/bin/node" \
  "$bundle/usr/lib/faravan/lib/preview-migration.mjs" --app "$channel_data" "$bundle/usr/bin/faravan" app --json || {
    app_failure
    echo "Unable to start preview app unit $app_unit" >&2
    exit 1
  }
# Save the final CLI environment before adding caller-only desktop settings to the tray.
# Wait up to 15 s for a unit this launch started to publish its record. Otherwise the final exec could take the app lock
# first; the unit then exits, and the app lives only as long as this launch's process.
wait_app_unit() {
  tries=0
  while [ "$tries" -lt 150 ]; do
    state=$("$systemctl" --user show --property=ActiveState --value "$app_unit") || return 1
    case "$state" in
      active|activating) ;;
      *) echo "Preview app unit $app_unit is $state before readiness" >&2; return 1 ;;
    esac
    now=$(stat -c '%i %y' "$app_record" 2>/dev/null || echo none)
    if [ "$state" = active ] && [ "$now" != none ] &&
      { [ "$app_was_active" = yes ] || [ "$now" != "$app_record_before" ]; }; then
      "$systemctl" --user is-active --quiet "$app_unit" && return 0
      echo "Preview app unit $app_unit exited during readiness" >&2
      return 1
    fi
    sleep 0.1
    tries=$((tries + 1))
  done
  echo "Timed out waiting for preview app unit $app_unit readiness" >&2
  return 1
}
launch_cli() {
  wait_app_unit || { app_failure; return 1; }
  flock -u 9
  exec 9>&-
  exec /usr/bin/env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY -u WAYLAND_DISPLAY \
    -u XDG_CURRENT_DESKTOP -u KDE_SESSION_VERSION -u XDG_SESSION_TYPE \
    -u XDG_RUNTIME_DIR -u XAUTHORITY -u FARAVAN_HOME -u FARAVAN_HOME \
    "PATH=$unit_path" "$@" "$bundle/usr/bin/faravan" app
}
launch_tray() {
  # Clear manager values first; append only variables actually set in this caller.
  for key in $FARAVAN_SESSION_VARIABLES; do
    eval 'present=${'"$key"'+x}'
    if [ "$present" = x ]; then
      eval 'value=${'"$key"'}'
      set -- "$@" "$key=$value"
    fi
  done
  start_unit "$tray_unit" \
    --property=KillMode=control-group --property=StandardOutput=null --property=StandardError=journal \
    -- /usr/bin/env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY -u WAYLAND_DISPLAY \
    -u XDG_CURRENT_DESKTOP -u KDE_SESSION_VERSION -u XDG_SESSION_TYPE \
    -u XDG_RUNTIME_DIR -u XAUTHORITY -u FARAVAN_HOME -u FARAVAN_HOME \
    "PATH=$unit_path" "$@" "$bundle/usr/lib/faravan/faravan-tray" ||
      echo "Unable to start preview tray unit $tray_unit; app remains available" >&2
}
launch_tray "$@"
launch_cli "$@"
LAUNCHER
# Hash the canonical generated launcher as well as the staged tree. The identity
# slot is normalized; non-service launcher edits conservatively change identity.
build_identity=$(node --input-type=module - "$launcher" "$build_identity" <<'SPEC_HASH'
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const template = readFileSync(process.argv[2], 'utf8').replace(
  /^build_identity='[a-f0-9]{64}'$/m, "build_identity='@BUILD_IDENTITY@'");
console.log(createHash('sha256').update(JSON.stringify([
  'faravan-preview-unit-spec-v1', process.argv[3], template,
])).digest('hex'));
SPEC_HASH
)
sed "s/^build_identity='[a-f0-9]*'$/build_identity='$build_identity'/" "$launcher" > "$launcher.identity"
mv "$launcher.identity" "$launcher"
chmod 0755 "$launcher"
sh -n "$launcher"

tarball="$dist/${name}_linux_amd64.tar.gz"
cp "$package_dir/MIGRATION.md" "$out/MIGRATION.md"
tar -C "$out" -czf "$tarball" usr MIGRATION.md
printf 'built:\n  %s\n  %s\n' "$out" "$tarball"
