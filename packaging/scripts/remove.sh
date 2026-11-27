#!/bin/sh
set -eu

# nFPM installs this same safe, self-contained script as prerm and postrm.
# DPKG_MAINTSCRIPT_NAME tells the two calls apart after package files vanish.
maintscript=${DPKG_MAINTSCRIPT_NAME:-}
action=${1:-}
if [ "${DPKG_MAINTSCRIPT_PACKAGE:-faravan}" = faravan-test ]; then
  purge_state_dir=${FARAVAN_REMOVAL_TEST_STATE_DIR:?}
else
  purge_state_dir=/var/lib/faravan-removal
fi
purge_prepared_file=$purge_state_dir/purge-prepared
USER_CONTEXT_DIR=""
DRAINED_USERS=""
case "$action" in
  remove|purge) ;;
  *) exit 0 ;;
esac
case "$maintscript" in
  prerm|postrm) ;;
  *) printf '%s\n' "Faravan removal hook could not identify its dpkg phase; leaving user processes alone." >&2; exit 1 ;;
esac
if [ "$maintscript" = prerm ]; then
  rm -f -- "$purge_prepared_file"
  rmdir "$purge_state_dir" 2>/dev/null || true
fi

purge_requested=no
if [ "$action" = purge ]; then
  purge_requested=yes
elif [ "$maintscript" = prerm ] && command -v dpkg-query >/dev/null 2>&1; then
  package_status=$(dpkg-query -W -f='${db:Status-Abbrev}' faravan 2>/dev/null || true)
  case "$package_status" in p*) purge_requested=yes ;; esac
elif [ "$maintscript" = postrm ] && [ -f "$purge_prepared_file" ]; then
  purge_requested=yes
fi

if [ "$purge_requested" = yes ]; then
  if [ "$maintscript" = prerm ]; then
    printf '%s\n' 'Faravan purge requested: hosted circles will be closed through their owner lifecycle before reachable FARAVAN_HOME data is deleted.'
  elif [ "$action" = purge ]; then
    if [ -f "$purge_prepared_file" ]; then
      printf '%s\n' 'Faravan purge preparation ran before package files were removed. Any FARAVAN_HOME paths reported as kept remain on disk.'
    else
      printf '%s\n' 'Faravan purge preparation did not run before package files were removed. FARAVAN_HOME data was kept; reinstall Faravan and purge directly.' >&2
    fi
  else
    printf '%s\n' 'Faravan purge is in progress; owner lifecycle and reachable data cleanup ran before package files were removed.'
  fi
else
  printf '%s\n' 'Package removal is not a data purge: member keys, the ledger, and FARAVAN_HOME data are kept.'
fi

warn() { printf '%s\n' "Faravan removal: $*" >&2; }

cleanup_user_context() {
  cleanup_status=$?
  trap - EXIT
  [ -z "$USER_CONTEXT_DIR" ] || rm -rf -- "$USER_CONTEXT_DIR" || true
  if [ "$maintscript" = prerm ] && [ "$cleanup_status" -ne 0 ] && [ "$purge_requested" = yes ]; then
    rm -f -- "$purge_prepared_file" || true
  fi
  if [ "$maintscript" = prerm ] && [ "$cleanup_status" -ne 0 ] && [ -n "$DRAINED_USERS" ]; then
    warn "removal was canceled after these apps accepted clean shutdown: $DRAINED_USERS. Run 'faravan' to start them again"
  fi
  if [ "${DPKG_MAINTSCRIPT_PACKAGE:-faravan}" = faravan-test ]; then
    rmdir "$purge_state_dir" 2>/dev/null || true
  fi
  exit "$cleanup_status"
}
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup_user_context EXIT

make_user_context_dir() {
  if [ "${DPKG_MAINTSCRIPT_PACKAGE:-faravan}" = faravan-test ]; then
    mkdir -p "$purge_state_dir" || return 1
    USER_CONTEXT_DIR=$(mktemp -d "$purge_state_dir/context.XXXXXX")
  else
    USER_CONTEXT_DIR=$(mktemp -d /run/faravan-removal.XXXXXX)
  fi
}

save_user_context() {
  printf '%s\n%s\n' "$user_faravan_home" "${user_owner_home:-}" > "$USER_CONTEXT_DIR/$user_uid"
}

load_user_context() {
  user_name=$1
  user_account "$user_name" || return 1
  user_faravan_home=$user_home/.local/share/Faravan
  user_owner_home=
  context_file=$USER_CONTEXT_DIR/$user_uid
  if [ -f "$context_file" ]; then
    user_faravan_home=$(sed -n '1p' "$context_file")
    [ -n "$user_faravan_home" ] || user_faravan_home=$user_home/.local/share/Faravan
    user_owner_home=$(sed -n '2p' "$context_file")
  fi
}

# Sessions of a person's user class, one "<uid> <user>" line each. With $1 = yes, only the session on the foreground seat.
# Fails closed: a session whose class or Active state loginctl cannot report stops the listing.
user_sessions() {
  command -v loginctl >/dev/null 2>&1 || return 1
  session_list=$(loginctl list-sessions --no-legend 2>/dev/null) || return 1
  session_rows=$(
    while read -r session_id session_uid session_user _; do
      [ -n "$session_id" ] && [ -n "$session_uid" ] && [ -n "$session_user" ] || continue
      session_properties=$(loginctl show-session "$session_id" --property=Class --property=Active 2>/dev/null) || exit 1
      session_class=$(printf '%s\n' "$session_properties" | sed -n 's/^Class=//p')
      session_active=$(printf '%s\n' "$session_properties" | sed -n 's/^Active=//p')
      [ -n "$session_class" ] && [ -n "$session_active" ] || exit 1
      case "$session_class" in user|user-early|manager) ;; *) continue ;; esac
      if [ "$1" != yes ] || [ "$session_active" = yes ]; then printf '%s %s\n' "$session_uid" "$session_user"; fi
    done <<EOF
$session_list
EOF
  ) || return 1
  printf '%s\n' "$session_rows"
}

# Accounts of people (UID 1000 and up) whose app or services could be running, one name per line. Any user with a
# session of a user class counts, in any state: a switched-away or closing session still runs its app. So does a user
# whose manager runs without a session (lingering). Greeter and service accounts are not people, so they are skipped.
candidate_users() {
  sessions=$(user_sessions any) || return 1
  managers=$(loginctl list-users --no-legend 2>/dev/null) || return 1
  printf '%s\n%s\n' "$sessions" "$managers" | awk 'NF >= 2 && $1 ~ /^[0-9]+$/ && $1 >= 1000 { print $2 }' | sort -u
}

# Users with a session on the foreground seat. Only these get their data purged; the others are drained and their data kept.
active_users() {
  sessions=$(user_sessions yes) || return 1
  printf '%s\n' "$sessions" | awk 'NF >= 2 && $1 ~ /^[0-9]+$/ && $1 >= 1000 { print $2 }' | sort -u
}

user_account() {
  account_record=$(getent passwd "$1") || return 1
  user_uid=$(printf '%s\n' "$account_record" | awk -F: 'NR == 1 { print $3 }')
  user_home=$(printf '%s\n' "$account_record" | awk -F: 'NR == 1 { print $6 }')
  [ -n "$user_uid" ] && [ -n "$user_home" ]
}

as_user() {
  runuser -u "$user_name" -- env HOME="$user_home" FARAVAN_HOME="$user_faravan_home" FARAVAN_NO_AUTOSTART=1 "$@"
}

app_running() {
  app_info=$(runuser -u "$user_name" -- env -u FARAVAN_HOME -u FARAVAN_HOME HOME="$user_home" FARAVAN_NO_AUTOSTART=1 /usr/bin/faravan app info --json 2>/dev/null) || return 2
  reported_home=$(printf '%s\n' "$app_info" | sed -n 's/.*"home":"\([^"]*\)".*/\1/p')
  user_faravan_home=${reported_home:-$user_home/.local/share/Faravan}
  case "$app_info" in
    *'"running":true'*) [ -z "$reported_home" ] || user_owner_home=$reported_home; return 0 ;;
    *'"running":false'*) return 1 ;;
    *) return 2 ;;
  esac
}

wait_for_app_exit() {
  attempts=0
  while [ "$attempts" -lt 50 ]; do
    if app_running; then
      sleep 0.1
      attempts=$((attempts + 1))
      continue
    else
      app_status=$?
      [ "$app_status" -eq 1 ] && return 0
      return 1
    fi
  done
  return 1
}

tray_processes() {
  tray_bin=/usr/lib/faravan/faravan-tray
  for proc in /proc/[0-9]*; do
    [ "$(cat "$proc/comm" 2>/dev/null || true)" = faravan-tray ] || continue
    [ "$(stat -c %u "$proc" 2>/dev/null || true)" = "$user_uid" ] || continue
    exe=$(readlink "$proc/exe" 2>/dev/null || true)
    case "$exe" in "$tray_bin"|"$tray_bin (deleted)") ;; *) continue ;; esac
    start_time=$(sed 's/.*) //' "$proc/stat" 2>/dev/null | cut -d' ' -f20)
    [ -n "$start_time" ] && printf '%s %s\n' "${proc#/proc/}" "$start_time"
  done
}

stop_tray_process() {
  tray_pid=$1
  tray_start=$2
  runuser -u "$user_name" -- sh -c '
    [ "$(cat "/proc/$1/comm" 2>/dev/null)" = faravan-tray ] || exit 1
    [ "$(stat -c %u "/proc/$1" 2>/dev/null)" = "$3" ] || exit 1
    [ "$(sed "s/.*) //" "/proc/$1/stat" 2>/dev/null | cut -d" " -f20)" = "$2" ] || exit 1
    exe=$(readlink "/proc/$1/exe" 2>/dev/null) || exit 1
    case "$exe" in /usr/lib/faravan/faravan-tray|"/usr/lib/faravan/faravan-tray (deleted)") ;; *) exit 1 ;; esac
    kill -TERM "$1"
  ' sh "$tray_pid" "$tray_start" "$user_uid"
}

wait_for_tray_exit() {
  tray_pid=$1
  tray_start=$2
  seconds=5
  while [ "$(cat "/proc/$tray_pid/comm" 2>/dev/null || true)" = faravan-tray ] &&
    [ "$(sed 's/.*) //' "/proc/$tray_pid/stat" 2>/dev/null | cut -d' ' -f20)" = "$tray_start" ]; do
    [ "$seconds" -gt 0 ] || return 1
    sleep 1
    seconds=$((seconds - 1))
  done
}

stop_user_tray() {
  tray_list=$(tray_processes)
  [ -n "$tray_list" ] || return 0
  command -v runuser >/dev/null 2>&1 || return 1
  old_ifs=$IFS
  IFS='
'
  for process in $tray_list; do
    IFS=$old_ifs
    set -- $process
    if ! stop_tray_process "$1" "$2"; then
      IFS=$old_ifs
      return 1
    fi
    if ! wait_for_tray_exit "$1" "$2"; then
      IFS=$old_ifs
      return 1
    fi
    IFS='
'
  done
  IFS=$old_ifs
}

# The sandbox service runs as its own unit so that it outlives app restarts, so stopping the app's units does not stop it.
# One install can reach more than one sbx HOME. Description finds candidates; the saved installation owner is checked
# immediately before each stop. A channel description alone never authorizes a stop.
# The package is the stable channel unless its channel.json names another.
sbx_daemon_description() {
  channel_id=faravan
  if [ -f /usr/lib/faravan/channel.json ]; then
    named=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]*\)".*/\1/p' /usr/lib/faravan/channel.json | head -n 1)
    [ -n "$named" ] && channel_id=$named
  fi
  printf 'Faravan sandbox service (%s)\n' "$channel_id"
}

# This user's sandbox services of this channel, one per line. Fails when the list cannot be read.
sbx_daemon_units() {
  listed=$(systemctl --user -M "${user_name}@" list-units --all --plain --no-legend --type=service 'faravan-sbxd-*') || return 1
  description=$(sbx_daemon_description)
  units=$(printf '%s\n' "$listed" | awk '{ print $1 }' | grep -E '^faravan-sbxd-[0-9a-f]{12}(-[0-9a-f]{64})?[.]service$' || true)
  for unit in $units; do
    shown=$(systemctl --user -M "${user_name}@" show -p Description --value "$unit") || return 1
    if [ "$shown" = "$description" ]; then printf '%s\n' "$unit"; fi
  done
}

stop_sbx_daemon_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  units=$(sbx_daemon_units) || return 1
  stop_failed=no
  for unit in $units; do
    identity=$(systemctl --user -M "${user_name}@" show -p LoadState -p ActiveState -p MainPID -p Description -p ExecStart -p Environment "$unit") || identity=
    # Only a running app's reported home overrides the runtime data-home resolver.
    if ! printf '%s\n' "$identity" | runuser -u "$user_name" -- env -u FARAVAN_HOME -u FARAVAN_HOME HOME="$user_home" /usr/lib/faravan/runtime/bin/node /usr/lib/faravan/lib/sbx-daemon-unit-check.mjs "$unit" "${user_owner_home:-}"; then
      warn "sandbox service $unit was left alone: installation ownership could not be verified"
      stop_failed=yes
      continue
    fi
    systemctl --user -M "${user_name}@" stop "$unit" >/dev/null 2>&1 || stop_failed=yes
  done
  [ "$stop_failed" = no ]
}

# Succeeds only when no Faravan unit of this user is active. 3 (inactive) and 4 (not installed) are fine; any other
# answer, including a user manager that cannot be reached, leaves the state unknown.
user_units_inactive() {
  command -v systemctl >/dev/null 2>&1 || return 0
  sbx_units=$(sbx_daemon_units) || return 1
  active_found=no
  for unit in faravan-app.service faravan-coordinator.service faravan-tray.service $sbx_units; do
    status=0
    state=$(systemctl --user -M "${user_name}@" is-active "$unit") || status=$?
    case $status:$state in
      0:active) active_found=yes ;;
      3:inactive|3:failed|4:*) ;;
      *) active_found=yes ;;
    esac
  done
  [ "$active_found" = no ]
}

stop_user_services() {
  manager_available=yes
  if [ "$maintscript" = prerm ]; then
    if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user -M "${user_name}@" disable --now faravan-app.service faravan-coordinator.service faravan-tray.service; then
      manager_available=no
    fi
    # Stop and read back every owned sandbox unit even when the combined app-unit disable fails.
    sbx_stop_ok=yes
    stop_sbx_daemon_units || sbx_stop_ok=no
    units_inactive=yes
    user_units_inactive || units_inactive=no
    if [ "$sbx_stop_ok" = no ] || [ "$units_inactive" = no ]; then
      warn "$user_name's Faravan services could not be proven stopped; removal is canceled before package files are removed"
      return 1
    fi
    if [ "$manager_available" = no ]; then
      warn "$user_name's user service manager is unavailable; using the verified host shutdown path after the app API drained work"
    fi
  else
    if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user -M "${user_name}@" stop faravan-app.service faravan-coordinator.service faravan-tray.service; then
      warn "could not reach $user_name's user service manager after file removal; its units may need a manual stop"
    else
      stop_sbx_daemon_units
    fi
  fi
  if [ "$maintscript" = prerm ] && [ "$manager_available" = no ]; then
    if ! runuser -u "$user_name" -- env HOME="$user_home" FARAVAN_HOME="$user_faravan_home" \
      FARAVAN_NO_AUTOSTART=1 FARAVAN_PACKAGE_REMOVAL_FALLBACK=1 \
      /usr/bin/faravan host --stop --json >/dev/null 2>&1; then
      warn "$user_name's coordinator could not be stopped safely; removal is canceled before package files are removed"
      return 1
    fi
    if ! user_units_inactive; then
      warn "$user_name's Faravan services are still active after host shutdown; removal is canceled before package files are removed"
      return 1
    fi
  fi
  if ! stop_user_tray; then
    if [ "$maintscript" = prerm ]; then
      warn "could not safely stop $user_name's packaged tray; removal is canceled"
      return 1
    fi
    warn "could not safely stop $user_name's packaged tray after file removal"
  fi
  if [ "$maintscript" = postrm ] && ! systemctl --user -M "${user_name}@" daemon-reload; then
    warn "could not reload $user_name's user service manager"
  fi
}

disable_user_activation() {
  if ! runuser -u "$user_name" -- rm -f -- "$user_home/.config/autostart/faravan-tray.desktop"; then
    warn "could not remove $user_name's tray autostart entry"
    return 1
  fi
  units_dir=$user_home/.config/systemd/user
  if [ -d "$units_dir" ] && ! runuser -u "$user_name" -- find "$units_dir" -type l \
    \( -name faravan-app.service -o -name faravan-coordinator.service -o -name faravan-tray.service \) -exec rm -f -- {} +; then
    warn "could not remove $user_name's user-unit activation links"
    return 1
  fi
}

prepare_purge_circles() {
  if ! as_user /usr/bin/faravan uninstall --yes --delete-hosted-circles --package-prepare-only --json >/dev/null 2>&1; then
    warn "$user_name's circle lifecycle could not be completed; purge is canceled before deleting user data. To remove Faravan and keep data, run apt remove; reinstall and purge when the owner API is reachable."
    return 1
  fi
}

validate_user_data_for_purge() {
  data_home=$user_faravan_home
  if [ -z "$data_home" ] || [ "$data_home" = / ] || [ "$data_home" = "$user_home" ] || [ -L "$data_home" ]; then
    warn "$user_name's FARAVAN_HOME is unsafe to purge; data was kept at ${data_home:-unknown}"
    return 1
  fi
  if [ ! -d "$data_home/v1" ] && [ ! -d "$data_home/coordinator" ] && [ ! -d "$data_home/device" ]; then
    printf '%s\n' "No known Faravan data was found for $user_name; nothing was purged."
  fi
}

purge_user_data() {
  data_home=$user_faravan_home
  if [ ! -d "$data_home/v1" ] && [ ! -d "$data_home/coordinator" ] && [ ! -d "$data_home/device" ]; then
    return 0
  fi
  if runuser -u "$user_name" -- rm -rf -- "$data_home"; then
    printf '%s\n' "Purged $user_name's FARAVAN_HOME data at $data_home."
  else
    warn "$user_name's FARAVAN_HOME data could not be purged at $data_home"
    return 1
  fi
}

stop_for_removal() {
  if ! command -v loginctl >/dev/null 2>&1; then
    if [ "$maintscript" = prerm ]; then
      warn 'loginctl is unavailable; removal is canceled because active user sessions cannot be checked'
      return 1
    fi
    warn 'loginctl is unavailable after file removal; active user services may need a manual stop'
    return 0
  fi
  if ! users=$(candidate_users); then
    if [ "$maintscript" = prerm ]; then
      warn 'active sessions could not be listed; removal is canceled before stopping any user process'
      return 1
    fi
    warn 'active sessions could not be listed after file removal; active user services may need a manual stop'
    return 0
  fi
  if [ -z "$users" ]; then
    printf '%s\n' 'No active user sessions were found; no user services were running in those sessions.'
    if [ "$purge_requested" = yes ]; then
      if [ "$maintscript" = prerm ]; then
        printf '%s\n' 'FARAVAN_HOME data was kept; purge is canceled and the package remains installed.'
        warn 'log in to an active user session, then retry apt purge so hosted circles can close through their owner lifecycle'
        return 1
      fi
      warn 'no active user API was available after package files were removed; FARAVAN_HOME data was kept. Reinstall Faravan, log in, complete the owner lifecycle, then purge again'
    fi
    return 0
  fi
  # Purge deletes data only where a user has an active session. Checked before any app is asked to quit, so a cancel touches nothing.
  purge_users=
  if [ "$purge_requested" = yes ]; then
    if ! purge_users=$(active_users); then
      if [ "$maintscript" = prerm ]; then
        warn 'active sessions could not be listed; purge is canceled before stopping any user process'
        return 1
      fi
      warn 'active sessions could not be listed after file removal; FARAVAN_HOME data was kept'
      return 0
    fi
    if [ -z "$purge_users" ]; then
      if [ "$maintscript" = prerm ]; then
        printf '%s\n' 'FARAVAN_HOME data was kept; purge is canceled and the package remains installed.'
        warn 'log in to an active user session, then retry apt purge so hosted circles can close through their owner lifecycle'
        return 1
      fi
      warn 'no active user API was available after package files were removed; FARAVAN_HOME data was kept. Reinstall Faravan, log in, complete the owner lifecycle, then purge again'
      return 0
    fi
    printf '%s\n' 'Only profiles with an active user session have their data purged. Other profiles are drained, and their data is kept.'
  fi
  command -v getent >/dev/null 2>&1 || {
    warn 'getent is unavailable; removal is canceled before any user process is stopped'
    return 1
  }
  command -v systemctl >/dev/null 2>&1 || {
    warn 'systemctl is unavailable; removal is canceled before any user process is stopped'
    return 1
  }

  if ! make_user_context_dir; then
    warn 'could not create a private user-state directory; removal is canceled before stopping any user process'
    return 1
  fi

  # Ask every active app to quit through its local API before stopping any unit. Quit atomically
  # fences new claims, refuses unfinished work, and uses the normal cessation path. Do not change
  # saved lending intent: another user's refusal must not leave an earlier profile switched off.
  for user_name in $users; do
    if ! user_account "$user_name"; then
      warn "could not resolve active user $user_name; removal is canceled before stopping processes"
      return 1
    fi
    user_faravan_home=$user_home/.local/share/Faravan
    user_owner_home=

    if [ "$maintscript" = prerm ]; then
      if ! command -v runuser >/dev/null 2>&1; then
        warn "runuser is unavailable; removal is canceled before stopping $user_name's processes"
        return 1
      fi
      if app_running; then
        if ! as_user /usr/bin/faravan app quit --yes --json >/dev/null 2>&1; then
          warn "$user_name's app could not confirm that active work had finished; removal is canceled and nothing was force-stopped"
          return 1
        fi
        if ! wait_for_app_exit; then
          warn "$user_name's app did not finish its normal shutdown; removal is canceled without stopping its process"
          return 1
        fi
        DRAINED_USERS="${DRAINED_USERS:+$DRAINED_USERS }$user_name"
      else
        app_status=$?
        if [ "$app_status" -eq 2 ]; then
          warn "could not check $user_name's app over its local API; removal is canceled and no process was stopped"
          return 1
        fi
      fi
      save_user_context || { warn "could not save $user_name's FARAVAN_HOME path; removal is canceled"; return 1; }
    fi
  done

  if [ "$maintscript" = prerm ] && [ "$purge_requested" = yes ]; then
    # Validate every path before closing circles, so an unsafe later profile cannot leave an
    # earlier profile's circle closed when the purge is canceled.
    for user_name in $purge_users; do
      if ! load_user_context "$user_name"; then
        warn "could not restore $user_name's user context; purge is canceled before deleting data"
        return 1
      fi
      if ! validate_user_data_for_purge; then return 1; fi
    done

    # Close hosted circles while each user's coordinator is still available. All active apps
    # accepted normal shutdown above, so no lent work is killed or bypasses its cessation path.
    for user_name in $purge_users; do
      if ! load_user_context "$user_name"; then
        warn "could not restore $user_name's user context; purge is canceled before deleting data"
        return 1
      fi
      if ! prepare_purge_circles; then return 1; fi
    done
  fi

  # Stop and disable every user's packaged activation only after every active app accepted
  # shutdown and, for purge, every owner lifecycle completed.
  for user_name in $users; do
    if ! load_user_context "$user_name"; then
      warn "could not restore $user_name's user context; removal is canceled"
      return 1
    fi
    if ! stop_user_services; then return 1; fi
    disable_user_activation
  done

  if [ "$maintscript" = prerm ] && [ "$purge_requested" = yes ]; then

    # Record successful preparation before deleting data. If marker storage fails, preserve data.
    if ! mkdir -p "$purge_state_dir" || ! (umask 077; printf 'prepared\n' > "$purge_prepared_file"); then
      warn 'could not record purge preparation; user data was kept'
      return 1
    fi
    for user_name in $users; do
      case " $(printf '%s' "$purge_users" | tr '\n' ' ') " in
        *" $user_name "*) ;;
        *) printf '%s\n' "Kept $user_name's FARAVAN_HOME data: $user_name has no active session, so purge does not delete it." ;;
      esac
    done
    for user_name in $purge_users; do
      if ! load_user_context "$user_name"; then
        warn "could not restore $user_name's user context; purge data was not removed"
        return 1
      fi
      if ! purge_user_data; then return 1; fi
    done
  fi
}

if [ "$maintscript" = prerm ]; then
  stop_for_removal
elif [ "$action" = purge ]; then
  # The pre-remove phase made lifecycle changes while the program was still available.
  stop_for_removal || true
  rm -f -- "$purge_prepared_file"
  rmdir "$purge_state_dir" 2>/dev/null || true
else
  # postrm runs after dpkg has deleted package files. It repeats the stop as a
  # best effort. It never deletes user data; the prerm purge path did that only
  # after circle lifecycle and service shutdown completed.
  stop_for_removal || true
fi
