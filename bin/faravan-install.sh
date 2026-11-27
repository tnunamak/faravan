#!/bin/sh
# Install Faravan on Linux. Nothing else needs to be installed first: it ships its own Node.js runtime. It first checks
# that this computer can run Faravan, and says why not, before anything is downloaded. Every download is checked against
# its release's signed manifest (update.json and update.json.sig) before anything is unpacked or installed.
# The check and the apt key handling need python3, base64 and OpenSSL 3 (for pkeyutl -rawin); the apt path also needs gpg and sudo.
# FARAVAN_CHANNEL picks the release route:
# - preview (the default; the only public route): the public signed feed names the Linux tarball. Its whole tree is
#   kept in the channel's own folder, which the app updates in place between jobs. The installer adds an applications
#   menu entry and opens the app. This route always checks the signature.
# - stable: the signed apt repository, so `apt upgrade` keeps it current. Fallbacks, in order: the release .deb, then a
#   self-contained tarball under ~/.local (no root; it updates itself between jobs).
#   FARAVAN_ALLOW_UNVERIFIED=1 skips the stable route's signature check, with a warning.
# URLs may be overridden for staging or an internal mirror.
set -eu

CHANNEL="${FARAVAN_CHANNEL:-preview}"
# The app updates a preview install from this same feed (PREVIEW_FEED_URL in lib/v1/self-update.mjs).
FEED_URL="${FARAVAN_FEED_URL:-https://tnunamak.github.io/faravan-updates/preview/update.json}"
KVM_DEVICE="${FARAVAN_KVM_DEVICE:-/dev/kvm}"
# The bundled Node.js Linux x64 build (packaging/node-runtime.env) needs glibc 2.28 or newer.
MIN_GLIBC="2.28"
# The Mac app's minimum (min_macos in packaging/macos/build-app.sh).
MIN_MACOS="14.0"

REPOSITORY="${FARAVAN_REPOSITORY:-tnunamak/faravan}"
# Version-stable asset names via the releases/latest/download redirect: no
# GitHub API call, so shared-IP unauthenticated rate limits (403s from office
# NAT, CI, containers) cannot break a tester's install. The API remains a
# fallback for releases that only carry versioned asset names.
DOWNLOAD_BASE="${FARAVAN_DOWNLOAD_BASE:-https://github.com/${REPOSITORY}/releases/latest/download}"
API_URL="${FARAVAN_RELEASE_API:-https://api.github.com/repos/${REPOSITORY}/releases/latest}"
INSTALL_ROOT="${FARAVAN_INSTALL_ROOT:-${HOME}/.local}"
APT_CACHE_DIR="${FARAVAN_APT_CACHE_DIR:-/var/cache/apt/archives}"
APT_BASE="${FARAVAN_APT_BASE:-https://sparekin.app/apt}"
# The fingerprint of the archive signing key. The release process fills this in
# when the real key exists (packaging/apt/README.md). While it is the placeholder
# the apt path stays off, so the installer never trusts a key it cannot check.
APT_KEY_FPR="${FARAVAN_APT_KEY_FPR:-REPLACE_WITH_ARCHIVE_KEY_FINGERPRINT}"
APT_KEYRING="${FARAVAN_APT_KEYRING:-/usr/share/keyrings/faravan-archive-keyring.gpg}"
APT_SOURCES="${FARAVAN_APT_SOURCES:-/etc/apt/sources.list.d/faravan.sources}"
# The .deb installs its launcher here; check that exact program, not whatever "faravan" comes first on PATH.
PACKAGED_BIN="${FARAVAN_PACKAGED_BIN:-/usr/bin/faravan}"
# Every release download is capped; 256 MiB is the update size limit in lib/v1/update-assets.mjs.
MAX_DOWNLOAD_BYTES=268435456
# The lowest stable release this installer accepts. A validly signed release below it is refused, so an old signed
# release cannot be replayed. Raise it with each security release; packaging/SIGNING.md has the rule.
MIN_INSTALL_VERSION="0.1.0"
# The public half of UPDATE_PUBLIC_KEY in lib/v1/update-key.mjs. tests/install-safety.test.mjs checks that the two match.
UPDATE_PUBLIC_KEY_PEM='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAB1aQT1bCZPnpunV9unOuKRndyCAPu2Znl+bxTzOaGKY=
-----END PUBLIC KEY-----'
# Reads the signed manifest and checks a downloaded file against it. Arguments: manifest, tarball|deb, file.
# It prints the reason on stderr and exits 1 when the file is not described by the signed manifest.
RELEASE_CHECK_PY='import hashlib, json, re, sys
# Kinds: tarball and deb (stable route); preview-url prints the preview Linux tarball URL and channel; preview-tarball
# checks the downloaded preview tarball. The package argument is "-" for preview-url.
manifest, kind, package, minimum = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
preview = kind.startswith("preview-")
def refuse(reason):
    sys.stderr.write(reason + "\n")
    sys.exit(1)
def version_tuple(text):
    return tuple(int(part) for part in text.split("."))
try:
    with open(manifest, "rb") as f:
        data = json.loads(f.read().decode("utf-8"))
except Exception:
    refuse("the signed update manifest is not valid JSON")
if not isinstance(data, dict) or data.get("schema") != 1:
    refuse("the signed update manifest has an unsupported schema")
version = data.get("version")
release = r"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})"
if not isinstance(version, str) or not re.fullmatch(release + (r"-preview\.[0-9]{8}\.(0|[1-9][0-9]{0,8})" if preview else ""), version):
    refuse("the signed update manifest is not a " + ("preview" if preview else "stable") + " release")
if version_tuple(version.split("-")[0]) < version_tuple(minimum):
    refuse("the signed release is older than the minimum version this installer accepts")
def linux_x64_stable(a):
    return isinstance(a, dict) and a.get("platform") == "linux" and a.get("arch") == "x64" and a.get("channel") == "faravan"
def linux_x64_preview(a):
    return (isinstance(a, dict) and a.get("platform") == "linux" and a.get("arch") == "x64" and a.get("kind") == "tarball"
        and isinstance(a.get("channel"), str) and re.fullmatch("[a-z0-9][a-z0-9-]{0,63}", a["channel"]) and a["channel"] != "stable")
if preview:
    assets = data.get("assets") if isinstance(data.get("assets"), list) else []
    tarballs = [a for a in assets if linux_x64_preview(a)]
    if (len(tarballs) != 1 or tarballs[0].get("url") != data.get("tarball") or tarballs[0].get("sha256") != data.get("sha256")
            or tarballs[0].get("size") != data.get("size") or not str(data.get("tarball")).startswith("https://")):
        refuse("the signed update manifest has no linux x64 preview tarball entry matching the tarball")
    if kind == "preview-url":
        print(data["tarball"])
        print(tarballs[0]["channel"])
        print(version)
        sys.exit(0)
    entry = data
elif kind == "tarball":
    entry = data
    if "assets" in data:
        assets = data["assets"] if isinstance(data["assets"], list) else []
        tarballs = [a for a in assets if linux_x64_stable(a) and a.get("kind") == "tarball"]
        if len(tarballs) != 1 or tarballs[0].get("sha256") != data.get("sha256") or tarballs[0].get("size") != data.get("size"):
            refuse("the signed update manifest has no linux x64 stable tarball entry matching the tarball")
else:
    entry = data.get("deb")
    if not isinstance(entry, dict) or entry.get("arch") != "x64" or entry.get("channel") != "faravan":
        refuse("the signed update manifest has no linux .deb entry for x86_64 on the stable channel")
sha, size = entry.get("sha256"), entry.get("size")
if not isinstance(sha, str) or not re.fullmatch("[a-f0-9]{64}", sha) or type(size) is not int or size < 1:
    refuse("the signed update manifest entry is invalid")
digest, total = hashlib.sha256(), 0
with open(package, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        digest.update(chunk)
        total += len(chunk)
if total != size or digest.hexdigest() != sha:
    refuse("the downloaded " + ("tarball" if preview else kind) + " does not match its signed manifest entry")
'
# Reads the extracted preview's channel.json. Arguments: the file and the channel its signed manifest entry names.
# Prints the channel's Linux folder and command prefix, then its display name.
CHANNEL_CHECK_PY='import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        channel = json.load(f)
except Exception:
    sys.exit("the download has no valid channel identity")
if not isinstance(channel, dict) or channel.get("id") != sys.argv[2]:
    sys.exit("the download is not the channel its signed manifest entry names")
prefix, name = channel.get("linuxPrefix"), channel.get("name")
if not isinstance(prefix, str) or not re.fullmatch("[a-z0-9][a-z0-9-]{0,79}", prefix):
    sys.exit("the download has an invalid channel folder name")
if not isinstance(name, str) or not re.fullmatch("[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}", name):
    sys.exit("the download has an invalid channel name")
print(prefix)
print(name)
'
TMP_DIR=""
GNUPG_HOME=""
ROOT_DEB_DIR=""
STUB_TMP=""
STAGED_DIR=""
RUNTIME_CURRENT="$INSTALL_ROOT/lib/faravan"
RUNTIME_NEW="$INSTALL_ROOT/lib/faravan.new"
RUNTIME_PREV="$INSTALL_ROOT/lib/faravan.prev"
RUNTIME_TRANSACTION="no"
RUNTIME_HAD_PREVIOUS="no"
RUNTIME_PREVIOUS_MOVED="no"
RUNTIME_PREVIOUS_RESTORED="no"
PREVIOUS_PACKAGE_VERSION=""

say() { printf '%s\n' "  $*"; }
warn() { printf '%s\n' "  warning: $*" >&2; }
die() { printf '%s\n' "  error: $*" >&2; exit 1; }

# Install paths are written unquoted into launchers and desktop entries, so they must be plain.
plain_path() {
  case "$1" in
    *[[:cntrl:]]*|*' '*|*'$'*|*'`'*|*'"'*|*'\'*|*':'*|*';'*|*'&'*|*'|'*|*'<'*|*'>'*|*'('*|*')'*|*'['*|*']'*|*'{'*|*'}'*|*'?'*|*'*'*|*'%'*)
      return 1 ;;
  esac
}
plain_path "$INSTALL_ROOT" || die "FARAVAN_INSTALL_ROOT cannot contain spaces or shell metacharacters"

path_exists() { [ -e "$1" ] || [ -L "$1" ]; }

rollback_runtime() {
  [ "$RUNTIME_TRANSACTION" = yes ] || return 0

  if path_exists "$RUNTIME_PREV" && { [ "$RUNTIME_PREVIOUS_MOVED" = yes ] || ! path_exists "$RUNTIME_CURRENT"; }; then
    RUNTIME_PREVIOUS_MOVED="yes"
  fi

  if [ "$RUNTIME_PREVIOUS_MOVED" = yes ] && path_exists "$RUNTIME_PREV"; then
    if path_exists "$RUNTIME_CURRENT"; then
      path_exists "$RUNTIME_NEW" && rm -rf "$RUNTIME_NEW" || true
      mv -T "$RUNTIME_CURRENT" "$RUNTIME_NEW" || return 1
    fi
    if ! mv -T "$RUNTIME_PREV" "$RUNTIME_CURRENT"; then
      if path_exists "$RUNTIME_NEW" && ! path_exists "$RUNTIME_CURRENT"; then
        mv -T "$RUNTIME_NEW" "$RUNTIME_CURRENT" || true
      fi
      return 1
    fi
    rm -rf "$RUNTIME_NEW" || true
    RUNTIME_PREVIOUS_RESTORED="yes"
  elif [ "$RUNTIME_HAD_PREVIOUS" = no ] && path_exists "$RUNTIME_CURRENT"; then
    path_exists "$RUNTIME_NEW" && rm -rf "$RUNTIME_NEW" || true
    mv -T "$RUNTIME_CURRENT" "$RUNTIME_NEW" || return 1
    rm -rf "$RUNTIME_NEW" || return 1
  fi

  RUNTIME_TRANSACTION="no"
  RUNTIME_PREVIOUS_MOVED="no"
  return 0
}

# The install.run record of a tarball install (docs/design/TELEMETRY.md §3.4). The bundle's own runtime writes it as this
# user, with the app's policy rule; nothing here can fail the install. The JS is the same as packaging/scripts/postinstall.sh.
install_started=$(date +%s%N 2>/dev/null || echo 0)
install_record='const [lib, method, outcome, ms] = process.argv.slice(1);
const { configHome } = await import(lib + "/local-state.mjs");
const { writeInstallRun } = await import(lib + "/v1/telemetry/crash.mjs");
const { join } = await import("node:path");
writeInstallRun({ dir: join(configHome(), "v1", "telemetry"), method, outcome, durationMs: Number(ms) });'
record_install_run() { # record_install_run OUTCOME [BUNDLE]
  # A root run never writes into root's home, as the package installer does not.
  [ "$(id -u)" -ne 0 ] || return 0
  now=$(date +%s%N 2>/dev/null || echo 0); duration=0
  if [ "$install_started" -gt 0 ] 2>/dev/null && [ "$now" -gt 0 ] 2>/dev/null; then duration=$(( (now - install_started) / 1000000 )); fi
  bundle="${2:-$INSTALL_ROOT/lib/faravan}"
  "$bundle/runtime/bin/node" --input-type=module -e "$install_record" "$bundle/lib" tarball "$1" "$duration" >/dev/null 2>&1 || true
  return 0
}

cleanup() {
  cleanup_status=$?
  trap - EXIT HUP INT TERM
  if [ "$RUNTIME_TRANSACTION" = yes ]; then
    if rollback_runtime; then
      if [ "$RUNTIME_PREVIOUS_RESTORED" = yes ]; then
        warn "installer stopped during runtime replacement; the previous runtime was restored"
      elif [ "$RUNTIME_HAD_PREVIOUS" = yes ]; then
        warn "installer stopped during runtime replacement; the previous runtime remains in place"
      fi
    else
      warn "installer stopped during runtime replacement; the previous runtime remains at $RUNTIME_PREV"
      cleanup_status=1
    fi
  fi
  [ -z "$STUB_TMP" ] || rm -f "$STUB_TMP"
  [ -z "$STAGED_DIR" ] || rm -rf "$STAGED_DIR"
  if [ -n "$GNUPG_HOME" ] && command -v gpgconf >/dev/null 2>&1; then
    gpgconf --homedir "$GNUPG_HOME" --kill gpg-agent >/dev/null 2>&1 || true
  fi
  [ -z "$ROOT_DEB_DIR" ] || sudo rm -rf "$ROOT_DEB_DIR" || true
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

need() {
  command -v "$1" >/dev/null 2>&1 || die "need '$1' (command not found)"
}

# Check tools before declaring this computer runnable or starting any download.
# Stable's explicit legacy opt-out does not remove the product's Python need.
preflight_linux_dependencies() {
  need python3
  need curl
  need tar
  if [ "$CHANNEL" = stable ] && [ "${FARAVAN_ALLOW_UNVERIFIED:-}" = 1 ]; then
    return 0
  fi
  need openssl
  need base64
  openssl pkeyutl -help 2>&1 | grep -q -- -rawin ||
    die "needs OpenSSL 3 to verify the release signature; nothing was downloaded or installed"
}

download() {
  curl -fsSL "$1" -o "$2" --max-filesize "${3:-$MAX_DOWNLOAD_BYTES}"
}

# Verifies a downloaded release file before anything unpacks or installs it. The manifest and its signature come
# from the same release as the file. The signature must verify under UPDATE_PUBLIC_KEY_PEM, and the file's size and
# sha256 must equal its signed entry. Arguments: tarball|deb, the file, and the file's URL.
verify_release_file() {
  kind="$1"
  file="$2"
  base="${3%/*}"
  if [ "${FARAVAN_ALLOW_UNVERIFIED:-}" = 1 ]; then
    warn "FARAVAN_ALLOW_UNVERIFIED=1: installing the $kind without checking its signature"
    return 0
  fi
  verify_signed_manifest "$base/update.json" "$base/update.json.sig"
  check_release_file "$kind" "$file"
  say "Verified the $kind against the release's signed manifest."
}

# Downloads a signed manifest and its signature into $manifest and checks the signature under UPDATE_PUBLIC_KEY_PEM.
# Arguments: the manifest URL and the signature URL.
verify_signed_manifest() {
  command -v openssl >/dev/null 2>&1 || die "need 'openssl' to verify the release signature; nothing was installed"
  command -v python3 >/dev/null 2>&1 || die "need 'python3' to verify the release signature; nothing was installed"
  command -v base64 >/dev/null 2>&1 || die "need 'base64' to verify the release signature; nothing was installed"
  openssl pkeyutl -help 2>&1 | grep -q -- -rawin || die "needs OpenSSL 3 to verify the release signature; nothing was installed"
  manifest="$TMP_DIR/update.json"
  signature="$TMP_DIR/update.json.sig"
  raw_signature="$TMP_DIR/update.sig"
  public_key="$TMP_DIR/update-public.pem"
  download "$1" "$manifest" 1048576 ||
    die "could not download the signed update manifest for this release; nothing was installed"
  download "$2" "$signature" 4096 ||
    die "could not download the manifest signature for this release; nothing was installed"
  printf '%s\n' "$UPDATE_PUBLIC_KEY_PEM" > "$public_key" || die "could not write the release public key; nothing was installed"
  base64 -d < "$signature" > "$raw_signature" 2>/dev/null || die "the manifest signature is not base64; nothing was installed"
  openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin -in "$manifest" -sigfile "$raw_signature" >/dev/null 2>&1 ||
    die "the update manifest signature does not verify; nothing was installed"
}

# Checks a file against the manifest that verify_release_file verified. Arguments: tarball|deb, the file, and
# "sudo" when the file is root-owned and must be read as root.
check_release_file() {
  problem=$(${3:+sudo} python3 -I -c "$RELEASE_CHECK_PY" "$manifest" "$1" "$2" "$MIN_INSTALL_VERSION" 2>&1) ||
    die "$problem; nothing was installed"
}

asset_url() {
  suffix="$1"
  stable_name="$2"
  if curl -fsIL "$DOWNLOAD_BASE/$stable_name" --max-filesize "$MAX_DOWNLOAD_BYTES" >/dev/null 2>&1; then
    printf '%s\n' "$DOWNLOAD_BASE/$stable_name"
    return 0
  fi
  curl -fsSL "$API_URL" -o "$TMP_DIR/release.json" --max-filesize "$MAX_DOWNLOAD_BYTES" || return 1
  sed -n "s|.*\"browser_download_url\": \"\([^\"]*${suffix}\)\".*|\1|p" "$TMP_DIR/release.json" |
    head -n 1
}

INSTALLED_VIA=""

install_tarball() {
  INSTALLED_VIA="tarball"
  tar_url="$1"
  tar_file="$TMP_DIR/faravan.tar.gz"
  unpacked="$TMP_DIR/unpacked"
  stub="$INSTALL_ROOT/bin/faravan"
  say "Installing the portable Faravan bundle into $INSTALL_ROOT..."
  # A self-update that was interrupted leaves its previous runtime in lib/faravan.prev. Put it back first, so a failed
  # download below cannot leave the user with no runtime.
  if [ ! -d "$RUNTIME_CURRENT" ] && [ -d "$RUNTIME_PREV" ]; then
    mv -T "$RUNTIME_PREV" "$RUNTIME_CURRENT" || die "could not recover the previous runtime from $RUNTIME_PREV"
  fi
  # Verify before anything is created, unpacked or moved under the install root.
  download "$tar_url" "$tar_file" || die "could not download the portable bundle; the existing runtime was kept"
  verify_release_file tarball "$tar_file" "$tar_url"
  mkdir -p "$unpacked" "$INSTALL_ROOT/bin" "$INSTALL_ROOT/lib" || die "could not create the install directories"
  if path_exists "$stub" && ! is_known_faravan_launcher "$stub"; then
    die "$stub already exists and is not this install's launcher; move it before installing Faravan"
  fi
  tar -xzf "$tar_file" -C "$unpacked" || die "could not extract the portable bundle; the existing runtime was kept"
  test -d "$unpacked/usr/lib/faravan" || die "release tarball does not contain the Faravan runtime"

  rm -rf "$RUNTIME_NEW" || die "could not clear the runtime staging directory; the existing runtime was kept"
  if ! cp -a "$unpacked/usr/lib/faravan" "$RUNTIME_NEW"; then
    rm -rf "$RUNTIME_NEW" || true
    die "could not stage the new runtime on the install filesystem; the existing runtime was kept"
  fi
  if [ ! -x "$RUNTIME_NEW/runtime/bin/node" ] || [ ! -f "$RUNTIME_NEW/bin/faravan" ]; then
    rm -rf "$RUNTIME_NEW" || true
    die "release tarball is missing its executable runtime; the existing runtime was kept"
  fi
  if ! printf 'tarball\n' > "$RUNTIME_NEW/.installed-via"; then
    rm -rf "$RUNTIME_NEW" || true
    die "could not mark the staged runtime; the existing runtime was kept"
  fi

  STUB_TMP="$(mktemp "$INSTALL_ROOT/bin/.faravan.XXXXXX")" || {
    rm -rf "$RUNTIME_NEW" || true
    die "could not create a temporary command stub; the existing runtime was kept"
  }
  if ! cat > "$STUB_TMP" <<EOF
#!/bin/sh
# A self-update moves the old tree to lib/faravan.prev while it puts the new one in place. If that was interrupted,
# there is no lib/faravan: put the old tree back before starting.
if [ ! -e "$INSTALL_ROOT/lib/faravan" ] && [ ! -L "$INSTALL_ROOT/lib/faravan" ] && [ -d "$INSTALL_ROOT/lib/faravan.prev" ]; then
  mv -Tn "$INSTALL_ROOT/lib/faravan.prev" "$INSTALL_ROOT/lib/faravan"
  if [ -e "$INSTALL_ROOT/lib/faravan.prev" ] || [ -L "$INSTALL_ROOT/lib/faravan.prev" ]; then
    printf '%s\n' 'Faravan could not restore the previous runtime safely.' >&2
    exit 1
  fi
fi
exec "$INSTALL_ROOT/lib/faravan/runtime/bin/node" "$INSTALL_ROOT/lib/faravan/bin/faravan" "\$@"
EOF
  then
    rm -f "$STUB_TMP" || true
    STUB_TMP=""
    rm -rf "$RUNTIME_NEW" || true
    die "could not write the temporary command stub; the existing runtime was kept"
  fi
  if ! chmod 0755 "$STUB_TMP"; then
    rm -f "$STUB_TMP" || true
    STUB_TMP=""
    rm -rf "$RUNTIME_NEW" || true
    die "could not prepare the command stub; the existing runtime was kept"
  fi

  if [ -d "$RUNTIME_CURRENT" ]; then
    RUNTIME_HAD_PREVIOUS="yes"
    if path_exists "$RUNTIME_PREV" && ! rm -rf "$RUNTIME_PREV"; then
      rm -rf "$RUNTIME_NEW" || true
      die "could not clear the previous runtime backup; the current runtime was kept"
    fi
  else
    RUNTIME_HAD_PREVIOUS="no"
  fi

  RUNTIME_TRANSACTION="yes"
  if [ "$RUNTIME_HAD_PREVIOUS" = yes ]; then
    if ! mv -T "$RUNTIME_CURRENT" "$RUNTIME_PREV"; then
      if ! path_exists "$RUNTIME_CURRENT" && [ -d "$RUNTIME_PREV" ]; then RUNTIME_PREVIOUS_MOVED="yes"; fi
      runtime_failure "could not move the current runtime to its backup"
    fi
    RUNTIME_PREVIOUS_MOVED="yes"
  fi
  if ! mv -T "$RUNTIME_NEW" "$RUNTIME_CURRENT"; then
    runtime_failure "could not activate the new runtime"
  fi
  # The app must be able to start, not just print a version: --readiness runs the device code in a throwaway home.
  if ! readiness=$("$RUNTIME_CURRENT/runtime/bin/node" "$RUNTIME_CURRENT/bin/faravan" --readiness 2>&1); then
    [ -z "$readiness" ] || warn "$readiness"
    runtime_failure "the new runtime failed its readiness check"
  fi
  if ! mv -fT "$STUB_TMP" "$stub"; then
    runtime_failure "could not replace the command stub"
  fi
  STUB_TMP=""

  # The staged tree, verified executable, and atomically replaced stub now form one committed install.
  RUNTIME_TRANSACTION="no"
  RUNTIME_PREVIOUS_MOVED="no"
  # Record the install's normal data-home identity beside the installed channel.
  # The application still resolves its home through its standard HOME-based rules.
  printf 'channel=faravan\ndata_home=%s/.local/share/Faravan\n' "$HOME" > "$INSTALL_ROOT/channel"
  chmod 0644 "$INSTALL_ROOT/channel"
  if path_exists "$RUNTIME_PREV" && ! rm -rf "$RUNTIME_PREV"; then
    warn "the new runtime is ready, but the old backup remains at $RUNTIME_PREV"
  fi
  install_tray_autostart "$RUNTIME_CURRENT/faravan-tray" || warn "could not install the tray autostart entry"
  install_app_launcher "$INSTALL_ROOT/bin/faravan" || warn "could not install the Faravan desktop launcher"
  install_link_handler "$stub" || warn "could not register the faravan:// link handler"
}

is_known_faravan_launcher() {
  launcher="$1"
  grep -Fq "$INSTALL_ROOT/lib/faravan/runtime/bin/node" "$launcher" ||
    { grep -Fq '"$INSTALL_ROOT/lib/faravan/runtime/bin/node"' "$launcher" &&
      grep -Fq '"$INSTALL_ROOT/lib/faravan/bin/faravan"' "$launcher"; } ||
    { grep -Fq "$INSTALL_ROOT/lib/faravan/current" "$launcher" &&
      grep -Fq 'exec "$T/runtime/bin/node" "$T/bin/faravan"' "$launcher"; } ||
    { grep -Fq "ROOT=\"$INSTALL_ROOT\"" "$launcher" &&
      grep -Fq 'T="$ROOT/lib/faravan/current"' "$launcher" &&
      grep -Fq 'exec "$T/runtime/bin/node" "$T/bin/faravan"' "$launcher"; } ||
    grep -Fq "exec node \"$INSTALL_ROOT/lib/faravan/bin/faravan\"" "$launcher" ||
    { grep -Fq 'FARAVAN_HOME="$HOME/.faravan-friend-preview"' "$launcher" &&
      grep -Fq 'exec "$HOME/.local/share/faravan-friend-preview/usr/bin/faravan" "$@"' "$launcher"; }
}

runtime_failure() {
  runtime_failure_message="$1"
  if rollback_runtime; then
    rm -rf "$RUNTIME_NEW" || true
    if [ "$RUNTIME_PREVIOUS_RESTORED" = yes ]; then
      die "$runtime_failure_message; the previous runtime was restored"
    elif [ "$RUNTIME_HAD_PREVIOUS" = yes ]; then
      die "$runtime_failure_message; the previous runtime remains in place"
    fi
    die "$runtime_failure_message; the failed runtime was removed"
  fi
  die "$runtime_failure_message; rollback failed and the previous runtime remains at $RUNTIME_PREV"
}

installed_package_version() {
  package_record="$(dpkg-query -W -f='${db:Status-Status}\t${Version}\n' faravan 2>/dev/null || true)"
  printf '%s\n' "$package_record" | awk -F '\t' '$1 == "installed" { print $2; exit }'
}

installed_package_status() {
  dpkg-query -W -f='${db:Status-Status}' faravan 2>/dev/null || true
}

restore_previous_package() {
  [ -n "$PREVIOUS_PACKAGE_VERSION" ] || return 1

  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 &&
    sudo apt-get install -y --reinstall --no-download --allow-downgrades "faravan=$PREVIOUS_PACKAGE_VERSION"; then
    [ "$(installed_package_version)" = "$PREVIOUS_PACKAGE_VERSION" ] && return 0
  fi

  package_arch=$(dpkg --print-architecture 2>/dev/null || true)
  if [ -n "$package_arch" ] && command -v dpkg-deb >/dev/null 2>&1; then
    for cached_deb in "$APT_CACHE_DIR"/faravan_*_"$package_arch".deb; do
      [ -f "$cached_deb" ] || continue
      [ "$(dpkg-deb -f "$cached_deb" Package 2>/dev/null || true)" = faravan ] || continue
      [ "$(dpkg-deb -f "$cached_deb" Version 2>/dev/null || true)" = "$PREVIOUS_PACKAGE_VERSION" ] || continue
      [ "$(dpkg-deb -f "$cached_deb" Architecture 2>/dev/null || true)" = "$package_arch" ] || continue
      if sudo dpkg -i "$cached_deb" && [ "$(installed_package_version)" = "$PREVIOUS_PACKAGE_VERSION" ]; then
        return 0
      fi
    done
  fi
  return 1
}

recover_failed_deb_install() {
  if [ -n "$PREVIOUS_PACKAGE_VERSION" ]; then
    if restore_previous_package; then
      say "Restored the previously installed Debian version $PREVIOUS_PACKAGE_VERSION."
      return 0
    fi

    current_version="$(installed_package_version)"
    current_status="$(installed_package_status)"
    if [ "$current_version" = "$PREVIOUS_PACKAGE_VERSION" ] && [ "$current_status" = installed ]; then
      warn "could not reinstall Debian version $PREVIOUS_PACKAGE_VERSION from cache; that installed version remains in place"
      return 0
    fi

    die "the Debian upgrade failed and version $PREVIOUS_PACKAGE_VERSION could not be restored; it was not purged"
  fi

  # Remove a failed first package install, but do not purge data that may belong to a prior tarball install.
  if [ -n "$(installed_package_status)" ]; then
    sudo dpkg --remove faravan >/dev/null 2>&1 ||
      die "could not remove the incomplete first-time Debian install; user data was not purged and portable fallback was stopped. Resolve the app state, then retry."
  fi
  return 0
}

# The .deb ships /usr/share/applications/faravan-open-link.desktop. A tarball install registers the
# faravan:// and legacy faravan:// handlers for this user, so an invitation page can hand the link to the app. Best effort:
# without it the page still shows the paste steps.
install_link_handler() {
  faravan_bin="$1"
  apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps_dir"
  desktop="$apps_dir/faravan-open-link.desktop"
  if path_exists "$desktop" && ! grep -Fqx "Exec=$faravan_bin open-link %u" "$desktop"; then
    say "Kept the existing link-handler file at $desktop."
    return 0
  fi
  desktop_tmp="$(mktemp "$apps_dir/.faravan-open-link.XXXXXX")" || return 1
  if ! cat > "$desktop_tmp" <<EOF
[Desktop Entry]
Type=Application
Name=Faravan invitation
Comment=Open a Faravan invitation link in the app
Exec=$faravan_bin open-link %u
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/faravan;x-scheme-handler/faravan;
Categories=Network;
EOF
  then rm -f "$desktop_tmp"; return 1; fi
  chmod 0644 "$desktop_tmp" && mv -fT "$desktop_tmp" "$desktop" || { rm -f "$desktop_tmp"; return 1; }
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default faravan-open-link.desktop x-scheme-handler/faravan >/dev/null 2>&1 || true
    xdg-mime default faravan-open-link.desktop x-scheme-handler/faravan >/dev/null 2>&1 || true
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi
  say "Registered the faravan:// link handler for invitation pages."
}

install_app_launcher() {
  faravan_bin="$1"
  apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps_dir"
  cat > "$apps_dir/faravan.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Faravan
Comment=Open Faravan
Exec=$faravan_bin
Terminal=false
Categories=Utility;Network;
StartupWMClass=faravan
EOF
  chmod 0644 "$apps_dir/faravan.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi
}

# The .deb ships a system-wide autostart entry via /etc/xdg/autostart; a
# non-root tarball install has no such hook, so without this the ambient tray
# icon silently never returns after a reboot (found live). Drop a user-level
# XDG autostart entry pointing at the installed tray binary. Skipped (with a
# note) when the binary is absent or the desktop session is headless.
install_tray_autostart() {
  tray_bin="$1"
  if [ ! -x "$tray_bin" ]; then
    say "No tray binary in this bundle; skipping autostart (daemon+UI still work)."
    return 0
  fi
  autostart_dir="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
  mkdir -p "$autostart_dir"
  desktop="$autostart_dir/faravan-tray.desktop"
  if path_exists "$desktop" && ! grep -Fqx "Exec=$tray_bin" "$desktop"; then
    say "Kept the existing autostart file at $desktop."
    return 0
  fi
  desktop_tmp="$(mktemp "$autostart_dir/.faravan-tray.XXXXXX")" || return 1
  if ! cat > "$desktop_tmp" <<EOF
[Desktop Entry]
Type=Application
Name=Faravan
Comment=Faravan contributor tray
Exec=$tray_bin
Terminal=false
Categories=Network;
StartupNotify=false
X-GNOME-Autostart-enabled=true
EOF
  then rm -f "$desktop_tmp"; return 1; fi
  chmod 0644 "$desktop_tmp" && mv -fT "$desktop_tmp" "$desktop" || { rm -f "$desktop_tmp"; return 1; }
  say "Installed the tray autostart entry; the icon returns after you log in."
  # Start it now too, so the user does not have to log out to see it once.
  if [ -z "${FARAVAN_NO_TRAY_LAUNCH:-}" ] && command -v setsid >/dev/null 2>&1; then
    setsid "$tray_bin" >/dev/null 2>&1 < /dev/null &
  fi
}

path_profile() {
  shell="${SHELL:-/bin/sh}"
  case "${shell##*/}" in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zprofile" ;;
    bash)
      printf '%s\n' "$HOME/.bashrc"
      if [ -f "$HOME/.bash_profile" ]; then printf '%s\n' "$HOME/.bash_profile"
      elif [ -f "$HOME/.bash_login" ]; then printf '%s\n' "$HOME/.bash_login"
      elif [ -f "$HOME/.profile" ]; then printf '%s\n' "$HOME/.profile"
      else printf '%s\n' "$HOME/.profile"
      fi
      ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

add_install_bin_to_path() {
  shell="${SHELL:-/bin/sh}"
  case "${shell##*/}" in
    fish)
      say "For fish, run fish_add_path with this directory: $INSTALL_ROOT/bin"
      return 0
      ;;
  esac
  marker='# Faravan command path'
  if [ "$INSTALL_ROOT" = "$HOME/.local" ]; then
    block_line='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'
  else
    block_line="case \":\$PATH:\" in *\":$INSTALL_ROOT/bin:\"*) ;; *) export PATH=\"$INSTALL_ROOT/bin:\$PATH\" ;; esac"
  fi
  profiles="$(path_profile)"
  while IFS= read -r profile; do
    [ -n "$profile" ] || continue
    [ -f "$profile" ] && awk -v marker="$marker" -v block="$block_line" \
      '$0 == marker { seen = 1; next } seen && $0 == block { found = 1 } END { exit !found }' "$profile" && continue
    if [ -s "$profile" ] && [ "$(tail -c 1 "$profile" | wc -l)" -eq 0 ]; then
      printf '\n' >> "$profile" || die "could not add $INSTALL_ROOT/bin to your shell profile"
    fi
    printf '%s\n%s\n' "$marker" "$block_line" >> "$profile" || die "could not add $INSTALL_ROOT/bin to your shell profile"
  done <<EOF
$profiles
EOF
}

# True when dotted version $1 is at least $2 (major.minor.patch; missing parts count as 0).
version_at_least() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    split(have, h, "."); split(need, n, ".")
    for (i = 1; i <= 3; i++) { if (h[i] + 0 > n[i] + 0) exit 0; if (h[i] + 0 < n[i] + 0) exit 1 }
    exit 0 }'
}

COMPUTER_PROBLEMS=""
computer_ok() { say "ok  $*"; }
computer_note() { say "--  $*"; }
computer_problem() { say "no  $*"; COMPUTER_PROBLEMS="yes"; }

# The supported-computer check. It runs before anything is downloaded and names what this computer lacks.
# Lending needs more than this (Docker Sandboxes and an agent sign-in); Setup in the app checks those.
check_computer() {
  say "Checking this computer..."
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) check_linux ;;
    Darwin) check_mac ;;
    *) computer_problem "Faravan runs on Linux and on Mac. This computer runs $os." ;;
  esac
  [ -z "$COMPUTER_PROBLEMS" ] || die "This computer cannot run Faravan. Nothing was downloaded or installed."
}

check_linux() {
  preflight_linux_dependencies
  case "$arch" in
    x86_64|amd64) computer_ok "Linux on a 64-bit Intel or AMD (x86-64) processor" ;;
    *) computer_problem "Faravan for Linux needs a 64-bit Intel or AMD (x86-64) computer. This computer is $arch." ;;
  esac
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  case "$libc" in
    "glibc "[0-9]*)
      libc="${libc#glibc }"
      if version_at_least "$libc" "$MIN_GLIBC"; then computer_ok "GNU C library $libc"
      else computer_problem "Faravan needs the GNU C library $MIN_GLIBC or newer. This computer has $libc."
      fi ;;
    *) computer_problem "Faravan for Linux needs the GNU C library (glibc) $MIN_GLIBC or newer. This computer's C library version could not be read." ;;
  esac
  if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then computer_ok "Desktop session"
  else computer_note "No desktop session found. Faravan is added to the applications menu for your next desktop login."
  fi
  if [ -r "$KVM_DEVICE" ] && [ -w "$KVM_DEVICE" ]; then
    computer_ok "Hardware virtualization for lending (/dev/kvm). Setup in Faravan checks the rest of lending."
  elif [ -e "$KVM_DEVICE" ]; then
    computer_note "Lending needs access to hardware virtualization (/dev/kvm), which this account does not have yet. You can still borrow."
  else
    computer_note "Lending needs hardware virtualization (/dev/kvm), which this computer does not offer. You can still borrow."
  fi
  [ -n "$COMPUTER_PROBLEMS" ] || say "This computer can run Faravan."
}

check_mac() {
  # A shell translated by Rosetta reports x86_64 on Apple silicon.
  if [ "$arch" = arm64 ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then computer_ok "Apple silicon"
  else computer_problem "Faravan for Mac needs Apple silicon (M1 or later). This Mac has an Intel processor."
  fi
  macos="$(sw_vers -productVersion 2>/dev/null || true)"
  if [ -z "$macos" ]; then computer_note "Could not read the macOS version. Faravan needs macOS ${MIN_MACOS%.0} or later."
  elif version_at_least "$macos" "$MIN_MACOS"; then computer_ok "macOS $macos"
  else computer_problem "Faravan for Mac needs macOS ${MIN_MACOS%.0} or later. This Mac has $macos."
  fi
  [ -n "$COMPUTER_PROBLEMS" ] || say "This Mac can run Faravan."
}

# The preview's applications-menu entry, named after its channel so it never replaces another install's entry.
# Arguments: the install folder, the channel prefix and the channel name.
install_menu_entry() {
  apps_dir="$DATA_ROOT/applications"
  mkdir -p "$apps_dir" || return 1
  desktop="$apps_dir/$2.desktop"
  if path_exists "$desktop" && ! grep -Fqx "Exec=$1/usr/bin/faravan" "$desktop"; then
    warn "$desktop already exists and belongs to something else, so Faravan cannot add its menu entry. It was not changed. Move it, then run this again."
    return 1
  fi
  desktop_tmp="$(mktemp "$apps_dir/.$2.XXXXXX")" || return 1
  if ! cat > "$desktop_tmp" <<EOF
[Desktop Entry]
Type=Application
Name=$3
Comment=Lend and borrow coding-agent time with people you trust
Exec=$1/usr/bin/faravan
TryExec=$1/usr/bin/faravan
Icon=$1/usr/lib/faravan/public/v1/icon-512.png
Terminal=false
Categories=Network;
EOF
  then rm -f "$desktop_tmp"; return 1; fi
  chmod 0644 "$desktop_tmp" && mv -fT "$desktop_tmp" "$desktop" || { rm -f "$desktop_tmp"; return 1; }
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi
}

# The public preview route. The signed feed names the Linux tarball; the whole tree is kept in the channel's own
# folder under the XDG data home, where the app updates it in place between jobs. A preview never takes the stable
# faravan command or ~/.local/lib/faravan. An existing install is kept as it is: it updates itself.
install_preview() {
  case "${XDG_DATA_HOME:-}" in /*) DATA_ROOT="$XDG_DATA_HOME" ;; *) DATA_ROOT="$HOME/.local/share" ;; esac
  plain_path "$DATA_ROOT" || die "Faravan installs into $DATA_ROOT, which has spaces or shell characters in its name; nothing was installed"
  verify_signed_manifest "$FEED_URL" "$FEED_URL.sig"
  asset=$(python3 -I -c "$RELEASE_CHECK_PY" "$manifest" preview-url - "$MIN_INSTALL_VERSION" 2>&1) || die "$asset; nothing was installed"
  tar_url="$(printf '%s\n' "$asset" | sed -n 1p)"
  channel="$(printf '%s\n' "$asset" | sed -n 2p)"
  say "Downloading Faravan $(printf '%s\n' "$asset" | sed -n 3p)..."
  tar_file="$TMP_DIR/faravan.tar.gz"
  download "$tar_url" "$tar_file" || die "could not download Faravan; nothing was installed"
  check_release_file preview-tarball "$tar_file"
  say "Verified the download against Faravan's signed release list."
  mkdir -p "$DATA_ROOT" || die "could not create $DATA_ROOT; nothing was installed"
  # Unpack beside the final folder, so the finished install is one rename on the same disk.
  STAGED_DIR="$(mktemp -d "$DATA_ROOT/.faravan-install.XXXXXX")" || die "could not create a folder in $DATA_ROOT; nothing was installed"
  tar -xzf "$tar_file" -C "$STAGED_DIR" || die "could not unpack Faravan; nothing was installed"
  identity=$(python3 -I -c "$CHANNEL_CHECK_PY" "$STAGED_DIR/usr/lib/faravan/channel.json" "$channel" 2>&1) ||
    die "$identity; nothing was installed"
  prefix="$(printf '%s\n' "$identity" | sed -n 1p)"
  name="$(printf '%s\n' "$identity" | sed -n 2p)"
  target="$DATA_ROOT/$prefix"
  fresh=""
  if path_exists "$target"; then
    grep -Fqx tarball "$target/usr/lib/faravan/.installed-via" 2>/dev/null ||
      die "$target already exists and is not a Faravan install; move it, then run this again"
    say "Faravan is already installed in $target; it updates itself."
  else
    # The app must be able to start on this computer, not just unpack: --readiness runs its device code in a throwaway home.
    if ! readiness=$("$STAGED_DIR/usr/lib/faravan/runtime/bin/node" "$STAGED_DIR/usr/lib/faravan/bin/faravan" --readiness 2>&1); then
      [ -z "$readiness" ] || warn "$readiness"
      die "Faravan could not start on this computer; nothing was installed"
    fi
    chmod 0755 "$STAGED_DIR" && mv -T "$STAGED_DIR" "$target" || die "could not move Faravan into $target; nothing was installed"
    STAGED_DIR=""
    fresh=yes
  fi
  # The menu entry is part of the install: without it the app cannot be opened the way the guide says.
  if ! install_menu_entry "$target" "$prefix" "$name"; then
    if [ -n "$fresh" ]; then
      rm -rf "$target"
      die "could not add Faravan to the applications menu; nothing was installed"
    fi
    die "could not add Faravan to the applications menu; the existing install in $target was kept"
  fi
  if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
    say "Opening Faravan..."
    "$target/usr/bin/faravan" || die "Faravan is installed in $target, but it did not open. Open it from your applications menu: $name."
    # Keeping files and a menu entry is not proof of a successful first open.
    # Preserve the retained-install error path above; only report success here.
    if [ -n "$fresh" ]; then
      say "Installed Faravan in $target."
      record_install_run ok "$target/usr/lib/faravan"
    fi
  else
    say "Faravan files and menu entry are installed in $target; first open has not been verified."
    say "To open it now without a desktop, run: $target/usr/bin/faravan"
  fi
  say "Open Faravan from your applications menu: $name."
}

check_computer
need curl
need tar

# No system Node.js is needed: the package and the tarball carry their own runtime (D6).

case "$CHANNEL" in
  preview)
    [ "$os" = Linux ] || {
      say "Faravan for Mac is a separate app download, not this command. Download the Mac app from the Faravan download page and open it from Applications."
      exit 0
    }
    TMP_DIR="$(mktemp -d)"
    install_preview
    exit 0 ;;
  stable) [ "$os" = Linux ] || die "the stable route installs Faravan on Linux only" ;;
  *) die "FARAVAN_CHANNEL must be preview or stable" ;;
esac

TMP_DIR="$(mktemp -d)"
PREVIOUS_PACKAGE_VERSION="$(installed_package_version)"
deb_url="$(asset_url '_amd64.deb' 'faravan_amd64.deb' || true)"
tar_url="$(asset_url '_linux_amd64.tar.gz' 'faravan_linux_amd64.tar.gz' || true)"

# Adds the Faravan apt repository and installs from it. Returns 1, having
# changed nothing that outlives the call, when it cannot be done safely.
install_via_apt() {
  command -v apt-get >/dev/null 2>&1 && command -v gpg >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 || return 1
  case "$APT_KEY_FPR" in REPLACE_WITH_*) return 1 ;; esac
  curl -fsI "$APT_BASE/dists/stable/InRelease" --max-filesize "$MAX_DOWNLOAD_BYTES" >/dev/null 2>&1 || return 1
  keyring="$TMP_DIR/faravan-archive-keyring.gpg"
  download "$APT_BASE/faravan-archive-keyring.gpg" "$keyring" || return 1
  # A scratch GnuPG home: reading the key must not touch the user's keyring.
  gnupg_home="$TMP_DIR/gnupg"
  GNUPG_HOME="$gnupg_home"
  mkdir -m 0700 "$gnupg_home" 2>/dev/null || true
  listing="$(gpg --batch --homedir "$gnupg_home" --show-keys --with-colons "$keyring" 2>/dev/null)" || return 1
  # The keyring must hold exactly one primary key, even when the pinned key comes first.
  primaries="$(printf '%s\n' "$listing" | awk -F: '$1 == "pub" { n++ } END { print n + 0 }')"
  if [ "$primaries" != 1 ]; then
    warn "the Faravan apt keyring must contain exactly one signing key; not using the apt repository"
    return 1
  fi
  # A revoked (r), expired (e) or disabled (d) key is not one to trust, whatever its fingerprint.
  validity="$(printf '%s\n' "$listing" | awk -F: '$1 == "pub" { print $2; exit }')"
  case "$validity" in
    r|e|d) warn "the Faravan apt key is revoked, expired or disabled; not using the apt repository"; return 1 ;;
  esac
  # Pin the key by fingerprint: a swapped keyring file on the host must not be trusted.
  actual="$(printf '%s\n' "$listing" | awk -F: '$1 == "pub" { pub = 1; next } pub && $1 == "fpr" { print $10; exit }')"
  if [ "$(printf '%s' "$actual" | tr a-f A-F)" != "$(printf '%s' "$APT_KEY_FPR" | tr a-f A-F)" ]; then
    warn "the Faravan apt key does not match the expected fingerprint; not using the apt repository"
    return 1
  fi
  # Install only the pinned key, exported by fingerprint from the scratch keyring.
  pinned_keyring="$TMP_DIR/faravan-archive-pinned.gpg"
  if ! { gpg --batch --homedir "$gnupg_home" --import "$keyring" >/dev/null 2>&1 &&
    gpg --batch --homedir "$gnupg_home" --export "$actual" > "$pinned_keyring" 2>/dev/null && [ -s "$pinned_keyring" ]; }; then
    warn "could not export the Faravan apt key; not using the apt repository"
    return 1
  fi
  say "Adding the Faravan apt repository (signed by $APT_KEY_FPR)..."
  say "This install step needs administrator permission; your system may ask for your password."
  keyring_existed=no
  sources_existed=no
  keyring_backup="$TMP_DIR/faravan-keyring.before"
  sources_backup="$TMP_DIR/faravan-sources.before"
  [ ! -e "$APT_KEYRING" ] || keyring_existed=yes
  [ ! -e "$APT_SOURCES" ] || sources_existed=yes
  if [ "$keyring_existed" = yes ]; then sudo cp -p "$APT_KEYRING" "$keyring_backup" || return 1; fi
  if [ "$sources_existed" = yes ]; then sudo cp -p "$APT_SOURCES" "$sources_backup" || return 1; fi
  if sudo install -D -m 0644 "$pinned_keyring" "$APT_KEYRING" &&
    printf 'Types: deb\nURIs: %s\nSuites: stable\nComponents: main\nSigned-By: %s\n' "$APT_BASE" "$APT_KEYRING" |
      sudo tee "$APT_SOURCES" >/dev/null &&
    sudo apt-get update && sudo apt-get install -y faravan; then
    return 0
  fi
  warn "could not install from the apt repository; removing it again"
  if [ "$sources_existed" = yes ]; then
    sudo cp -p "$sources_backup" "$APT_SOURCES" || die "could not restore the existing apt source file"
  else sudo rm -f "$APT_SOURCES" || die "could not remove the apt source file added by this run"; fi
  if [ "$keyring_existed" = yes ]; then
    sudo cp -p "$keyring_backup" "$APT_KEYRING" || die "could not restore the existing apt keyring"
  else sudo rm -f "$APT_KEYRING" || die "could not remove the apt keyring added by this run"; fi
  return 1
}

remove_owned_portable_faravan() {
  removed=no
  if path_exists "$INSTALL_ROOT/bin/faravan" && is_known_faravan_launcher "$INSTALL_ROOT/bin/faravan"; then
    rm -f "$INSTALL_ROOT/bin/faravan"
    removed=yes
  fi
  if path_exists "$INSTALL_ROOT/bin/faravan" &&
    grep -Fq "# faravan-tarball-shim: $INSTALL_ROOT" "$INSTALL_ROOT/bin/faravan"; then
    rm -f "$INSTALL_ROOT/bin/faravan"
    removed=yes
  fi
  if [ "$removed" = yes ] && [ -f "$INSTALL_ROOT/lib/faravan/.installed-via" ] &&
    grep -Fqx 'tarball' "$INSTALL_ROOT/lib/faravan/.installed-via"; then
    autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/faravan-tray.desktop"
    handler="${XDG_DATA_HOME:-$HOME/.local/share}/applications/faravan-open-link.desktop"
    if [ -f "$autostart" ] && grep -Fqx "Exec=$INSTALL_ROOT/lib/faravan/faravan-tray" "$autostart"; then
      rm -f "$autostart"
    fi
    if [ -f "$handler" ] && grep -Fqx "Exec=$INSTALL_ROOT/bin/faravan open-link %u" "$handler"; then
      rm -f "$handler"
    fi
    rm -rf "$INSTALL_ROOT/lib/faravan"
  fi
  if [ "$removed" = yes ]; then
    say "Removed the owned portable launchers and runtime; the package now provides faravan."
  fi
}

if install_via_apt; then
  INSTALLED_VIA="apt"
  remove_owned_portable_faravan
  say "Installed from the apt repository. 'sudo apt upgrade' will keep Faravan current."
elif [ -n "$deb_url" ] && command -v dpkg >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
  deb_file="$TMP_DIR/faravan.deb"
  say "Installing the Debian package..."
  say "This install step needs administrator permission; your system may ask for your password."
  download "$deb_url" "$deb_file" || die "could not download the Debian package"
  verify_release_file deb "$deb_file" "$deb_url"
  # dpkg runs as root, and this user can write the download. Install a root-owned copy, and check that copy too.
  ROOT_DEB_DIR="$(sudo env -u TMPDIR mktemp -d /tmp/faravan.XXXXXX)" || die "could not create a root-owned directory for the Debian package; nothing was installed"
  root_deb="$ROOT_DEB_DIR/faravan.deb"
  sudo install -m 0644 -o root "$deb_file" "$root_deb" || die "could not copy the Debian package into a root-owned directory; nothing was installed"
  if [ "${FARAVAN_ALLOW_UNVERIFIED:-}" != 1 ]; then check_release_file deb "$root_deb" sudo; fi
  if sudo dpkg -i "$root_deb"; then
    remove_owned_portable_faravan
    say "Installed the Debian package."
  elif [ -n "$tar_url" ]; then
    warn "the Debian package could not be installed; using the portable bundle instead"
    recover_failed_deb_install
    install_tarball "$tar_url"
  else
    recover_failed_deb_install
    die "the Debian package could not be installed"
  fi
elif [ -n "$tar_url" ]; then
  install_tarball "$tar_url"
else
  die "no Linux Faravan .deb or portable tarball was found in the latest release"
fi

if [ "$INSTALLED_VIA" != "tarball" ]; then
  if ! readiness=$("$PACKAGED_BIN" --readiness 2>&1); then
    [ -z "$readiness" ] || warn "$readiness"
    die "the installed package failed its readiness check"
  fi
fi

# Only the tarball installs under $INSTALL_ROOT; the .deb owns /usr/bin.
if [ "$INSTALLED_VIA" = "tarball" ]; then
  add_install_bin_to_path
  record_install_run ok
  say "Open a new terminal window to use faravan."
fi

say "Ready. Start the guided onboarding flow with: faravan"
