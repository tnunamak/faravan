import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupProgress, readBootId } from '../lib/v1/setup-progress.mjs';
import { createResumeHook, runOnceCall, autostartEntry, RUN_ONCE_KEY } from '../lib/v1/resume-hook.mjs';
import { runOpenSetup } from '../lib/v1/open-setup.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';

const exists = path => access(path).then(() => true, () => false);
async function dir(t) { const d = await mkdtemp(join(tmpdir(), 'spk-setup-')); t.after(() => rm(d, {recursive: true, force: true})); return d; }

test('a step that needs a restart resumes only after the computer restarted', async t => {
  const file = join(await dir(t), 'p.json');
  let boot = 'boot-1', clock = Date.parse('2026-10-19T15:00:00Z');
  const make = instance => createSetupProgress({file, instance, bootId: async () => boot, now: () => clock});
  const first = make('run-1');
  assert.equal(await first.view(), null);
  await first.mark('hypervisor');
  assert.deepEqual(await first.view(), {step: 'hypervisor', reason: 'restart', state: 'waiting', since: '2026-10-19T15:00:00.000Z'});
  // The app restarting alone (same boot) is not the restart the step needs.
  assert.equal((await make('run-2').view()).state, 'waiting');
  boot = 'boot-2';
  assert.deepEqual(await make('run-3').view(), {step: 'hypervisor', reason: 'restart', state: 'returned', since: '2026-10-19T15:00:00.000Z'});
});

test('a step that needs a new login resumes when the app comes back in a new session', async t => {
  const file = join(await dir(t), 'p.json');
  const make = instance => createSetupProgress({file, instance, bootId: async () => 'same-boot'});
  await make('run-1').mark('kvm');
  assert.equal((await make('run-1').view()).state, 'waiting');
  assert.deepEqual(await make('run-2').view(), {step: 'kvm', reason: 'logout', state: 'returned', since: (await make('run-2').view()).since});
});

test('an unreadable boot id never claims a restart that did not happen', async t => {
  const file = join(await dir(t), 'p.json');
  const p = createSetupProgress({file, instance: 'a', bootId: async () => null});
  await p.mark('hypervisor');
  assert.equal((await p.view()).state, 'waiting');
});

test('progress is cleared by its own check passing, and damaged or mismatched files are ignored', async t => {
  const d = await dir(t), file = join(d, 'p.json');
  const p = createSetupProgress({file, instance: 'a', bootId: async () => 'b'});
  await p.mark('kvm');
  assert.equal(await p.reconcile([{name: 'hypervisor_platform', ok: true}]), false, 'another step\'s check does not clear it');
  assert.equal(await p.reconcile([{name: 'kvm_access', ok: false}]), false);
  assert.ok(await p.view());
  assert.equal(await p.reconcile([{name: 'kvm_access', ok: true}]), true);
  assert.equal(await p.view(), null);
  assert.equal(await exists(file), false);
  await writeFile(file, '{not json');
  assert.equal(await p.view(), null);
  await writeFile(file, JSON.stringify({step: 'kvm', reason: 'restart', markedAt: 1}));
  assert.equal(await p.view(), null, 'a step with the wrong reason is not trusted');
  await assert.rejects(p.mark('docker'), {code: 'invalid_request'});
});

test('the boot id comes from the right place on each OS', async () => {
  const calls = [];
  const run = async (c, a) => { calls.push([c, ...a].join(' ')); return ' value\n'; };
  assert.equal(await readBootId({platform: 'linux', readFileImpl: async path => { calls.push(path); return 'uuid\n'; }}), 'uuid');
  assert.equal(await readBootId({platform: 'darwin', run}), 'value');
  assert.equal(await readBootId({platform: 'win32', run}), 'value');
  assert.equal(await readBootId({platform: 'plan9', run}), null);
  assert.equal(await readBootId({platform: 'darwin', run: async () => { throw new Error('x'); }}), null);
  assert.ok(calls.includes('/proc/sys/kernel/random/boot_id') && calls.includes('sysctl -n kern.boottime') && calls.some(c => c.startsWith('powershell.exe') && c.includes('LastBootUpTime')));
});

test('the resume hook is a RunOnce entry on Windows and a one-shot autostart on Linux', async t => {
  const calls = [];
  const win = createResumeHook({platform: 'win32', run: async (c, a) => { calls.push([c, ...a]); }, faravanCommand: 'C:\\Program Files\\Faravan\\faravan.exe'});
  assert.equal(await win.install(), true);
  assert.deepEqual(calls[0], runOnceCall('C:\\Program Files\\Faravan\\faravan.exe')[1].length ? ['reg', ...runOnceCall('C:\\Program Files\\Faravan\\faravan.exe')[1]] : []);
  assert.equal(calls[0][2], RUN_ONCE_KEY);
  assert.match(calls[0].join(' '), /\/d "C:\\Program Files\\Faravan\\faravan.exe" open-setup/);
  await win.remove();
  assert.deepEqual(calls[1].slice(0, 3), ['reg', 'delete', RUN_ONCE_KEY]);
  const home = await dir(t);
  const linux = createResumeHook({platform: 'linux', home, env: {}, run: async () => assert.fail('no command on Linux'), faravanCommand: '/opt/my apps/faravan'});
  assert.equal(await linux.install(), true);
  const entry = await readFile(join(home, '.config/autostart/faravan-setup.desktop'), 'utf8');
  assert.match(entry, /^Exec=\/opt\/my\\ apps\/faravan open-setup$/m);
  assert.equal(entry, autostartEntry('/opt/my apps/faravan'));
  await linux.remove();
  assert.equal(await exists(join(home, '.config/autostart/faravan-setup.desktop')), false);
  assert.equal(await createResumeHook({platform: 'darwin', run: async () => assert.fail('none')}).install(), false, 'macOS has no such step');
});

test('open-setup signs in with a one-time link and opens the setup route', async () => {
  const out = [], opened = [], calls = [];
  const fetch = async (url, options) => { calls.push(url + ' ' + options.method + ' ' + options.headers['x-faravan-session-token']); return {ok: true, json: async () => ({url: 'http://127.0.0.1:5000/auth/handoff?code=once'})}; };
  const {requestHandoffLink} = await import('../lib/v1/handoff-link.mjs');
  const code = await runOpenSetup([], {ensureHandoff: () => requestHandoffLink({origin: 'http://127.0.0.1:5000', token: 'secret'}, {fetch}), openUrl: u => opened.push(u), stdout: {write: t => out.push(t)}, stderr: {write: () => assert.fail('no error')}});
  assert.equal(code, 0);
  assert.deepEqual(opened, ['http://127.0.0.1:5000/auth/handoff?code=once#/setup']);
  assert.deepEqual(calls, ['http://127.0.0.1:5000/api/handoff POST secret']);
  assert.equal(opened[0].includes('secret'), false);
  assert.equal(await runOpenSetup(['x'], {ensureHandoff: async () => '', stderr: {write() {}}}), 2);
  const failing = await runOpenSetup([], {ensureHandoff: async () => { throw new Error('no app'); }, stderr: {write() {}}});
  assert.equal(failing, 1);
});

test('the app saves setup progress, reports it, resumes after a restart, and clears it', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const hookCalls = [];
  const resumeHook = {install: async () => { hookCalls.push('install'); return true; }, remove: async () => { hookCalls.push('remove'); }};
  let boot = 'boot-1';
  const first = await f.start('setup', {bootId: async () => boot, resumeHook});
  assert.deepEqual((await api(first.app, '/api/status')).setup, {resume: null});
  await api(first.app, '/api/setup/progress', {method: 'POST', body: {step: 'docker'}, status: 400});
  await api(first.app, '/api/setup/progress', {method: 'POST', body: {step: 'hypervisor', extra: 1}, status: 400});
  await api(first.app, '/api/setup/progress', {method: 'POST', token: null, body: {step: 'hypervisor'}, status: 401});
  const marked = await api(first.app, '/api/setup/progress', {method: 'POST', body: {step: 'hypervisor'}});
  assert.deepEqual([marked.resume.step, marked.resume.state, marked.openedByItself], ['hypervisor', 'waiting', true]);
  assert.deepEqual(hookCalls, ['install']);
  // The computer restarts: a new boot, a new run of the app on the same data folder.
  await first.app.close();
  boot = 'boot-2';
  const second = await f.start('setup', {bootId: async () => boot, resumeHook});
  const back = (await api(second.app, '/api/status')).setup.resume;
  assert.deepEqual([back.step, back.reason, back.state], ['hypervisor', 'restart', 'returned']);
  // Its own check failing keeps the step; passing clears it and removes the hook.
  await api(second.app, '/api/setup/progress/clear', {method: 'POST', body: {}});
  assert.deepEqual((await api(second.app, '/api/status')).setup, {resume: null});
  assert.deepEqual(hookCalls, ['install', 'remove']);
  await api(second.app, '/api/setup/progress/clear', {method: 'POST', body: {x: 1}, status: 400});
});

test('reading readiness clears a saved step once its own check passes', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  let kvmOk = false;
  const hookCalls = [];
  const backendFactory = async () => Object.assign(Object.create((await f.start('probe-source')).backend), {
    protectionSummary: async () => ({preflight: {checks: [{name: 'kvm_access', ok: kvmOk, detail: 'kvm', fix: 'sudo usermod -aG kvm $USER'}]}}),
  });
  const {app} = await f.start('kvm', {backendFactory, resumeHook: {install: async () => true, remove: async () => { hookCalls.push('remove'); }}});
  await api(app, '/api/setup/progress', {method: 'POST', body: {step: 'kvm'}});
  await api(app, '/api/readiness?refresh=true');
  assert.equal((await api(app, '/api/status')).setup.resume.step, 'kvm', 'the check still fails, so the step stays');
  kvmOk = true;
  await api(app, '/api/readiness?refresh=true');
  assert.deepEqual((await api(app, '/api/status')).setup, {resume: null});
  assert.deepEqual(hookCalls, ['remove']);
});
