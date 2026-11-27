#!/bin/sh
set -eu
# dpkg has no previous-version argument when faravan first replaces faravan.
# The payload VERSION is not evidence: it may already belong to the new package.
action=${1:-}
case "$action" in install|upgrade) ;; *) exit 0 ;; esac
state=/var/lib/faravan
mkdir -p "$state"
if [ "${DPKG_MAINTSCRIPT_PACKAGE:-}" = faravan ]; then
  if [ "$action" = upgrade ] && [ -n "${2:-}" ]; then
    printf '%s\n' "$2" > "$state/previous-package-version"
  fi
elif [ "$action" = install ]; then
  legacy=$(dpkg-query -W -f='${Version}\n${Depends}\n${Status}\n' faravan 2>/dev/null || true)
  legacy_version=$(printf '%s\n' "$legacy" | sed -n '1p')
  legacy_depends=$(printf '%s\n' "$legacy" | sed -n '2p')
  legacy_status=$(printf '%s\n' "$legacy" | sed -n '3p')
  case "$legacy_depends" in
    *faravan*) ;; # Transition-first: its preinstall already recorded the old version.
    *)
      case "$legacy_status" in
        *' installed'|*' unpacked'|*' half-configured')
          printf '%s\n' "$legacy_version" > "$state/previous-package-version" ;;
        *) rm -f "$state/previous-package-version" ;;
      esac
      ;;
  esac
fi
