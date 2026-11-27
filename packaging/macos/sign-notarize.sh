#!/usr/bin/env bash
# Sign, notarize and staple Faravan.app (D5). NOT RUN: it needs macOS, an Apple Developer ID and
# notarization credentials, none of which exist yet (decision T27). Nothing here creates or asks for a key.
#
#   packaging/macos/sign-notarize.sh path/to/Faravan.app [outdir]
#
# Identities come only from the environment:
#   FARAVAN_MAC_SIGN_IDENTITY   "Developer ID Application: Name (TEAMID)", as `security find-identity` lists it
#   one way to notarize, either
#     FARAVAN_NOTARY_PROFILE    a keychain profile made once with `xcrun notarytool store-credentials`
#     FARAVAN_NOTARY_KEY_PATH + FARAVAN_NOTARY_KEY_ID + FARAVAN_NOTARY_ISSUER   an App Store Connect API key
# Or, for a preview with no Developer ID, set only FARAVAN_MAC_UNSIGNED_PREVIEW=1: every part gets an ad-hoc
# signature, nothing is notarized, and the zip is named Faravan-unsigned-preview.zip. Setting both is refused,
# so a signed release job can never fall back to an unsigned one.
# Native thin previews may set FARAVAN_MAC_PREVIEW_ARCH=arm64 or x86_64. It is only valid with the explicit
# unsigned-preview mode. The default remains universal, and signed releases always require universal input.
# Optional: FARAVAN_SIGN_DRY_RUN=1 prints each command and runs none (used by the tests, with stub tools).
# The script prints no secret: key paths and profile names only, never a key's contents.
# Input: a universal bundle from build-universal.sh, or an explicit native preview leg. It is checked first and
# must not be changed after signing.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="${1:?path to Faravan.app}"; out="${2:-$(dirname "$app")}"
dry="${FARAVAN_SIGN_DRY_RUN:-}"
preview="${FARAVAN_MAC_UNSIGNED_PREVIEW:-}"
node="${FARAVAN_BUILD_NODE:-node}"
preview_arch=universal

if [ -n "${FARAVAN_MAC_PREVIEW_ARCH+x}" ]; then
  if [ -z "$preview" ]; then
    echo "sign-notarize: FARAVAN_MAC_PREVIEW_ARCH is only valid for an unsigned preview (set FARAVAN_MAC_UNSIGNED_PREVIEW=1)." >&2
    exit 2
  fi
  preview_arch="$FARAVAN_MAC_PREVIEW_ARCH"
  case "$preview_arch" in
    arm64|x86_64|universal) ;;
    *) echo "sign-notarize: FARAVAN_MAC_PREVIEW_ARCH must be arm64, x86_64, or universal." >&2; exit 2 ;;
  esac
fi

if [ -n "$preview" ]; then
  if [ -n "${FARAVAN_MAC_SIGN_IDENTITY:-}" ]; then
    echo "sign-notarize: FARAVAN_MAC_UNSIGNED_PREVIEW and FARAVAN_MAC_SIGN_IDENTITY are both set. Choose one: a signed release never becomes an unsigned preview." >&2
    exit 2
  fi
else
  missing=()
  [ -n "${FARAVAN_MAC_SIGN_IDENTITY:-}" ] || missing+=(FARAVAN_MAC_SIGN_IDENTITY)
  if [ -z "${FARAVAN_NOTARY_PROFILE:-}" ]; then
    for v in FARAVAN_NOTARY_KEY_PATH FARAVAN_NOTARY_KEY_ID FARAVAN_NOTARY_ISSUER; do [ -n "${!v:-}" ] || missing+=("$v"); done
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    echo "sign-notarize: missing ${missing[*]}. Signing is off until the product owner decides on an Apple Developer ID (T27)." >&2
    echo "sign-notarize: for notarization set FARAVAN_NOTARY_PROFILE, or all of FARAVAN_NOTARY_KEY_PATH, _KEY_ID and _ISSUER." >&2
    echo "sign-notarize: for an explicitly labelled unsigned preview set only FARAVAN_MAC_UNSIGNED_PREVIEW=1." >&2
    exit 2
  fi
fi
[ -d "$app/Contents/MacOS" ] || { echo "sign-notarize: $app is not an app bundle" >&2; exit 2; }
# Signed releases always require a complete universal bundle. An explicit preview may use one native leg.
verify_arch=universal
[ -z "$preview" ] || verify_arch="$preview_arch"
"$here/verify-app.sh" "$app" "$verify_arch" >/dev/null || { echo "sign-notarize: $app failed verify-app.sh; nothing was signed" >&2; exit 1; }

run() { if [ -n "$dry" ]; then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
if [ -n "$preview" ]; then identity=(--sign -); else identity=(--timestamp --sign "$FARAVAN_MAC_SIGN_IDENTITY"); fi

# Inside out: the runtime, the helper bundle, the tray, the CLI script, then the app (and its launcher).
# --deep is not used to sign: it hides which parts were signed. Only Node gets the JIT entitlements.
while IFS=$'\t' read -r kind path; do
  extra=(); [ "$kind" != entitlements ] || extra=(--entitlements "$here/entitlements.plist")
  run codesign --force --options runtime ${extra[@]+"${extra[@]}"} "${identity[@]}" "$path"
done < <("$node" "$here/bundle-tool.mjs" sign-plan "$app")
run codesign --verify --deep --strict --verbose=2 "$app"

if [ -n "$preview" ]; then
  run ditto -c -k --keepParent "$app" "$out/$(basename "$app" .app)-unsigned-preview.zip"
  echo "sign-notarize: UNSIGNED PREVIEW (ad-hoc signatures, not notarized). Gatekeeper blocks the first open;"
  echo "sign-notarize: the person chooses Open Anyway in System Settings > Privacy & Security. Never call this a signed release."
  exit 0
fi

zip="$out/$(basename "$app" .app)-notarize.zip"
run ditto -c -k --keepParent "$app" "$zip"
if [ -n "${FARAVAN_NOTARY_PROFILE:-}" ]; then creds=(--keychain-profile "$FARAVAN_NOTARY_PROFILE")
else creds=(--key "$FARAVAN_NOTARY_KEY_PATH" --key-id "$FARAVAN_NOTARY_KEY_ID" --issuer "$FARAVAN_NOTARY_ISSUER"); fi
if [ -n "$dry" ]; then
  run xcrun notarytool submit "$zip" "${creds[@]}" --wait --output-format json
else
  result="$(xcrun notarytool submit "$zip" "${creds[@]}" --wait --output-format json)"
  status="$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')"
  id="$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')"
  if [ "$status" != "Accepted" ]; then
    echo "sign-notarize: notarization ended as '$status' (submission $id). Apple's log:" >&2
    xcrun notarytool log "$id" "${creds[@]}" >&2 || true
    exit 1
  fi
fi
run xcrun stapler staple "$app"
run xcrun stapler validate "$app"
# The Gatekeeper check a person's Mac makes. Passing here on the build Mac is not the same as the clean-machine gate.
run spctl --assess --type execute --verbose=2 "$app"
run rm -f "$zip"
run ditto -c -k --keepParent "$app" "$out/$(basename "$app" .app).zip"
echo "sign-notarize: done. Gate 'clean-machine install' is NOT run: install the zip on a Mac that never built it."
