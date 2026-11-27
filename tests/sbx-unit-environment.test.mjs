import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSbxPreflight, _internal } from '../lib/docker-backend.mjs';

// The installed app runs in a systemd unit that strips the desktop session variables on purpose. A developer shell has
// the user bus, so a probe that needs it passes in every test and fails on every install. This test runs the gated sbx
// path with the unit's own environment: the stripped names are read from the unit definition, never copied here.

const unitScript = readFileSync(fileURLToPath(new URL('../packaging/linux-preview.sh', import.meta.url)), 'utf8');
const stripped = (() => {
  const start = unitScript.indexOf('/usr/bin/env -u ');
  const end = unitScript.indexOf('"PATH=', start);
  assert.ok(start >= 0 && end > start, 'the app unit definition must keep its `env -u` list');
  return [...unitScript.slice(start, end).matchAll(/-u\s+([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
})();

const RUN_HELP = [
  'Usage: sbx run [flags] AGENT PATH', 'Flags:',
  '  -d, --detach   Start detached', '      --name string   Name', '      --kit strings   Kit', '      --cpus int   CPUs',
  '      --memory string   Memory', '      --skills strings   Skills', '      --deny-network   Deny network',
].join('\n');

test('the unit definition strips the session bus variables', () => {
  assert.ok(stripped.includes('DBUS_SESSION_BUS_ADDRESS') && stripped.includes('XDG_RUNTIME_DIR'), stripped.join(' '));
});

function unitFixture(t, { bus }) {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-unit-env-'));
  const runtime = join(dir, 'run'); mkdirSync(runtime);
  writeFileSync(join(runtime, 'bus'), '');
  const log = join(dir, 'systemctl.log');
  const marker = join(dir, 'executed');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  // Like the real systemctl: no user bus in the environment, no answer.
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
if [ -z "$XDG_RUNTIME_DIR" ] || [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then echo "nobus $*" >> '${log}'; echo "Failed to connect to user scope bus" >&2; exit 1; fi
echo "bus $*" >> '${log}'
case "$*" in *is-system-running*) echo running; exit 0;; esac
exit 1
`);
  writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(bin, 'sbx'), `#!/bin/sh
case "$1 $2" in "run --help") cat <<'EOF'\n${RUN_HELP}\nEOF\n;; esac
case "$1" in exec) echo ran > '${marker}';; esac
case "$1" in version) echo "sbx version: v0.51.0 abc";; daemon) echo "Status: running";; esac
exit 0
`);
  for (const f of ['systemctl', 'systemd-run', 'sbx']) chmodSync(join(bin, f), 0o755);
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); });
  for (const name of stripped) delete process.env[name];
  delete process.env.FARAVAN_SBX_DAEMON_GATE;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FARAVAN_SBX_BIN = join(bin, 'sbx');
  t.after(_internal.useBusRuntimeDir(() => (bus ? runtime : null)));
  return { log, marker };
}


const SKIP = !existsSync('/run/systemd/system') && 'no systemd on this host';

test('the gated sbx path works with the environment the app unit really has', { skip: SKIP }, async (t) => {
  const { log } = unitFixture(t, { bus: true });
  const report = await probeSbxPreflight({ platformName: 'linux' });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.some((l) => l.startsWith('bus ') && l.includes('is-system-running')), `manager probe never reached the bus: ${calls.join(' | ')}`);
  assert.deepEqual(calls.filter((l) => l.startsWith('nobus')), []);
  assert.equal(report.checks.find((c) => c.name === 'sbx_cli_contract')?.ok, true);
});

// A `--help` that is a guest argument or an option value is not a help read: the daemon gate still decides.
for (const argv of [['exec', 'wf-x', '--', 'sh', '-c', 'echo executed', '--help'], ['run', '--name', '--help'], ['run', '--help', '--name', 'x']]) {
  test(`${argv.join(' ')} stays behind the daemon gate in the real runners`, { skip: SKIP }, async (t) => {
    const { marker } = unitFixture(t, { bus: false });
    const refused = await _internal.runPreflightCommand(process.env.FARAVAN_SBX_BIN, argv);
    assert.equal(refused.code, 1);
    assert.equal(refused.status, 'systemd_probe_failed');
    assert.equal(existsSync(marker), false, 'sbx never ran');
  });
}
