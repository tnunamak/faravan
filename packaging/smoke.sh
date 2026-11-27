#!/usr/bin/env bash
# Build and exercise the .deb in plain Docker; Docker Sandboxes is not involved.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$package_dir/.." && pwd)"
package_version="${PACKAGE_VERSION:-0.1.0}"
deb_path="$package_dir/dist/faravan_${package_version}_amd64.deb"

command -v docker >/dev/null 2>&1 || { echo "missing required command: docker" >&2; exit 1; }

PACKAGE_VERSION="$package_version" "$package_dir/build.sh"
[[ -f "$deb_path" ]] || { echo "expected build artifact missing: $deb_path" >&2; exit 1; }

# shellcheck source=deb-version.sh
. "$package_dir/deb-version.sh"

# --log-driver none: a container's stdout is otherwise kept under /var/lib/docker.
docker run --rm --log-driver none \
  -v "$repo_root:/source:ro" \
  -v "$package_dir/dist:/artifacts:ro" \
  -e "DEB_NAME=$(basename "$deb_path")" \
  -e "EXPECT_DEB_VERSION=$(deb_full_version "$package_version")" \
  -e "EXPECT_APP_VERSION=$package_version" \
  ubuntu:24.04 \
  bash -e -u -o pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    # Every check goes through ok/fail so a check that cannot run is a failure, never a silent skip.
    checks=0
    fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }
    ok() { checks=$((checks + 1)); }
    trap "echo SMOKE FAILED at line \$LINENO: \$BASH_COMMAND >&2" ERR

    # No Node.js and no curl are installed: the package carries its own runtime (D6), and the checks
    # below use only that runtime and what the image has.
    for absent in node curl; do
      ! command -v "$absent" >/dev/null 2>&1 || fail "$absent is on PATH, so this container no longer proves the package is self-contained"
    done
    ok
    dpkg -i "/artifacts/$DEB_NAME"
    node=/usr/lib/faravan/runtime/bin/node
    test -x "$node" || fail "the package has no bundled runtime at $node"
    ok
    for tool in runuser useradd stat mktemp seq; do
      command -v "$tool" >/dev/null 2>&1 || fail "the test image lacks $tool, so the API checks cannot run"
    done

    # The Debian version must carry the epoch and the tilde, or it sorts wrong against stable.
    test "$(dpkg-query -W -f="\${Version}" faravan)" = "$EXPECT_DEB_VERSION" ||
      fail "package version is $(dpkg-query -W -f="\${Version}" faravan), expected $EXPECT_DEB_VERSION"
    ok

    export FARAVAN_NO_BROWSER=1
    faravan --help > /tmp/faravan-help.out 2>&1
    grep -Fi "usage: faravan" /tmp/faravan-help.out
    for verb in app circle job mcp host; do
      grep -E "^  $verb([[:space:]]|$)" /tmp/faravan-help.out
    done
    test -x /usr/bin/faravan
    test -x /usr/bin/faravan
    test -x /usr/lib/faravan/faravan-tray
    for asset in index.html app.mjs app.css; do
      test -s "/usr/lib/faravan/public/v1/$asset"
    done
    test -s /usr/lib/faravan/public/join/index.html
    test -s /usr/lib/faravan/profiles/faravan-docker.json
    for schema in job result receipt roster invite; do
      test -s "/usr/lib/faravan/docs/protocol/$schema.schema.json"
    done
    test -s /usr/lib/faravan/kits/wf-gh-cli/spec.yaml
    test -s /usr/lib/faravan/docs/security/credential-proxy-evidence.json
    test -f /usr/lib/systemd/user/faravan-app.service
    grep -Fx "ExecStart=/usr/bin/faravan app" /usr/lib/systemd/user/faravan-app.service
    grep -Fx 'UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS' /usr/lib/systemd/user/faravan-app.service
    grep -Fx 'UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS' /usr/lib/systemd/user/faravan-coordinator.service
    ! grep -q '^UnsetEnvironment=.*DBUS_SESSION_BUS_ADDRESS' /usr/lib/systemd/user/faravan-tray.service
    grep -Fx "Environment=FARAVAN_NO_BROWSER=1" /usr/lib/systemd/user/faravan-app.service
    test ! -e /usr/lib/systemd/user/faravan-daemon.service
    test -f /usr/lib/systemd/user/faravan-coordinator.service
    test -f /etc/xdg/autostart/faravan-tray.desktop
    test -x /usr/lib/faravan/bin/faravan-tray-start
    grep -Fx 'Exec=/usr/lib/faravan/bin/faravan-tray-start' /etc/xdg/autostart/faravan-tray.desktop
    grep -Fx "Exec=faravan open-link %u" /usr/share/applications/faravan-open-link.desktop
    grep -Fx "MimeType=x-scheme-handler/faravan;x-scheme-handler/faravan;" /usr/share/applications/faravan-open-link.desktop
    grep -Fx "Exec=faravan" /usr/share/applications/faravan.desktop
    test -f /usr/share/icons/hicolor/512x512/apps/faravan.png
    grep -F "user_systemctl enable --now \"\$unit\"" /var/lib/dpkg/info/faravan.postinst
    grep -F "disable faravan-daemon.service" /var/lib/dpkg/info/faravan.postinst
    ok

    # A root/container install must not enable the unit globally or start an
    # app as root.
    test ! -e /etc/systemd/user/default.target.wants/faravan-app.service
    test ! -L /etc/systemd/user/default.target.wants/faravan-app.service
    test ! -e /root/.config/systemd/user/default.target.wants/faravan-app.service
    test ! -L /root/.config/systemd/user/default.target.wants/faravan-app.service
    ok

    # Exercise the installed v1 app as an ordinary user with a private home:
    # authenticated discovery and API, no sign-in, lending or provider work.
    useradd --create-home smoke
    home=$(mktemp -d)
    chown smoke "$home"
    runuser -u smoke -- env FARAVAN_HOME="$home" FARAVAN_NO_BROWSER=1 \
      faravan app >/tmp/faravan-app.out 2>&1 &
    app_pid=$!
    for _ in $(seq 1 100); do [ -s "$home/v1/app.json" ] && break; sleep 0.1; done
    test -s "$home/v1/app.json" || { cat /tmp/faravan-app.out; fail "the app did not write its discovery file"; }
    test "$(stat -c %a "$home/v1/app.json")" = 600
    ok

    # The bundled runtime parses the discovery file and makes the requests; curl is not installed.
    cat >/tmp/api-check.mjs <<"JS"
import { readFileSync } from "node:fs";
const [home, expectVersion] = process.argv.slice(2);
const { port, token } = JSON.parse(readFileSync(home + "/v1/app.json", "utf8"));
const get = (path, headers) => fetch("http://127.0.0.1:" + port + path, { headers, redirect: "error" });
const authed = { "X-Faravan-Session-Token": token };
const fail = message => { console.error("API check failed: " + message); process.exit(1); };
const anonymous = await get("/api/status");
if (anonymous.status !== 401) fail("/api/status without the session token answered " + anonymous.status + ", not 401");
const status = await get("/api/status", authed);
if (!status.ok) fail("/api/status with the session token answered " + status.status);
if (!(await status.json()).iconState) fail("/api/status has no iconState");
const updates = await get("/api/updates", authed);
if (!updates.ok) fail("/api/updates answered " + updates.status);
const { currentVersion } = await updates.json();
if (currentVersion !== expectVersion) fail("the app reports version " + currentVersion + ", expected " + expectVersion);
console.log("api checks passed: 401 without token, status ok, version " + currentVersion);
JS
    "$node" /tmp/api-check.mjs "$home" "$EXPECT_APP_VERSION"
    ok

    # Quit through the same API the tray uses; the app has no job, so it must agree and exit.
    runuser -u smoke -- env FARAVAN_HOME="$home" faravan app quit --yes --json | grep -F "\"shuttingDown\":true"
    wait "$app_pid"
    test ! -e "$home/v1/app.json" || fail "the app left its discovery file behind after quitting"
    ok
    echo "smoke: $checks check groups passed"
    test "$checks" -ge 7 || fail "only $checks check groups ran"
  '

echo "package smoke passed: $deb_path"
