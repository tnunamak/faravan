import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run = promisify(execFile);

test('tray relaunch does not resolve systemctl through the saved desktop PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-tray-path-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const bin = join(root, 'bin'), proc = join(root, 'proc');
  await mkdir(bin); await mkdir(join(proc, '101'), {recursive:true});
  const log = join(root, 'calls');
  await writeFile(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "$*" "$DISPLAY" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> '${log}'\n`, {mode:0o755});
  await writeFile(join(proc, '101/environ'), 'PATH=/nonexistent\0HOME=/synthetic/home\0DISPLAY=:99\0XDG_RUNTIME_DIR=/synthetic/run\0DBUS_SESSION_BUS_ADDRESS=unix:path=/synthetic/bus\0');
  const source = await readFile(new URL('../packaging/scripts/postinstall.sh', import.meta.url), 'utf8');
  let body = source.slice(source.indexOf('restart_tray() {'), source.indexOf('\nstart_user_app() {'));
  // Map the system executable directory to a fixture, as the lifecycle tests map installed paths.
  body = body.replaceAll('PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'PATH='+bin+':/usr/sbin:/usr/bin:/sbin:/bin');
  const script = join(root, 'run.sh');
  await writeFile(script, `#!/bin/sh\nset -eu\nproc_root='${proc}'\nuser_name=\nruntime_dir=/fallback/run\nas_user() { "$@"; }\ntray_list() { printf '101 1\\n'; }\nstop_tray() { rm -r "$proc_root/101"; }\nwait_until() { shift; "$@"; }\nnew_tray_running() { return 0; }\nnote_outcome() { :; }\n${body}\nrestart_tray\n`);
  await run('sh', [script]);
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /--user start faravan-tray.service\|:99\|\/synthetic\/run\|unix:path=\/synthetic\/bus/);
  assert.match(calls, /--user import-environment/);
});
