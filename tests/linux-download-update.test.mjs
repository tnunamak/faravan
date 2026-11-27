import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updaterForInstall, PREVIEW_FEED_URL} from '../lib/v1/self-update.mjs';
import {selectUpdateAsset} from '../lib/v1/update-assets.mjs';
import {isChannelIdentity} from '../lib/channel-identity.mjs';
import {buildSignedManifest} from '../packaging/sign-update.mjs';

const run = promisify(execFile);
const channel = 'faravan';
const version = n => `0.1.0-preview.20261102.${n}`;

test('published Linux download discovers and applies signed updates while the isolated preview stays disabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-download-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const stage = join(root, 'stage'), dist = join(root, 'dist');
  const runtime = join(stage, 'usr/lib/faravan');
  await mkdir(join(runtime, 'bin'), {recursive:true});
  await mkdir(join(runtime, 'runtime/bin'), {recursive:true});
  await mkdir(join(stage, 'usr/bin'), {recursive:true});
  await symlink(process.execPath, join(runtime, 'runtime/bin/node'));
  for (const name of ['faravan', 'faravan']) {
    await writeFile(join(stage, 'usr/bin', name), '#!/bin/sh\nself=$(readlink -f "$0")\nroot=$(dirname "$self")/../lib/faravan\nexec "$root/runtime/bin/node" "$root/bin/faravan" "$@"\n', {mode:0o755});
  }
  await writeFile(join(runtime, 'faravan-tray'), '#!/bin/sh\nexit 0\n', {mode:0o755});
  async function archive(n, broken = false) {
    await writeFile(join(runtime, 'VERSION'), version(n)+'\n');
    await writeFile(join(runtime, 'bin/faravan'), broken ? 'process.exit(1);' : `console.log('${version(n)}');`, {mode:0o755});
    const {stdout} = await run('bash', ['packaging/linux-download.sh', stage, dist]);
    assert.match(stdout, /faravan-linux-x64-/);
    return readFile(join(dist, `faravan-linux-x64-${version(n)}.tar.gz`));
  }
  const first = await archive(44);
  assert.equal(await updaterForInstall({home:root, installDir:runtime, env:{}}), null, 'the package stage stays unmanaged');
  const installed = join(root, 'installed');
  await mkdir(installed);
  const firstFile = join(root, 'first.tar.gz');
  await writeFile(firstFile, first);
  await run('tar', ['-xzf', firstFile, '-C', installed]);
  // A root extraction keeps these, so no entry may carry the builder's uid or a group/other write bit.
  for (const line of (await run('tar', ['-tvzf', firstFile, '--numeric-owner'])).stdout.trim().split('\n')) {
    const [mode, owner] = line.split(/\s+/);
    assert.equal(owner, '0/0', line);
    if (!mode.startsWith('l')) assert.match(mode, /^.....-..-./, line);
  }
  const installDir = join(installed, 'usr/lib/faravan');
  assert.equal((await run(join(installed, 'usr/bin/faravan'), ['--help'])).stdout.trim(), version(44));
  const identity = JSON.parse(await readFile(join(installDir, 'channel.json')));
  assert.ok(isChannelIdentity(identity));
  assert.equal(identity.id, channel);
  assert.equal(identity.bundleId, 'com.faravan.app');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({type:'spki', format:'pem'});
  const privateKeyPem = pair.privateKey.export({type:'pkcs8', format:'pem'});
  const url = 'https://updates.example.invalid/faravan-linux-x64.tar.gz';
  let signed, tarball;
  async function release(n, broken = false) {
    tarball = await archive(n, broken);
    signed = buildSignedManifest({tarball, version:version(n), privateKeyPem, tarballUrl:url,
      assets:[{archive:tarball, platform:'linux', arch:'x64', kind:'tarball', channel, url}]});
  }
  await release(45);
  let badSignature = true;
  const events = [];
  const updater = await updaterForInstall({home:join(root, 'home'), installDir, platform:'linux', env:{}, publicKey, arch:'x64',
    hosts:{record:async()=>({pid:123}), stop:async()=>events.push('stop'), start:async()=>events.push('start')},
    fetch:async address => {
      assert.ok([PREVIEW_FEED_URL, PREVIEW_FEED_URL+'.sig', url].includes(address));
      return new Response(address === url ? tarball : address.endsWith('.sig') ? (badSignature ? 'invalid' : signed.signature) : signed.bytes);
    }});
  assert.ok(updater, 'a published-style extracted download must get an updater');
  assert.equal(await updaterForInstall({home:root, installDir, env:{FARAVAN_NO_UPDATE:'1'}}), null);
  assert.match(await readFile('packaging/linux-preview.sh', 'utf8'), /"FARAVAN_NO_UPDATE=1"/);
  await assert.rejects(updater.check(), {code:'bad_signature'});
  assert.equal((await readFile(join(installDir, 'VERSION'), 'utf8')).trim(), version(44));
  badSignature = false;
  const {manifest} = await updater.check();
  assert.equal(selectUpdateAsset(manifest, {platform:'linux', arch:'x64', channel}).url, url);
  assert.equal(await updater.tick({idle:false, force:true}), 'staged');
  assert.equal(await updater.tick({idle:true, force:true, exclusive:async()=>null}), 'staged');
  assert.deepEqual(events, []);
  assert.equal(await updater.tick({idle:true, force:true}), 'applied');
  assert.deepEqual(events, ['stop', 'start']);
  assert.equal((await run(join(installed, 'usr/bin/faravan'), ['--help'])).stdout.trim(), version(45));
  assert.equal((await readFile(join(installDir+'.prev', 'VERSION'), 'utf8')).trim(), version(44));
  assert.equal((await readFile(join(installDir, '.installed-via'), 'utf8')).trim(), 'tarball');
  await release(46, true);
  assert.equal(await updater.tick({idle:true, force:true}), 'failed');
  assert.equal((await run(join(installed, 'usr/bin/faravan'), ['--help'])).stdout.trim(), version(45));
});
