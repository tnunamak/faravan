#!/bin/sh
set -eu
# Depends requires faravan to be configured before the transitional package.
# Clear any record captured after faravan itself was already configured.
[ "${1:-}" != configure ] || rm -f /var/lib/faravan/previous-package-version
