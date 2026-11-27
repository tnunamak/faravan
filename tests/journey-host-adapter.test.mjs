import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, symlink, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHostAdapter} from '../packaging/journey/host-adapter.mjs';

const digest = createHash('sha256').update('artifact').digest('hex');
const base = {platform: 'darwin', runId: 'run-1', machineId: 'mac-1', artifact: '/staging/Faravan.zip', sha256: digest, destination: '/Users/test/Applications/Faravan.app'};
function spy(overrides = {}) {
  const calls = [];
  const runner = async call => {
    calls.push(call);
    if (overrides.prompt) return {code: 1, stdout: '', stderr: 'Password:'};
    if (call.program === '/usr/bin/shasum') return {code: 0, stdout: digest + '  ' + base.artifact, stderr: ''};
    return {code: call.args[0] === '-f' ? 0 : overrides.occupied && call.args[0] === '-e' ? 0 : 1, stdout: '', stderr: ''};
  };
  return {runner, calls};
}

test('Mac uses fixed commands with closed stdin and stops at the product gaps', async () => {
  const {runner, calls} = spy();
  const adapter = createHostAdapter({...base, runner});
  assert.equal((await adapter.verify()).status, 'preflight');
  assert.equal((await adapter.install()).code, 'macos_safe_archive_install_missing');
  assert.equal((await adapter.endpoint()).code, 'private_ui_endpoint_handoff_missing');
  assert.equal((await adapter.open()).status, 'blocked');
  assert.equal((await adapter.facts()).status, 'blocked');
  assert.equal((await adapter.close()).status, 'blocked');
  // Exactly the five read-only preflight commands, with no environment or extra fields (no HOME/XDG/USERPROFILE).
  assert.deepEqual(calls.map(c => ({...c, args: [...c.args]})), [
    {program: '/usr/bin/test', args: ['-f', base.artifact], stdin: 'ignore'},
    {program: '/usr/bin/test', args: ['-L', base.artifact], stdin: 'ignore'},
    {program: '/usr/bin/shasum', args: ['-a', '256', base.artifact], stdin: 'ignore'},
    {program: '/usr/bin/test', args: ['-e', base.destination], stdin: 'ignore'},
    {program: '/usr/bin/test', args: ['-L', base.destination], stdin: 'ignore'},
  ]);
});

test('prompts and unowned destinations stop the run', async () => {
  for (const [settings, code] of [[{prompt: true}, 'verification_unavailable'], [{occupied: true}, 'destination_unowned']]) {
    const adapter = createHostAdapter({...base, runner: spy(settings).runner});
    assert.equal((await adapter.verify()).code, code);
    assert.equal((await adapter.install()).code, 'verification_required');
  }
});

test('unchecked archive and unknown GUI, listener or process never reach launch or quit', async () => {
  const {runner, calls} = spy();
  const adapter = createHostAdapter({...base, runner});
  await adapter.verify();
  const before = calls.length;
  for (const operation of ['install', 'open', 'endpoint', 'facts', 'close']) {
    assert.equal((await adapter[operation]()).status, 'blocked');
  }
  assert.equal(calls.length, before);
});

test('interface rejects command injection, profile overrides and credential paths', () => {
  for (const option of [{command: 'sudo'}, {command: 'node'}, {command: 'startApp'}, {command: 'xattr'}, {command: 'spctl'}, {HOME: '/fake'}, {XDG_CONFIG_HOME: '/fake'}, {executable: '/dev/app'}]) {
    assert.throws(() => createHostAdapter({...base, runner: spy().runner, ...option}));
  }
  for (const artifact of ['/Users/test/Library/Keychains/login.keychain', '/home/test/.ssh/id_rsa', '/staging/../secret']) {
    assert.throws(() => createHostAdapter({...base, artifact, runner: spy().runner}));
  }
});

test('local verification checks bytes, symlinks and destination collisions without installing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'host-adapter-'));
  try {
    const artifact = path.join(dir, 'artifact.tar.gz');
    const destination = path.join(dir, 'install');
    await writeFile(artifact, 'artifact');
    const options = {platform: 'linux', runId: 'r', machineId: 'linux', artifact, destination, sha256: digest};
    const adapter = createHostAdapter(options);
    assert.equal((await adapter.verify()).status, 'preflight');
    assert.equal((await adapter.install()).code, 'linux_pinned_noninteractive_installer_missing');
    await writeFile(destination, 'unowned');
    assert.equal((await adapter.verify()).code, 'destination_unowned');
    assert.equal((await createHostAdapter({...options, sha256: '0'.repeat(64)}).verify()).code, 'artifact_digest_mismatch');
    const link = path.join(dir, 'link');
    await symlink(artifact, link);
    assert.equal((await createHostAdapter({...options, artifact: link}).verify()).code, 'artifact_not_regular_file');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
