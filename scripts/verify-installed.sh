#!/bin/sh
# Verifies one installed Faravan CLI against the candidate the caller expects.
# Usage: verify-installed.sh <faravan-binary> --expect-path <canonical installed path> --expect-sha256 <64 lowercase hex> [journey options]
# Pre/postflight checks detect observable identity changes; they do not bind executed bytes atomically.
# Swapped bytes may execute, and hostile same-hash change/restore is not prevented.
# The expected identity is required. A missing or mismatched identity fails before journey-check starts. This script never builds or launches
# another binary to repair the evidence. Journey options, including --expect-version, are forwarded unchanged.
set -eu

usage() {
  printf '%s\n' 'Usage: verify-installed.sh <faravan-binary> --expect-path <canonical path> --expect-sha256 <hex> [journey options]' >&2
  exit 2
}

if [ "$#" -lt 1 ] || [ -z "$1" ]; then usage; fi
binary=$1
shift

expect_path=''
expect_sha=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-path) [ "$#" -ge 2 ] || usage; expect_path=$2; shift 2 ;;
    --expect-sha256) [ "$#" -ge 2 ] || usage; expect_sha=$2; shift 2 ;;
    *) break ;;
  esac
done
if [ -z "$expect_path" ] || [ -z "$expect_sha" ]; then
  echo 'identity required: pass --expect-path and --expect-sha256 for the installed candidate' >&2
  exit 2
fi
case "$expect_sha" in
  *[!0-9a-f]*) echo '--expect-sha256 must be 64 lowercase hex characters' >&2; exit 2 ;;
esac
if [ "${#expect_sha}" -ne 64 ]; then
  echo '--expect-sha256 must be 64 lowercase hex characters' >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo 'runtime required: Node.js (node) is not available' >&2
  exit 2
fi
if ! node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); const cp = require("node:child_process"); if (typeof fs.realpathSync !== "function" || typeof fs.readFileSync !== "function" || typeof crypto.createHash !== "function" || typeof cp.spawnSync !== "function") process.exit(1);' >/dev/null 2>&1; then
  echo 'unsupported runtime: Node.js must support built-in fs, crypto and child_process' >&2
  exit 2
fi

script_dir=${0%/*}
if [ "$script_dir" = "$0" ]; then script_dir=.; fi
exec node - "$binary" "$expect_path" "$expect_sha" "$script_dir/journey-check.mjs" "$@" <<'NODE'
const {realpathSync, readFileSync, statSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const [binary, expectedPath, expectedSha, journey, ...options] = process.argv.slice(2);
const fail = message => { console.error(message); process.exit(1); };
let resolved, canonical, digest, identity;
const fileIdentity = path => {
  const stat = statSync(path, {bigint: true});
  if (!stat.isFile()) throw new Error('not a file');
  return stat.dev.toString() + ':' + stat.ino.toString();
};
try { resolved = realpathSync(binary); } catch { fail('cannot resolve ' + binary); }
try { canonical = realpathSync(expectedPath); } catch { fail('cannot resolve expected path ' + expectedPath); }
if (resolved !== canonical) fail('identity mismatch: ' + resolved + ' is not the expected installed executable ' + canonical);
try {
  identity = fileIdentity(resolved);
  digest = createHash('sha256').update(readFileSync(resolved)).digest('hex');
  if (fileIdentity(resolved) !== identity) fail('identity changed during preflight');
}
catch { fail('cannot hash ' + resolved); }
if (digest !== expectedSha) fail('identity mismatch: ' + resolved + ' hashes to ' + digest + ', expected ' + expectedSha);
// This is a portable prerequisite check, not atomic binding of executed bytes.
process.env.FARAVAN_NO_BROWSER = '1';
process.env.FARAVAN_NO_BROWSER = '1';
// Run the real journey in this process, retaining its subprocess lifecycle handling.
import(pathToFileURL(resolve(journey)).href).then(async ({runJourney}) => {
  // Hold the final report until the observation is checked: never emit a PASS
  // and then retract it. Do not intercept signals or change journey cleanup.
  const lines = [];
  const code = await runJourney(['--binary', resolved, '--signin-probe', '--step-timeout-ms', '60000', ...options],
    {write: line => lines.push(line)});
  let changed = false;
  try {
    changed = realpathSync(binary) !== resolved || realpathSync(expectedPath) !== canonical
      || fileIdentity(resolved) !== identity
      || createHash('sha256').update(readFileSync(resolved)).digest('hex') !== expectedSha
      || fileIdentity(resolved) !== identity;
  } catch { changed = true; }
  if (changed) {
    const detail = 'identity changed or became unreadable during journey; installed candidate not verified';
    console.error(detail);
    if (options.includes('--json') && lines.length === 1 && lines[0].startsWith('{')) {
      const report = JSON.parse(lines[0]);
      report.steps.push({step: 'installed.identity', state: 'FAIL', ms: 0, detail});
      report.result = 'FAIL';
      report.first_fail ??= 'installed.identity';
      lines[0] = JSON.stringify(report);
    } else {
      const index = lines.findIndex(line => line.startsWith('RESULT '));
      if (index >= 0) {
        lines.splice(index, 0, 'installed.identity | FAIL | 0 | ' + detail);
        if (code === 0) lines[index + 1] = 'RESULT FAIL first_fail=installed.identity';
      } else lines.push('installed.identity | FAIL | 0 | ' + detail);
    }
  }
  for (const line of lines) console.log(line);
  process.exitCode = code || (changed ? 1 : 0);
}).catch(() => {
  console.error('cannot run journey-check');
  process.exitCode = 1;
});
NODE
