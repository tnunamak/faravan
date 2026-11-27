#!/usr/bin/env bash
# Install an older .deb the way a person does (sudo apt install ./x.deb, in a real systemd user
# session), then install the new one over it and check what the person is left with.
#
#   packaging/upgrade-smoke.sh OLD.deb NEW.deb
#
# Each scenario gets its own disposable container with systemd as PID 1 (privileged, and its own
# cgroup namespace). Nothing touches this computer's systemd, the installed Faravan, or the network
# beyond pulling the base image. The new .deb must report the version in its VERSION file through
# the running app's own API after the upgrade.
set -euo pipefail

[[ $# -ge 2 && $# -le 3 && -f $1 && -f $2 ]] || { echo "usage: upgrade-smoke.sh OLD.deb NEW.deb [TRANSITION.deb]" >&2; exit 2; }
old_deb="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
new_deb="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
transition_deb="${3:-}"
[ -z "$transition_deb" ] || transition_deb="$(cd "$(dirname "$transition_deb")" && pwd)/$(basename "$transition_deb")"
command -v docker >/dev/null 2>&1 || { echo "missing required command: docker" >&2; exit 1; }

image=faravan-upgrade-proof:local
run_id="$$"
containers=()
cleanup() { for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

docker build -q -t "$image" - >/dev/null <<'EOF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session sudo ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && (id ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) \
 && useradd --create-home --uid 1000 --shell /bin/bash tester \
 && echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF

passed=0
fail() { echo "UPGRADE SMOKE FAILED [$scenario]: $*" >&2; exit 1; }
check() { passed=$((passed + 1)); echo "  ok: $*"; }

start_container() { # start_container NAME: systemd up, tester lingering with a user bus
  scenario=$1
  ct="spk-upgrade-$run_id-$1"
  containers+=("$ct")
  docker run -d --log-driver none --name "$ct" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
  docker exec "$ct" systemctl is-system-running --wait >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do docker exec "$ct" loginctl enable-linger tester >/dev/null 2>&1 && break; sleep 0.2; done
  docker exec "$ct" loginctl show-user tester >/dev/null 2>&1 || fail "could not enable linger for the test user"
  for _ in $(seq 1 50); do docker exec "$ct" test -S /run/user/1000/bus && break; sleep 0.2; done
  docker exec "$ct" test -S /run/user/1000/bus || fail "no user session bus"
  # The bus socket exists before the user manager answers on it.
  for _ in $(seq 1 50); do tester systemctl --user show-environment >/dev/null 2>&1 && break; sleep 0.2; done
  tester systemctl --user show-environment >/dev/null 2>&1 || fail "the user systemd manager does not answer"
  docker cp "$old_deb" "$ct:/tmp/old.deb"
  docker cp "$new_deb" "$ct:/tmp/new.deb"
  [ -z "$transition_deb" ] || docker cp "$transition_deb" "$ct:/tmp/transition.deb"
}
tester() { docker exec -u tester -e XDG_RUNTIME_DIR=/run/user/1000 "$ct" "$@"; }
unit() { tester systemctl --user "$@"; }
# apt's own exit status decides: a package whose postinst fails must not look installed. Only the progress
# noise is filtered, and an empty filtered result is not an error.
install_deb() {
  local status=0 output extra= package
  package="$(dpkg-deb -f "$([[ $1 == old ]] && echo "$old_deb" || echo "$new_deb")" Package)"
  if [ "$1" = new ] && [ -n "$transition_deb" ]; then extra=/tmp/transition.deb; fi
  output="$(docker exec -u tester "$ct" sudo env FARAVAN_POSTINST_CLI_TIMEOUT=5 apt-get install -y "/tmp/$1.deb" ${extra:+"$extra"} 2>&1)" || status=$?
  printf '%s\n' "$output" | grep -v '^(Reading database' || true
  [[ $status -eq 0 ]] || fail "apt-get install /tmp/$1.deb exited $status"
  local want
  want="$(dpkg-deb -f "$([[ $1 == old ]] && echo "$old_deb" || echo "$new_deb")" Version)"
  [[ "$(docker exec "$ct" dpkg-query -W -f='${Status} ${Version}' "$package")" == "install ok installed $want" ]] ||
    fail "dpkg does not report faravan $want as installed and configured"
  if [ "$1" = old ]; then
    old_home="$(tester env FARAVAN_NO_AUTOSTART=1 faravan app info --json | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8")).home)')"
  fi
}
# A deliberately hung old app must not hold the upgrade gate while its status endpoint never replies.
app_version() { tester timeout 5s env FARAVAN_NO_AUTOSTART=1 faravan update status --json 2>/dev/null | sed -n 's/.*"currentVersion":"\([^"]*\)".*/\1/p'; }
app_version_faravan() { tester timeout 5s env FARAVAN_NO_AUTOSTART=1 faravan update status --json 2>/dev/null | sed -n 's/.*"currentVersion":"\([^"]*\)".*/\1/p'; }
main_pid() { unit show -p MainPID --value faravan-app.service; }
expect_version="$(dpkg-deb --fsys-tarfile "$new_deb" | tar -xO ./usr/lib/faravan/VERSION | tr -d '\n')"

wait_for() { # wait_for DESCRIPTION COMMAND...
  local what=$1; shift
  for _ in $(seq 1 40); do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; done
  fail "timed out waiting for $what"
}
app_is_new() { [[ "$(app_version)" == "$expect_version" ]]; }

device_state_snapshot() {
  tester /usr/lib/faravan/runtime/bin/node -e '
    const fs=require("node:fs"), path=require("node:path"), crypto=require("node:crypto");
    const home=process.argv[1], state=path.join(home,"v1/state.json"), key=path.join(home,"v1/device.pem");
    if(!fs.existsSync(state)) fs.writeFileSync(state,JSON.stringify({version:1,circles:[],activeCircle:null,ownerName:"Synthetic upgrade test"}),{mode:0o600,flag:"wx"});
    const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    console.log(JSON.stringify({homeInode:fs.statSync(home).ino,stateDigest:hash(state),keyInode:fs.statSync(key).ino,keyDigest:hash(key)}));
  ' "$old_home"
}

# Output of the upgrade, captured so scenarios can check what the person is told.
upgrade_output=
upgrade() { upgrade_output="$(install_deb new 2>&1)" || { printf '%s\n' "$upgrade_output" >&2; exit 1; }; }

echo "== new .deb sorts above the old one (an upgrade, not a downgrade)"
scenario=ordering
old_version="$(dpkg-deb -f "$old_deb" Version)" new_version="$(dpkg-deb -f "$new_deb" Version)"
dpkg --compare-versions "$new_version" gt "$old_version" || fail "$new_version does not sort above $old_version"
check "$new_version > $old_version"

echo "== fresh install behaves as before: enabled and started"
start_container fresh
install_deb new >/dev/null
[[ "$(unit is-enabled faravan-app.service)" == enabled ]] || fail "not enabled"
[[ "$(unit is-active faravan-app.service)" == active ]] || fail "not started"
wait_for "the app to report $expect_version" app_is_new
docker exec "$ct" test ! -e /var/lib/faravan/previous-package-version || fail "fresh install left an upgrade record"
check "fresh install: enabled, running, reports $expect_version"

echo "== upgrade, enabled and running: the app restarts on the new code"
start_container enabled-running
install_deb old >/dev/null
[[ "$(unit is-active faravan-app.service)" == active ]] || fail "old version did not start"
old_pid="$(main_pid)"
[[ "$(app_version)" != "$expect_version" ]] || fail "the old app already reports the new version"
wait_for "the old device identity" tester test -s "$old_home/v1/device.pem"
old_device_state="$(device_state_snapshot)"
upgrade
grep -q "restarted on version $expect_version" <<<"$upgrade_output" || fail "output does not say the app restarted: $upgrade_output"
[[ "$(unit is-enabled faravan-app.service)" == enabled ]] || fail "enablement lost"
[[ "$(unit is-active faravan-app.service)" == active ]] || fail "not running after upgrade"
[[ "$(main_pid)" != "$old_pid" ]] || fail "the app was not restarted (pid $old_pid)"
app_is_new || fail "the running app reports '$(app_version)', expected $expect_version"
[[ "$(device_state_snapshot)" == "$old_device_state" ]] || fail "committed state, home inode or device key changed"
[[ "$(app_version_faravan)" == "$expect_version" ]] || fail "the faravan shim reports '$(app_version_faravan)', expected $expect_version"
docker exec "$ct" test -x /usr/bin/faravan || fail "the legacy faravan command was not kept"
docker exec "$ct" test -x /usr/bin/faravan || fail "the Faravan command was not installed"
default_home_info="$(tester env FARAVAN_NO_AUTOSTART=1 faravan app info --json 2>/dev/null)"
grep -qF "\"home\":\"$old_home\"" <<<"$default_home_info" ||
  fail "the upgraded command did not keep the existing $old_home home: $default_home_info"
legacy_home=/home/tester/.faravan-compat
legacy_home_info="$(tester env FARAVAN_HOME="$legacy_home" FARAVAN_NO_AUTOSTART=1 faravan app info --json 2>/dev/null)"
grep -qF "\"home\":\"$legacy_home\"" <<<"$legacy_home_info" ||
  fail "the Faravan command did not honor the existing FARAVAN_HOME setting: $legacy_home_info"
check "restarted (pid $old_pid -> $(main_pid)); both commands and the existing home/env name still work"

echo "== upgrade, startup disabled and app stopped: stays disabled and stopped"
start_container disabled-stopped
install_deb old >/dev/null
unit disable --now faravan-app.service >/dev/null 2>&1
upgrade
[[ "$(unit is-enabled faravan-app.service || true)" == disabled ]] || fail "the upgrade enabled startup again"
[[ "$(unit is-active faravan-app.service || true)" != active ]] || fail "the upgrade started a stopped app"
grep -q "not running, as you left it" <<<"$upgrade_output" || fail "output does not say the app was left stopped: $upgrade_output"
check "still disabled, still stopped"

echo "== upgrade, startup disabled but app running: stays disabled, runs the new code"
start_container disabled-running
install_deb old >/dev/null
unit disable faravan-app.service >/dev/null 2>&1
[[ "$(unit is-active faravan-app.service)" == active ]] || fail "the app stopped when startup was disabled"
upgrade
[[ "$(unit is-enabled faravan-app.service || true)" == disabled ]] || fail "the upgrade enabled startup again"
[[ "$(unit is-active faravan-app.service)" == active ]] || fail "not running after upgrade"
app_is_new || fail "the running app reports '$(app_version)', expected $expect_version"
check "still disabled, restarted, reports $expect_version"

echo "== upgrade, startup enabled but the person quit the app: not started behind their back"
start_container enabled-stopped
install_deb old >/dev/null
tester faravan app quit --yes --json >/dev/null
wait_for "the app to stop" bash -c "! docker exec -u tester -e XDG_RUNTIME_DIR=/run/user/1000 $ct systemctl --user is-active --quiet faravan-app.service"
upgrade
[[ "$(unit is-enabled faravan-app.service)" == enabled ]] || fail "enablement lost"
[[ "$(unit is-active faravan-app.service || true)" != active ]] || fail "the upgrade started an app the person had quit"
check "still enabled, still stopped"

# A stand-in for the running app in the unit. STUB_MODE says how it behaves:
#   busy  answers like the real app with a job running: quit is refused with job_running (409)
#   hang  accepts connections and never answers (a wedged app)
#   none  runs, but has no discovery file, so no app answers
# These test what the installer does with each answer, not the lender itself.
use_stand_in_app() { # use_stand_in_app MODE
  docker exec -i "$ct" tee /tmp/stand-in-app.mjs >/dev/null <<'EOF'
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
const mode = process.env.STUB_MODE, dir = process.env.FARAVAN_HOME + '/v1', token = 'stand-in-token';
process.on('SIGTERM', () => { rmSync(dir + '/app.json', { force: true }); process.exit(0); });
if (mode === 'none') setInterval(() => {}, 1000);
else {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const server = createServer((request, response) => {
    if (mode === 'hang') return;
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.headers['x-faravan-session-token'] !== token) return send(401, { code: 'unauthorized' });
    if (request.method === 'GET' && request.url === '/api/updates') return send(200, { currentVersion: 'stand-in' });
    if (request.method === 'POST' && /shutdown|app\.quit/.test(request.url)) return send(409, { code: 'job_running', message: 'A job is running.' });
    send(404, { code: 'not_found' });
  });
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(dir + '/app.json', JSON.stringify({ port: server.address().port, token, pid: process.pid, started_at: new Date().toISOString() }), { mode: 0o600 });
  });
}
EOF
  docker exec -u tester "$ct" mkdir -p /home/tester/.config/systemd/user/faravan-app.service.d
  docker exec -i -u tester "$ct" tee /home/tester/.config/systemd/user/faravan-app.service.d/stand-in.conf >/dev/null <<EOF
[Service]
Environment=STUB_MODE=$1
Environment=FARAVAN_HOME=$old_home
ExecStart=
ExecStart=/usr/lib/faravan/runtime/bin/node /tmp/stand-in-app.mjs
EOF
  unit daemon-reload
  unit restart faravan-app.service
  wait_for "the stand-in app" unit is-active --quiet faravan-app.service
  [[ $1 == none ]] || wait_for "its discovery file" docker exec -u tester "$ct" test -s "$old_home/v1/app.json"
}
# After an upgrade over a stand-in app: it was left alone, still enabled, and nothing claims it restarted.
expect_left_running() { # expect_left_running PID
  [[ "$(main_pid)" == "$1" ]] || fail "the upgrade restarted an app that could not be asked to quit"
  [[ "$(unit is-enabled faravan-app.service)" == enabled ]] || fail "enablement lost"
  ! grep -qiE "restarted on version|app restarted" <<<"$upgrade_output" || fail "output claims a restart that did not happen: $upgrade_output"
  ! app_is_new || fail "the app reports the new version, so it was restarted"
}

echo "== upgrade while the app refuses to quit (a job is running): left running, told how to restart"
start_container busy
install_deb old >/dev/null
use_stand_in_app busy
stand_in_pid="$(main_pid)"
upgrade
expect_left_running "$stand_in_pid"
grep -q "a job is running or a review is waiting" <<<"$upgrade_output" || fail "output does not name the refusal: $upgrade_output"
grep -qF "faravan app quit --yes && systemctl --user restart faravan-app.service" <<<"$upgrade_output" || fail "output does not say how to restart: $upgrade_output"
check "refusal respected (pid $stand_in_pid kept), restart left pending with the command to run"

for mode in hang none; do
  echo "== upgrade while the old app does not answer ($mode): never reported as restarted"
  start_container "unanswered-$mode"
  install_deb old >/dev/null
  use_stand_in_app "$mode"
  stand_in_pid="$(main_pid)"
  upgrade
  expect_left_running "$stand_in_pid"
  grep -q "did not answer" <<<"$upgrade_output" || fail "output does not say the app did not answer: $upgrade_output"
  grep -qF "systemctl --user restart faravan-app.service" <<<"$upgrade_output" || fail "output does not say how to restart: $upgrade_output"
  check "$mode: unit active (pid $stand_in_pid) but unanswered; left alone and reported as not restarted"
done

tray_pids() { docker exec "$ct" bash -c 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = faravan-tray ] && echo ${p#/proc/}; done; true'; }
# Stand-in trays: a copy of sleep that carries the tray's name, started in a desktop-like environment whose
# PATH has no setsid on it (as in a real session).
start_stand_in_tray() { # start_stand_in_tray [stubborn]
  local prefix=exec
  [[ ${1:-} == stubborn ]] && prefix='trap "" TERM; exec' # an ignored signal stays ignored across exec
  docker exec -u tester "$ct" bash -c "setsid -f env -i PATH=/nonexistent DISPLAY=:99 HOME=/home/tester /bin/sh -c '$prefix /usr/lib/faravan/faravan-tray 600' </dev/null >/dev/null 2>&1"
  for _ in $(seq 1 20); do [[ $(tray_pids | wc -l) -ge ${tray_count:-1} ]] && break; sleep 0.2; done
}

echo "== upgrade restarts a running tray, in the same desktop session, though setsid is not on its PATH"
start_container tray
install_deb old >/dev/null
docker exec "$ct" cp /bin/sleep /usr/lib/faravan/faravan-tray
start_stand_in_tray
old_tray="$(tray_pids)"
[[ -n "$old_tray" ]] || fail "the stand-in tray did not start"
upgrade
docker exec "$ct" test ! -e "/proc/$old_tray" || fail "the old tray process $old_tray is still running"
new_tray="$(tray_pids | head -1)"
grep -q "tray restarted" <<<"$upgrade_output" || fail "output does not say the tray restarted: $upgrade_output"
# The message is only allowed when a new tray process exists, from the installed binary, in the old session's environment.
[[ -n "$new_tray" && "$new_tray" != "$old_tray" ]] || fail "output says the tray restarted but no new tray process runs: $upgrade_output"
docker exec "$ct" bash -c "tr '\\0' '\\n' </proc/$new_tray/environ | grep -qx DISPLAY=:99" || fail "the new tray did not inherit the old tray's DISPLAY"
[[ "$(docker exec "$ct" readlink "/proc/$new_tray/exe")" == /usr/lib/faravan/faravan-tray ]] || fail "the new tray is not the installed binary"
check "old tray $old_tray replaced by $new_tray (same DISPLAY, installed binary, no setsid on the old PATH)"

echo "== upgrade with two trays, one of which will not stop: not reported as restarted"
start_container tray-stubborn
install_deb old >/dev/null
docker exec "$ct" cp /bin/sleep /usr/lib/faravan/faravan-tray
tray_count=1 start_stand_in_tray
tray_count=2 start_stand_in_tray stubborn
[[ $(tray_pids | wc -l) -eq 2 ]] || fail "two stand-in trays did not start"
upgrade
! grep -q "tray restarted" <<<"$upgrade_output" || fail "output says the tray restarted although an old tray is still running: $upgrade_output"
grep -q "tray could not be restarted" <<<"$upgrade_output" || fail "output does not say the tray could not be restarted: $upgrade_output"
check "an old tray that would not stop was reported, not hidden by the replacement"

echo "== the harness itself: a package whose postinst fails is not reported as installed"
start_container selfcheck
work="$(mktemp -d)"
dpkg-deb -R "$new_deb" "$work/root"
printf '\nexit 1\n' >>"$work/root/DEBIAN/postinst"
dpkg-deb --root-owner-group -b "$work/root" "$work/bad.deb" >/dev/null
docker cp "$work/bad.deb" "$ct:/tmp/new.deb"
rm -rf -- "$work"
if (install_deb new) >/dev/null 2>&1; then fail "install_deb accepted a package whose postinst exits 1"; fi
check "a failing postinst fails the harness"

if [ -n "$transition_deb" ]; then
  for order in transition-first faravan-first; do
    for mode in running disabled-stopped; do
      echo "== package rename: $order, $mode"
      start_container "$order-$mode"
      install_deb old >/dev/null
      if [ "$mode" = disabled-stopped ]; then unit disable --now faravan-app.service >/dev/null 2>&1; fi
      before_pid="$(main_pid)"
      if [ "$order" = transition-first ]; then
        docker exec "$ct" dpkg --unpack /tmp/transition.deb >/dev/null
        docker exec "$ct" dpkg --unpack /tmp/new.deb >/dev/null
      else
        docker exec "$ct" dpkg --auto-deconfigure --unpack /tmp/new.deb >/dev/null
        docker exec "$ct" dpkg --unpack /tmp/transition.deb >/dev/null
      fi
      docker exec -u tester "$ct" sudo env FARAVAN_POSTINST_CLI_TIMEOUT=5 apt-get -f install -y >/dev/null
      if [ "$mode" = running ]; then
        [[ "$(unit is-enabled faravan-app.service)" == enabled ]] || fail "startup choice lost"
        app_is_new || fail "new app is not running after $order"
        [[ "$(main_pid)" != "$before_pid" ]] || fail "old app was not restarted"
      else
        [[ "$(unit is-enabled faravan-app.service || true)" == disabled ]] || fail "startup was enabled"
        [[ "$(unit is-active faravan-app.service || true)" != active ]] || fail "stopped app was started"
      fi
      docker exec "$ct" test ! -e /var/lib/faravan/previous-package-version || fail "migration record leaked"
      [[ "$(docker exec "$ct" dpkg-query -W -f='${Status}' faravan)" == 'install ok installed' ]] || fail "payload not configured"
      [[ "$(docker exec "$ct" dpkg-query -W -f='${Status}' faravan)" == 'install ok installed' ]] || fail "transition not configured"
      check "$order preserves $mode and clears its migration record"
    done
  done

  echo "== apt upgrade follows the transitional dependency"
  start_container apt-rename
  install_deb old >/dev/null
  work="$(mktemp -d)"
  cp "$new_deb" "$work/payload.deb"
  cp "$transition_deb" "$work/transition.deb"
  (cd "$work" && dpkg-scanpackages . /dev/null > Packages)
  chmod 0755 "$work"
  docker cp "$work" "$ct:/opt/rename-repo"
  rm -rf -- "$work"
  docker exec "$ct" sh -c 'printf "%s\n" "deb [trusted=yes] file:/opt/rename-repo ./" > /etc/apt/sources.list.d/rename-test.list'
  docker exec "$ct" apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/rename-test.list -o Dir::Etc::sourceparts=- update >/dev/null
  docker exec -u tester "$ct" sudo env FARAVAN_POSTINST_CLI_TIMEOUT=5 apt upgrade -y >/dev/null
  app_is_new || fail "apt upgrade did not restart on the candidate"
  [[ "$(docker exec "$ct" dpkg-query -W -f='${Version}' faravan)" == "$new_version" ]] || fail "transition did not upgrade"
  [[ "$(docker exec "$ct" dpkg-query -W -f='${Version}' faravan)" == "$new_version" ]] || fail "payload did not install"
  check "apt upgrade installs faravan through faravan's exact dependency"
fi

echo "upgrade smoke passed: $passed checks ($old_version -> $new_version)"
