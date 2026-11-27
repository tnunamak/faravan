#!/bin/sh
# CI gate: public/v1 must equal the bundle the UI build just wrote. Run after `npm --prefix ui run build`.
# A failure to inspect the tree is a failure: git status errors must not look like a clean tree.
set -eu

if ! status=$(git status --porcelain -- public/v1); then
  echo 'cannot inspect public/v1: git status failed' >&2
  exit 1
fi
if [ -n "$status" ]; then
  printf '%s\n' "$status" >&2
  echo "public/v1 is stale: run 'npm run build:ui' and commit" >&2
  exit 1
fi
