#!/usr/bin/env bash
# Build the pi guest kit's contents as a LOCAL Docker image and check what is in it.
# Reads the pinned base digest and install commands from kits/wf-pi/spec.yaml, and the pi payload from scripts/build-pi-payload.sh.
# Pushes and tags nothing. The tag is local-only; remove it with: docker rmi faravan-wf-pi:local
# The result is evidence about the kit's inputs. sbx builds its own sandbox from the kit; a
# published content-addressed image is a separate owner step (see lib/sbx-image-pins.json).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
spec="$here/kits/wf-pi/spec.yaml"
base=$(sed -n 's/^  image: "\(.*\)"$/\1/p' "$spec")
[[ "$base" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "base image is not digest-pinned: $base" >&2; exit 1; }
# The kit's own install commands, in order, so the check cannot drift from the kit.
mapfile -t installs < <(sed -n 's/^    - command: "\(.*\)"$/\1/p' "$spec")
[[ ${#installs[@]} -ge 2 ]] || { echo "install commands not found in $spec" >&2; exit 1; }
tag=faravan-wf-pi:local
# The kit ships the pi payload as files copied into the sandbox home; this mirrors that, so the build needs no registry
# beyond the one `npm ci` inside build-pi-payload.sh. The image build itself runs with the payload already in its context.
context=$(mktemp -d "${TMPDIR:-$HOME/.tmp}/faravan-pi-image.XXXXXX")
trap 'rm -rf "$context"' EXIT
mkdir -p "$context/faravan"
cp "$here"/kits/wf-pi/files/home/.faravan/install-pi.sh "$here"/kits/wf-pi/files/home/.faravan/pi-payload.sha256 "$context/faravan/"
"$here/scripts/build-pi-payload.sh" --check "$context/faravan/pi-payload.tgz"
cat > "$context/Dockerfile" <<DOCKERFILE
FROM $base
USER root
COPY faravan /home/agent/.faravan
$(printf 'RUN %s\n' "${installs[@]}")
DOCKERFILE
docker build --platform linux/amd64 -t "$tag" "$context"
echo "image_id=$(docker image inspect "$tag" --format '{{.Id}}')"
echo "base=$base"
docker run --rm --network none --entrypoint sh "$tag" -c 'command -v node && node --version && command -v pi && pi --version && command -v faravan-pi'
