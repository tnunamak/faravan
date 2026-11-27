#!/bin/sh
set -eu

# dpkg runs this as: postinst configure [PREVIOUS-VERSION]. PREVIOUS-VERSION is empty on a first install.
action=${1:-configure}
if [ "${DPKG_MAINTSCRIPT_PACKAGE:-faravan}" = faravan-test ]; then
  purge_state_dir=${FARAVAN_REMOVAL_TEST_STATE_DIR:?}
else
  purge_state_dir=/var/lib/faravan-removal
fi
purge_prepared_file=$purge_state_dir/purge-prepared
case "$action" in
  configure) ;;
  abort-remove)
    rm -f -- "$purge_prepared_file"
    rmdir "$purge_state_dir" 2>/dev/null || true
    exit 0
    ;;
  *) exit 0 ;;
esac
previous_version=${2:-}
if [ -z "$previous_version" ] && [ -s /var/lib/faravan/previous-package-version ]; then
  previous_version=$(cat /var/lib/faravan/previous-package-version)
fi
rm -f /var/lib/faravan/previous-package-version

# A reinstall after an interrupted purge starts a fresh removal transaction.
rm -f -- "$purge_prepared_file"
rmdir "$purge_state_dir" 2>/dev/null || true

unit=faravan-app.service
# Every call to the old app is bounded: a wedged app must not hold up apt. A quit may legitimately take up to a minute
# (the app proves no sandbox is left before it lets go). FARAVAN_POSTINST_CLI_TIMEOUT shortens both, for tests.
probe_timeout=${FARAVAN_POSTINST_CLI_TIMEOUT:-15}
quit_timeout=${FARAVAN_POSTINST_CLI_TIMEOUT:-90}
new_version=$(cat /usr/lib/faravan/VERSION 2>/dev/null || true)

# Test seams, set only by tests: the session runtime directory, the faravan CLI, and the packaged node and lib that write
# the install record. The defaults are the installed package. The session variables start empty (set -u).
cli=${FARAVAN_POSTINST_CLI:-/usr/bin/faravan}
runtime_node=${FARAVAN_POSTINST_NODE:-/usr/lib/faravan/runtime/bin/node}
app_lib=${FARAVAN_POSTINST_LIB:-/usr/lib/faravan/lib}
user_uid= user_name= user_home= runtime_dir=
# The outcome for the install record (docs/design/TELEMETRY.md §3.4): the first thing that went wrong in this run.
install_outcome=ok
install_started=$(date +%s%N 2>/dev/null || echo 0)
# A failure outranks a deferral, and the first failure of a run wins. deferred (a restart left for later) is not ok.
note_outcome() { case $install_outcome in ok|deferred) install_outcome=$1 ;; esac; }
# Run by the packaged runtime as the user, so the app's own home rule and its own record writer apply.
install_record='const [lib, method, outcome, ms] = process.argv.slice(1);
const { configHome } = await import(lib + "/local-state.mjs");
const { writeInstallRun } = await import(lib + "/v1/telemetry/crash.mjs");
const { join } = await import("node:path");
writeInstallRun({ dir: join(configHome(), "v1", "telemetry"), method, outcome, durationMs: Number(ms) });'

# Package installation must never create a root app, enable lingering, or pick
# an arbitrary logged-in user. Only use the caller's existing user session.
find_user_session() {
  command -v systemctl >/dev/null 2>&1 || return 1
  user_uid=$(id -u)
  user_name=
  user_home=${HOME:-}
  if [ "$user_uid" -eq 0 ]; then
    user_name=${SUDO_USER:-}
    [ -n "$user_name" ] && [ "$user_name" != root ] || return 1
    user_uid=$(id -u -- "$user_name") || return 1
    [ "$user_uid" -ne 0 ] && [ "$user_uid" = "${SUDO_UID:-}" ] || return 1
    command -v runuser >/dev/null 2>&1 || return 1
    user_home=$(getent passwd "$user_name" | cut -d: -f6) || return 1
  fi
  runtime_dir=${FARAVAN_POSTINST_RUNTIME_DIR:-/run/user/$user_uid}
  [ -d "$runtime_dir" ] && [ -S "$runtime_dir/bus" ] || return 1
  [ "$(stat -c %u "$runtime_dir")" = "$user_uid" ] || return 1
}

# Run a command as the session's user, inside that user's session bus. FARAVAN_NO_AUTOSTART keeps a
# faravan command from starting an app of its own when it finds none running.
as_user() {
  if [ -n "$user_name" ]; then
    runuser -u "$user_name" -- env HOME="$user_home" XDG_RUNTIME_DIR="$runtime_dir" FARAVAN_NO_AUTOSTART=1 \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_dir/bus" "$@"
  else
    env XDG_RUNTIME_DIR="$runtime_dir" FARAVAN_NO_AUTOSTART=1 DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_dir/bus" "$@"
  fi
}
user_systemctl() { as_user systemctl --user "$@"; }

# The version the running app reports through its own local API, or nothing when no app answers.
running_version() {
  as_user timeout "$probe_timeout" "$cli" update status --json 2>/dev/null |
    sed -n 's/.*"currentVersion":"\([^"]*\)".*/\1/p'
}

wait_until() { # wait_until SECONDS COMMAND...: true as soon as COMMAND succeeds
  seconds=$1; shift
  while [ "$seconds" -gt 0 ]; do
    "$@" && return 0
    seconds=$((seconds - 1)); sleep 1
  done
  "$@"
}
unit_stopped() { ! user_systemctl is-active --quiet "$unit"; }
app_runs_new_version() { [ "$(running_version)" = "$new_version" ]; }

# An upgrade replaces the files under a running app. Each message says what is true of the app now.
restart_pending() { # the app refused to quit, so it still runs and still owns its job
  note_outcome deferred
  printf '%s\n' "Faravan $new_version is installed, but the running app is still the previous version: a job is running or a review is waiting." \
    'It was left running so no job is lost. When it is safe to restart, run:' \
    "  faravan app quit --yes && systemctl --user restart $unit"
}
restart_unanswered() { # the app did not answer the quit, so nothing is known about its jobs
  note_outcome quit_unanswered
  printf '%s\n' "Faravan $new_version is installed, but the running app did not answer, so it is still the previous version." \
    'It was left running because Faravan could not check whether it is running a job. To restart it when it answers:' \
    "  faravan app quit --yes && systemctl --user restart $unit" \
    'To restart it now, which ends any job it is running:' \
    "  systemctl --user restart $unit"
}
restart_stuck() { # the app accepted the quit but is still shutting down
  note_outcome restart_failed
  printf '%s\n' "Faravan $new_version is installed. The app was asked to quit and is still shutting down." \
    "When it has stopped, start it again with: systemctl --user start $unit"
}
restart_failed() { # the app was stopped for the upgrade and is not running now
  note_outcome restart_failed
  printf '%s\n' "Faravan $new_version is installed. The app was stopped for the upgrade and is not running." \
    "Start it with: systemctl --user start $unit" "If that fails, see: systemctl --user status $unit"
}

restart_app() {
  # app quit refuses while a lent job runs or a review is waiting (exit 4), and proves no sandbox is
  # left before it lets go. Lending resumes as the person set it when the app starts again. Only a quit
  # the app accepted lets the unit be restarted; an app that does not answer (no discovery file, a dead
  # or wedged process, a timeout) may still own a job, so it is left alone and the person is told.
  quit_status=0
  as_user timeout "$quit_timeout" "$cli" app quit --yes --json >/dev/null 2>&1 || quit_status=$?
  case $quit_status in
    0) wait_until 30 unit_stopped || { restart_stuck; return 0; } ;;
    4) restart_pending; return 0 ;;
    *) restart_unanswered; return 0 ;;
  esac
  as_user "$runtime_node" "$app_lib/v1/resident.mjs" --enable || { restart_failed; return 0; }
  user_systemctl start "$unit" || { restart_failed; return 0; }
  if wait_until 30 app_runs_new_version; then
    printf '%s\n' "Faravan app restarted on version $new_version."
  elif user_systemctl is-active --quiet "$unit"; then
    note_outcome restart_failed
    printf '%s\n' "Faravan $new_version is installed and the app was started again, but it has not reported that version (not verified)." \
      'Check with: faravan update status --json'
  else
    restart_failed
  fi
}

tray=${FARAVAN_POSTINST_TRAY:-/usr/lib/faravan/faravan-tray}
proc_root=${FARAVAN_POSTINST_PROC_ROOT:-/proc}
proc_start_time() { sed 's/.*) //' "$proc_root/$1/stat" 2>/dev/null | cut -d' ' -f20; }
# This user's tray processes, one "PID STARTTIME" per line. A process counts only if the kernel names it
# faravan-tray and it runs the installed binary (a replaced binary reads as "... (deleted)").
tray_list() {
  for proc in "$proc_root"/[0-9]*; do
    [ "$(cat "$proc/comm" 2>/dev/null)" = faravan-tray ] || continue
    [ "$(stat -c %u "$proc" 2>/dev/null)" = "$user_uid" ] || continue
    exe=$(readlink "$proc/exe" 2>/dev/null || true)
    case $exe in "$tray"|"$tray (deleted)") ;; *) continue ;; esac
    printf '%s %s\n' "${proc#"$proc_root"/}" "$(proc_start_time "${proc#"$proc_root"/}")"
  done
}
new_tray_running() { # any tray process that is not one of $old_trays
  for pid in $(tray_list | cut -d' ' -f1); do
    case " $old_trays " in *" $pid "*) ;; *) return 0 ;; esac
  done
  return 1
}
# Signal only the process that was inspected: same name and same start time, checked in the user's own shell
# right before the signal, so a recycled PID is not touched. A PID of another user cannot be signalled at all.
stop_tray() { # stop_tray PID STARTTIME
  as_user sh -c '
    [ "$(cat "$3/$1/comm" 2>/dev/null)" = faravan-tray ] || exit 1
    [ "$(sed "s/.*) //" "$3/$1/stat" 2>/dev/null | cut -d" " -f20)" = "$2" ] || exit 1
    kill "$1"' sh "$1" "$2" "$proc_root"
}

# The tray is a separate process and keeps running the replaced binary. It has no job to lose.
# Relaunch it with the desktop environment it already has, so it lands in the same session.
restart_tray() {
  # The old tray's PATH is a desktop session PATH. Find the launcher here, once.
  setsid_bin=$(command -v setsid 2>/dev/null || true)
  [ -n "$setsid_bin" ] || return 0
  originals=$(tray_list)
  [ -n "$originals" ] || return 0
  old_trays=$(printf '%s\n' "$originals" | cut -d' ' -f1 | tr '\n' ' ')
  all_replaced=yes
  for pid in $old_trays; do
    start=$(printf '%s\n' "$originals" | while read -r p t; do [ "$p" = "$pid" ] && echo "$t"; done)
    session_env=$(tr '\0' '\n' <"$proc_root/$pid/environ" 2>/dev/null | grep -E \
      '^(PATH|HOME|USER|LOGNAME|LANG|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE)=' || true)
    if [ -z "$session_env" ] || ! stop_tray "$pid" "$start" 2>/dev/null || ! wait_until 5 test ! -e "$proc_root/$pid"; then
      all_replaced=no
      continue
    fi
    old_ifs=$IFS; IFS='
'
    set -f; set -- $session_env; set +f
    IFS=$old_ifs
    # Keep the desktop/session values, but never search its PATH for systemctl.
    # systemd services inherit the manager environment, not this client's environment.
    as_user env -i XDG_RUNTIME_DIR="$runtime_dir" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_dir/bus" \
      "$@" PATH=/usr/sbin:/usr/bin:/sbin:/bin sh -c '
        systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP XDG_SESSION_TYPE &&
        exec systemctl --user start faravan-tray.service
      ' >/dev/null 2>&1 </dev/null || true
  done
  # "Restarted" needs every old tray gone and a new one running.
  if [ "$all_replaced" = yes ] && wait_until 5 new_tray_running; then
    printf '%s\n' 'Faravan tray restarted on the new version.'
  else
    note_outcome tray_restart_failed
    printf '%s\n' 'The Faravan tray could not be restarted completely: an old tray may still be running.' \
      'Log out and back in to finish.'
  fi
  return 0
}

start_user_app() {
  find_user_session || { note_outcome session_unknown; return 1; }
  user_systemctl daemon-reload || { note_outcome restart_failed; return 1; }
  # An upgrade from a preview install may leave the removed v0 daemon unit
  # enabled; prevent future startup without interrupting outstanding work.
  user_systemctl disable faravan-daemon.service >/dev/null 2>&1 || true

  if [ -z "$previous_version" ]; then
    user_systemctl enable --now "$unit" || { note_outcome restart_failed; return 1; }
    return 0
  fi

  # An upgrade keeps the person's choices: it never enables a disabled unit and never starts a
  # stopped app. A running app is the one thing that must change, because it still runs old code.
  if user_systemctl is-active --quiet "$unit"; then
    restart_app
  elif as_user timeout "$probe_timeout" "$cli" app info --json 2>/dev/null | grep -q '"running":true'; then
    note_outcome deferred
    printf '%s\n' "Faravan $new_version is installed, but an app you started yourself is still the previous version." \
      'Quit it and open Faravan again:' '  faravan app quit --yes && faravan'
  else
    printf '%s\n' "Faravan updated to $new_version. The app is not running, as you left it. Run: faravan"
  fi
  restart_tray
  return 0
}

# The one install.run record of this run, written as the user it was installed for. Root with no user to record for
# writes nothing: it never creates a file in root's home. The record never fails the install.
record_install_run() { # record_install_run OUTCOME
  if [ "$(id -u)" -eq 0 ] && { [ -z "$user_name" ] || [ "$user_name" = root ]; }; then return 0; fi
  now=$(date +%s%N 2>/dev/null || echo 0); duration=0
  if [ "$install_started" -gt 0 ] 2>/dev/null && [ "$now" -gt 0 ] 2>/dev/null; then duration=$(( (now - install_started) / 1000000 )); fi
  as_user "$runtime_node" --input-type=module -e "$install_record" "$app_lib" deb "$1" "$duration" >/dev/null 2>&1 || true
  return 0
}

if start_user_app; then
  [ -n "$previous_version" ] || printf '%s\n' 'Faravan app started for your user. Open Faravan from the applications menu.'
elif [ -n "$previous_version" ]; then
  # Missing systemd/user sessions (including containers) must not fail dpkg.
  printf '%s\n' "Faravan updated to $new_version. Automatic restart was unavailable." \
    'If the app is running, it is still the previous version. Finish any running work before quitting Faravan.' \
    'Then open Faravan from your applications menu.'
else
  printf '%s\n' 'Faravan installed. Open Faravan from your applications menu.' \
    'Automatic user-service startup was unavailable or failed.' \
    'If the menu has not refreshed, log out and back in, then open Faravan.' \
    'Lender setup is separate from borrowing.'
fi
record_install_run "$install_outcome"
