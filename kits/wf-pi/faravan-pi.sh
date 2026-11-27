#!/bin/sh
# Guest launcher for pi. The host run spec passes the endpoint and model list as text in
# FARAVAN_PI_MODELS and the per-job broker key in the variable that text names. pi has no
# base-URL variable, so this writes the models file into a private, throwaway agent directory.
# No network is used at startup; the only endpoint is the guest loopback tunnel to the host broker.
set -eu
[ -n "${FARAVAN_PI_MODELS:-}" ] || { echo "FARAVAN_PI_MODELS is not set" >&2; exit 64; }
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
umask 077
printf '%s' "$FARAVAN_PI_MODELS" > "$dir/models.json"
PI_CODING_AGENT_DIR=$dir PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi "$@"
