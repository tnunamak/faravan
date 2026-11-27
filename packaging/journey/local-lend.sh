#!/usr/bin/env bash
set -Eeuo pipefail
export FARAVAN_NO_BROWSER=1 FARAVAN_NO_BROWSER=1 DISPLAY= WAYLAND_DISPLAY=
export FARAVAN_NO_AUTOSTART=1 FARAVAN_NO_AUTOSTART=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${1:?usage: local-lend.sh SOURCE --synthetic|--preflight|--live}"
MODE="${2:?usage: local-lend.sh SOURCE --synthetic|--preflight|--live}"
exec node "$HERE/local-lend.mjs" "$SOURCE" "$MODE"
