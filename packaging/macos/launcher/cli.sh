#!/bin/sh
set -eu

# Homebrew links this file into its bin directory. Follow that link to find the app's private runtime.
self=$0; hops=0
while [ -L "$self" ]; do
  hops=$((hops + 1)); [ "$hops" -le 40 ] || { echo "faravan: too many symlinks at $0" >&2; exit 1; }
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
here=$(cd "$(dirname "$self")" && pwd -P)
root="$here/../Resources/faravan"

# Finder does not inherit the terminal PATH; include both standard Homebrew prefixes.
PATH="/opt/homebrew/bin:/usr/local/bin${PATH:+:$PATH}"
export PATH
: "${FARAVAN_NOTIFY_HELPER:=$here/../Helpers/FaravanNotify.app/Contents/MacOS/faravan-notify}"
export FARAVAN_NOTIFY_HELPER
exec "$root/runtime/bin/node" "$root/bin/faravan" "$@"
