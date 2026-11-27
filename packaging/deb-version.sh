#!/usr/bin/env bash
# The one place that turns the release version into a Debian version. Source it, or run it with a
# version to print the full Debian version.
#
# A release is "0.1.0" and a preview is "0.1.0-preview.YYYYMMDD.N". Debian reads a hyphen as the
# start of the packaging revision and sorts "-preview" ABOVE the plain release, so a preview user
# would never be offered the stable build. A tilde sorts below everything, even the end of the
# string, so "0.1.0~preview.N" is older than "0.1.0" and still newer than "0.1.0~preview.N-1".
#
# DEB_EPOCH exists because preview 1 to 6 already shipped as "0.1.0-preview.YYYYMMDD.N-1".
# "0.1.0~preview.20261020.7" sorts below that, so without an epoch preview 7 would be a downgrade
# of preview 6 and apt would refuse it. An epoch is permanent: never lower it, and never drop it.
DEB_EPOCH=1
DEB_REVISION=1

# deb_upstream_version 0.1.0-preview.20261020.7 -> 0.1.0~preview.20261020.7
deb_upstream_version() {
  local core="${1%%-*}" rest=""
  [[ "$1" == *-* ]] && rest="~${1#*-}"
  printf '%s%s' "$core" "$rest"
}

# deb_full_version 0.1.0-preview.20261020.7 -> 1:0.1.0~preview.20261020.7-1
deb_full_version() { printf '%s:%s-%s' "$DEB_EPOCH" "$(deb_upstream_version "$1")" "$DEB_REVISION"; }

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ $# -eq 1 ]] || { echo "usage: deb-version.sh VERSION" >&2; exit 2; }
  deb_full_version "$1"; echo
fi
