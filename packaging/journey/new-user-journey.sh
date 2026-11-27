#!/usr/bin/env bash
# Prove a two-person journey from the release tarball through a finished lent job.
set -Eeuo pipefail
unset DISPLAY WAYLAND_DISPLAY
export FARAVAN_NO_BROWSER=1 FARAVAN_NO_BROWSER=1 FARAVAN_NO_UPDATE=1
export JOURNEY_VERSION=15 HARNESS_VERSION=15

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
MODE="${1:-}"
if [[ "$MODE" != --synthetic && "$MODE" != --live ]]; then
  echo "usage: bash packaging/journey/new-user-journey.sh --synthetic|--live" >&2
  exit 2
fi
if [[ "$MODE" == --live && "${JOURNEY_LIVE_CONFIRM:-}" != 1 ]]; then
  echo "refusing --live: set JOURNEY_LIVE_CONFIRM=1" >&2
  exit 2
fi
SOURCE_HEAD="$(git -C "$SRC" rev-parse HEAD)"
export JOURNEY_SOURCE_HEAD="$SOURCE_HEAD"
if [[ -n "$(git -C "$SRC" status --porcelain)" ]]; then
  echo "refusing journey: source tree must be clean" >&2
  exit 2
fi
if [[ "$MODE" == --live ]]; then
  passes="$(node --input-type=module - "$HOME/.tmp/faravan-journey" <<'NODE'
import fs from 'node:fs';
import {join} from 'node:path';
const root = process.argv[2];
let count = 0;
for (const name of fs.readdirSync(root, {withFileTypes: true}).filter(x => x.isDirectory() && x.name.startsWith('run-')).map(x => x.name)) {
  try {
    const s = JSON.parse(fs.readFileSync(join(root, name, 'summary.json'), 'utf8'));
    if (s.mode === 'synthetic' && s.journeyVersion === 15 && s.harnessVersion === 15 &&
        s.sourceHead === process.env.JOURNEY_SOURCE_HEAD && s.sourceTreeClean === true && s.pass === true) count++;
  } catch {}
}
process.stdout.write(String(count));
NODE
  )"
  if [[ "$passes" -lt 2 ]]; then
    echo "refusing --live: two passing synthetic runs of this harness are required; found $passes" >&2
    exit 2
  fi
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_ROOT="$HOME/.tmp/faravan-journey"
RUN="$RUN_ROOT/run-$STAMP"
mkdir -p "$RUN_ROOT"
if ! mkdir -m 700 "$RUN"; then
  echo "refusing journey: cannot create a new run directory: $RUN" >&2
  exit 2
fi
export JOURNEY_RUN="$RUN" JOURNEY_SRC="$SRC" JOURNEY_MODE="$MODE"
export JOURNEY_LIVE_CONFIRM="${JOURNEY_LIVE_CONFIRM:-0}"
unset JOURNEY_SBX_SHORT_HOME_BASE

cleanup() {
  local status=$? role home launcher coord host_result app_result
  local -a stop_results=()
  trap - EXIT
  set +e
  for role in owner friend; do
    home="$RUN/$role/home"
    launcher="$home/.local/bin/faravan"
    coord="$RUN/smoke/$role/coordinator"
    host_result=not_needed
    if [[ -f "$RUN/smoke/started.$role.host" || -f "$coord/host.json" ]]; then
      host_result=unverified
      if [[ -x "$launcher" && -f "$coord/host.json" ]]; then
        env -u FARAVAN_HOME -u FARAVAN_HOME -u XDG_DATA_HOME -u XDG_CONFIG_HOME \
          -u FARAVAN_SBX_HOME -u FARAVAN_SBX_HOME FARAVAN_SBX_SHORT_HOME_BASE="${JOURNEY_SBX_SHORT_HOME_BASE:-}" \
          HOME="$home" FARAVAN_COORDINATOR_HOME="$coord" FARAVAN_COORDINATOR_HOME="$coord" \
          DBUS_SESSION_BUS_ADDRESS=disabled: timeout 30 "$launcher" host --stop --json
        host_result=$?
      fi
    fi
    app_result=not_needed
    if [[ -f "$RUN/started.$role.app" || -f "$RUN/smoke/started.$role.app" ]]; then
      app_result=unverified
      if [[ -x "$launcher" ]]; then
        env -u FARAVAN_HOME -u FARAVAN_HOME -u XDG_DATA_HOME -u XDG_CONFIG_HOME \
          -u FARAVAN_SBX_HOME -u FARAVAN_SBX_HOME FARAVAN_SBX_SHORT_HOME_BASE="${JOURNEY_SBX_SHORT_HOME_BASE:-}" \
          HOME="$home" FARAVAN_NO_AUTOSTART=1 FARAVAN_NO_AUTOSTART=1 \
          DBUS_SESSION_BUS_ADDRESS=disabled: timeout 30 "$launcher" app quit --yes --json
        app_result=$?
      fi
    fi
    stop_results+=("$host_result" "$app_result")
  done >"$RUN/cleanup.log" 2>&1
  if ! node "$HERE/cleanup.mjs" "$RUN" "$status" "${stop_results[@]}" && [[ "$status" -eq 0 ]]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node --input-type=module <<'NODE'
import fs from 'node:fs';
import {join} from 'node:path';
const run = process.env.JOURNEY_RUN;
const summary = {journeyVersion: Number(process.env.JOURNEY_VERSION), harnessVersion: Number(process.env.HARNESS_VERSION),
  sourceHead: process.env.JOURNEY_SOURCE_HEAD, sourceTreeClean: true,
  mode: process.env.JOURNEY_MODE.slice(2), startedAt: new Date().toISOString(), pass: false, steps: []};
fs.writeFileSync(join(run, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
NODE

# Docker's Unix socket must fit below the sandbox home. Record this run's short base so teardown can reclaim it.
JOURNEY_SBX_SHORT_HOME_BASE="$(mktemp -d /tmp/fj-XXXXXX)"
if ! printf '%s\n' "$RUN" >"$JOURNEY_SBX_SHORT_HOME_BASE/.journey-run"; then
  rmdir "$JOURNEY_SBX_SHORT_HOME_BASE"
  exit 1
fi
export JOURNEY_SBX_SHORT_HOME_BASE

step() {
  local name="$1"; shift
  if "$@" >"$RUN/$name.log" 2>&1; then
    node --input-type=module - "$RUN/summary.json" "$name" <<'NODE'
import fs from 'node:fs';
const [file, name] = process.argv.slice(2);
const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
summary.steps.push({name, pass: true});
fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
NODE
    printf 'PASS %s\n' "$name"
  else
    local status=$?
    node --input-type=module - "$RUN/summary.json" "$name" "$status" <<'NODE'
import fs from 'node:fs';
const [file, name, status] = process.argv.slice(2);
const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
summary.steps.push({name, pass: false, exitCode: Number(status)});
summary.pass = false;
summary.finishedAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
NODE
    printf 'FAIL %s (see %s/%s.log)\n' "$name" "$RUN" "$name" >&2
    exit "$status"
  fi
}

installed_launcher() {
  local role="$1" home="$RUN/$1/home" desktop="$RUN/$1/home/.local/share/applications/faravan.desktop"
  local launcher
  test -f "$desktop" || { echo "installed desktop entry missing: $desktop" >&2; return 1; }
  launcher="$(node --input-type=module - "$desktop" "$SRC" <<'NODE'
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [desktop, source] = process.argv.slice(2);
const {desktopLauncher} = await import(pathToFileURL(join(source, 'packaging/journey/evidence.mjs')));
const parsed = desktopLauncher(fs.readFileSync(desktop, 'utf8'));
if (!parsed || parsed.args.length) process.exit(2);
process.stdout.write(parsed.binary);
NODE
  )"
  test -x "$launcher" || { echo "desktop Exec is not an installed executable: $launcher" >&2; return 1; }
  : >"$RUN/started.$role.app" || return
  local -a app_env=(env -u FARAVAN_HOME -u FARAVAN_HOME -u XDG_DATA_HOME -u XDG_CONFIG_HOME
    -u FARAVAN_SBX_HOME -u FARAVAN_SBX_HOME FARAVAN_SBX_SHORT_HOME_BASE="$JOURNEY_SBX_SHORT_HOME_BASE" HOME="$home")
  "${app_env[@]}" FARAVAN_NO_BROWSER=1 FARAVAN_NO_BROWSER=1 timeout 120 "$launcher" || return
  "${app_env[@]}" timeout 120 "$home/.local/bin/faravan" app quit --yes --json
}

stage_release_tarball() {
  mkdir -p "$MEDIA"
  cp "$TARBALL" "$MEDIA/faravan_linux_amd64.tar.gz"
  # The release manifest is signed by a key made for this run, and the installer copy trusts only that key.
  node "$HERE/stage-release.mjs" --tarball "$MEDIA/faravan_linux_amd64.tar.gz" --version "$(sed -n 's/^MIN_INSTALL_VERSION="\(.*\)"$/\1/p' "$SRC/bin/faravan-install.sh")" \
    --media "$MEDIA" --installer "$SRC/bin/faravan-install.sh" --out "$RUN/installer" >/dev/null
}

prepare_user_homes() {
  for role in owner friend; do
    mkdir -p "$RUN/$role/home" "$RUN/$role/tmp" "$RUN/$role/coord" "$RUN/$role/codex" "$RUN/$role/claude" "$RUN/$role/run"
  done
}

step build-release env PACKAGE_VERSION=0.1.0 bash "$SRC/packaging/build.sh"
TARBALL="$SRC/packaging/dist/faravan_0.1.0_linux_amd64.tar.gz"
MEDIA="$RUN/install-media"
step release-tarball test -f "$TARBALL"
step stage-release-tarball stage_release_tarball
step prepare-user-homes prepare_user_homes
step install-owner env -u FARAVAN_HOME -u FARAVAN_HOME -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$RUN/owner/home" \
  FARAVAN_CHANNEL=stable FARAVAN_DOWNLOAD_BASE="file://$MEDIA" FARAVAN_RELEASE_API="file://$RUN/no-release-api" \
  FARAVAN_APT_KEY_FPR=REPLACE_WITH_ARCHIVE_KEY_FINGERPRINT FARAVAN_NO_TRAY_LAUNCH=1 \
  bash "$RUN/installer/faravan-install.sh"
step install-friend env -u FARAVAN_HOME -u FARAVAN_HOME -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$RUN/friend/home" \
  FARAVAN_CHANNEL=stable FARAVAN_DOWNLOAD_BASE="file://$MEDIA" FARAVAN_RELEASE_API="file://$RUN/no-release-api" \
  FARAVAN_APT_KEY_FPR=REPLACE_WITH_ARCHIVE_KEY_FINGERPRINT FARAVAN_NO_TRAY_LAUNCH=1 \
  bash "$RUN/installer/faravan-install.sh"
step installed-owner-launcher installed_launcher owner
step installed-friend-launcher installed_launcher friend

SMOKE_ARGS=("$SRC" "$MODE" "$RUN/smoke")
if [[ "$MODE" == --live ]]; then
  SMOKE_ARGS+=(--owner-home /home/example/.tmp/faravan-s6-owner)
  export SMOKE_LIVE_CONFIRM=1 SMOKE_OWNER_SBX_HOME=/home/example/.s6sbx
  export JOURNEY_LIVE_CONFIRM=1
fi
if node "$HERE/smoke.mjs" "${SMOKE_ARGS[@]}" >"$RUN/smoke.log" 2>&1; then
  node --input-type=module - "$RUN/summary.json" "$RUN/smoke/summary.json" <<'NODE'
import fs from 'node:fs';
const [file, smokeFile] = process.argv.slice(2);
const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
const smoke = JSON.parse(fs.readFileSync(smokeFile, 'utf8'));
summary.smoke = smoke;
summary.claimScope = smoke.claimScope;
for (const [name, pass] of Object.entries(smoke.checks ?? {})) summary.steps.push({name, pass: pass === true});
summary.steps.push({name: 'two-app-journey', pass: smoke.pass === true});
summary.totalSpendUsd = Number.isFinite(smoke.totalChargedUsd) ? smoke.totalChargedUsd : null;
if (summary.mode === 'synthetic' && smoke.meter?.before && smoke.meter?.afterJob2) {
  summary.providerMeterDelta = {recorded: true, source: 'synthetic fixture meter', usd: summary.totalSpendUsd,
    weeklyMicro: smoke.meter.afterJob2.weekly - smoke.meter.before.weekly,
    fiveHourMicro: smoke.meter.afterJob2.short - smoke.meter.before.short};
} else if (smoke.meter?.liveProviderDeltaRecorded === true) {
  summary.providerMeterDelta = {recorded: true, unit: 'quota micro-points', providerPointDeltas: smoke.meter.providerPointDeltas ?? []};
} else {
  summary.providerMeterDelta = {recorded: false, reason: smoke.meter?.liveProviderDeltaReason ?? 'No provider meter sample was recorded.'};
}
summary.journeyChecksPassed = summary.steps.every(step => step.pass === true);
summary.pass = false; // Cleanup must finish before this run counts as a pass.
summary.finishedAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
NODE
else
  status=$?
  node --input-type=module - "$RUN/summary.json" "$RUN/smoke/summary.json" <<'NODE'
import fs from 'node:fs';
const [file, smokeFile] = process.argv.slice(2);
const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
summary.smoke = fs.existsSync(smokeFile) ? JSON.parse(fs.readFileSync(smokeFile, 'utf8')) : {pass: false};
for (const [name, pass] of Object.entries(summary.smoke.checks ?? {})) summary.steps.push({name, pass: pass === true});
const failedChecks = Object.entries(summary.smoke.checks ?? {}).filter(([, pass]) => pass !== true).map(([name]) => name);
summary.steps.push({name: 'two-app-journey', pass: false, error: summary.smoke.error ??
  (fs.existsSync(smokeFile) ? 'checks failed: ' + (failedChecks.join(', ') || 'none named') : 'journey did not write a summary')});
summary.totalSpendUsd = Number.isFinite(summary.smoke.totalChargedUsd) ? summary.smoke.totalChargedUsd : null;
if (summary.mode === 'synthetic' && summary.smoke.meter?.before && summary.smoke.meter?.afterJob2) {
  summary.providerMeterDelta = {recorded: true, source: 'synthetic fixture meter', usd: summary.totalSpendUsd,
    weeklyMicro: summary.smoke.meter.afterJob2.weekly - summary.smoke.meter.before.weekly,
    fiveHourMicro: summary.smoke.meter.afterJob2.short - summary.smoke.meter.before.short};
} else if (summary.smoke.meter?.liveProviderDeltaRecorded === true) {
  summary.providerMeterDelta = {recorded: true, unit: 'quota micro-points', providerPointDeltas: summary.smoke.meter.providerPointDeltas ?? []};
} else {
  summary.providerMeterDelta = {recorded: false, reason: summary.smoke.meter?.liveProviderDeltaReason ?? 'No provider meter sample was recorded.'};
}
summary.pass = false;
summary.finishedAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
NODE
  cat "$RUN/summary.json"
  exit "$status"
fi
cat "$RUN/summary.json"
node --input-type=module - "$RUN/summary.json" <<'NODE'
import fs from 'node:fs';
const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (summary.journeyChecksPassed !== true) process.exit(1);
NODE
