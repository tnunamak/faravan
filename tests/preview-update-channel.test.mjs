import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createHash, sign} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as update from '../lib/v1/self-update.mjs';
import {isNewerMacUpdate} from '../lib/v1/macos-update-version.mjs';
import {selectUpdateAsset} from '../lib/v1/update-assets.mjs';

const run = promisify(execFile);
const feed = 'https://tnunamak.github.io/faravan-updates/preview/update.json';
const current = '0.1.0-preview.20261102.44', next = '0.1.0-preview.20261102.45';
const channel = 'faravan', bundleId = 'com.faravan.app';
const linuxChannel = 'preview-20261026';
const linuxURL = 'https://updates.example.invalid/linux.tar.gz';
const macURL = 'https://updates.example.invalid/mac-arm64.zip';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'faravan-preview-update-')));
  t.after(() => rm(root, {recursive:true, force:true}));
  // Only ephemeral test keys; never a release key or a committed key fixture.
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({type:'spki', format:'pem'});
  const keyFile = join(root, 'throwaway.pem');
  await writeFile(keyFile, pair.privateKey.export({type:'pkcs8', format:'pem'}), {mode:0o600});
  const tarball = Buffer.from('test tarball bytes'), zip = Buffer.from('test zip bytes');
  const manifest = {schema:1, version:next, released:new Date().toISOString(), tarball:linuxURL, size:tarball.length, sha256:digest(tarball),
    assets_schema:1, assets:[{platform:'darwin', arch:'arm64', kind:'macos-app-zip', channel, bundleId,
      url:macURL, size:zip.length, sha256:digest(zip)},
      {platform:'linux',arch:'x64',kind:'tarball',channel:linuxChannel,
        url:linuxURL,size:tarball.length,sha256:digest(tarball)}]};
  const signed = value => {const bytes=Buffer.from(JSON.stringify(value));
    return {bytes, signature:sign(null, bytes, pair.privateKey).toString('base64')};};
  async function installed(platform, {version=current, env={}, signedManifest=signed(manifest), badArchive=false}={}) {
    const home=join(root, platform+'-home'), installDir=platform==='darwin'
      ?join(root, 'Faravan.app/Contents/Resources/faravan'):join(root, 'linux-install');
    await mkdir(home, {recursive:true}); await mkdir(installDir, {recursive:true});
    await writeFile(join(installDir,'VERSION'),version);
    await writeFile(join(installDir,'.installed-via'),'tarball');
    await writeFile(join(installDir,'channel.json'),JSON.stringify({id:platform==='darwin'?channel:linuxChannel,bundleId}));
    const requests=[], address=env.FARAVAN_UPDATE_URL||feed;
    const fetch=async (url, options) => {
      requests.push(String(url));
      assert.equal(options?.headers?.Authorization, undefined);
      const body=String(url)===address?signedManifest.bytes:String(url)===address+'.sig'?signedManifest.signature:
        String(url)===linuxURL?(badArchive?Buffer.from('corrupt'):tarball):
        String(url)===macURL?(badArchive?Buffer.from('corrupt'):zip):null;
      assert.notEqual(body,null,'unexpected URL '+url);
      return new Response(body);
    };
    const updater=await update.updaterForInstall({home,installDir,platform,env,publicKey,fetch,arch:platform==='darwin'?'arm64':'x64',
      verifyBundle:async()=>true, extract:async()=>assert.fail('bad archive must not be extracted')});
    assert.ok(updater);
    return {updater,requests};
  }
  return {root,keyFile,publicKey,tarball,zip,manifest,signed,installed};
}

for (const platform of ['linux','darwin']) {
  test(platform+' preview .44 discovers signed .45 at the default public feed and honors overrides', async t => {
    const f=await fixture(t), {updater,requests}=await f.installed(platform);
    assert.equal((await updater.check()).manifest.version,next);
    assert.equal(update.PREVIEW_FEED_URL,feed);
    assert.deepEqual(requests,[feed,feed+'.sig']);
    const override='https://override.example.invalid/update.json';
    const other=await f.installed(platform,{env:{FARAVAN_UPDATE_URL:override}});
    assert.equal((await other.updater.check()).manifest.version,next);
    assert.deepEqual(other.requests,[override,override+'.sig']);
  });
  test(platform+' preview feed refuses tampering, wrong signatures and archive hash mismatch', async t => {
    const f=await fixture(t);
    // A valid discovery first makes this regression fail on the unsupported preview base.
    const good=await f.installed(platform);
    assert.equal((await good.updater.check()).manifest.version,next);
    const signed=f.signed(f.manifest);
    const tampered={...signed,bytes:Buffer.from(signed.bytes.toString().replace('.45','.46'))};
    const foreign=generateKeyPairSync('ed25519').privateKey;
    const wrong={...signed,signature:sign(null,signed.bytes,foreign).toString('base64')};
    for(const signedManifest of [tampered,wrong]) {
      const {updater}=await f.installed(platform,{signedManifest});
      await assert.rejects(updater.check(),{code:'bad_signature'});
    }
    const bad=await f.installed(platform,{badArchive:true});
    const {manifest}=await bad.updater.check();
    await assert.rejects(bad.updater.stage(manifest),{code:'bad_hash'});
  });
  test(platform+' preview feed matches install-life labels independently of the version date', async t => {
    const f=await fixture(t);
    const later={...f.manifest,version:'0.1.0-preview.20261103.1'};
    const good=await f.installed(platform,{signedManifest:f.signed(later)});
    assert.equal((await good.updater.check()).manifest.version,later.version);
    const wrong={...later,assets:later.assets.map(a=>a.platform===platform?{...a,channel:'other-product'}:a)};
    const bad=await f.installed(platform,{signedManifest:f.signed(wrong)});
    await assert.rejects(bad.updater.check(),{code:'bad_target'});
  });
}

test('preview ordering is numeric across dates and never crosses stable/preview channels', () => {
  for(const newer of [update.isNewer,(a,b)=>isNewerMacUpdate(a,b,channel)]) {
    assert.equal(newer(next,current),true);
    assert.equal(newer('0.1.0-preview.20261103.1',next),true);
    assert.equal(newer('0.1.0-preview.20261102.100',next),true);
    assert.equal(newer('0.1.0-preview.20261101.999',current),false);
    assert.equal(newer(current,current),false);
    assert.equal(newer('0.2.0',current),false);
    assert.equal(newer(next,'0.0.1'),false);
    assert.equal(newer('0.1.0-preview.20260230.1',current),false);
  }
  assert.equal(isNewerMacUpdate(next,current,channel),true);
});

test('one signing command writes a dual-platform preview manifest that both verifiers accept', async t => {
  const f=await fixture(t), tar=join(f.root,'linux.tar.gz'), zip=join(f.root,'mac.zip'), out=join(f.root,'out');
  await writeFile(tar,f.tarball); await writeFile(zip,f.zip);
  await run(process.execPath,[fileURLToPath(new URL('../packaging/sign-update.mjs',import.meta.url)),
    '--version',next,'--key',f.keyFile,'--out',out,'--tarball',tar,'--tarball-url',linuxURL,
    '--mac-zip',zip,'--mac-url',macURL,'--mac-channel',channel,'--mac-bundle-id',bundleId,
    '--linux-channel',linuxChannel]);
  const bytes=await readFile(join(out,'update.json')),signature=await readFile(join(out,'update.json.sig'),'utf8');
  const linux=update.verifyManifest(bytes,signature,f.publicKey);
  const mac=update.verifyMacManifest(bytes,signature,f.publicKey,channel);
  for(const platform of ['linux','darwin']) {
    const asset=selectUpdateAsset(platform==='linux'?linux:mac,{platform,arch:platform==='linux'?'x64':'arm64',
      channel:platform==='linux'?linuxChannel:channel,bundleId});
    const expected=platform==='linux'?f.tarball:f.zip;
    assert.equal(asset.size,expected.length); assert.equal(asset.sha256,digest(expected));
    assert.equal(asset.url,platform==='linux'?linuxURL:macURL);
  }
  for(const bad of ['relative.tar.gz','http://example.invalid/linux.tar.gz']) {
    const invalid={...f.manifest,tarball:bad,assets:f.manifest.assets.map(a=>a.platform==='linux'?{...a,url:bad}:a)};
    const signed=f.signed(invalid);
    assert.throws(()=>update.verifyManifest(signed.bytes,signed.signature,f.publicKey),{code:'bad_manifest'});
  }
  const relativeMac={...f.manifest,assets:f.manifest.assets.map(a=>a.platform==='darwin'?{...a,url:'mac.zip'}:a)};
  const invalid=f.signed(relativeMac);
  assert.throws(()=>update.verifyMacManifest(invalid.bytes,invalid.signature,f.publicKey,channel),{code:'bad_manifest'});
});
