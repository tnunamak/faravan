#!/bin/sh
# Runs once, as root, while the sandbox is created. The kit copies this folder into the sandbox home first,
# so nothing here reaches the network: it checks the payload against its pin, unpacks it and links `pi`.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
(cd "$dir" && sha256sum -c pi-payload.sha256)
mkdir -p /opt/faravan-pi
tar -xzf "$dir/pi-payload.tgz" -C /opt/faravan-pi
ln -sf /opt/faravan-pi/node_modules/.bin/pi /usr/local/bin/pi
rm -f "$dir/pi-payload.tgz"
