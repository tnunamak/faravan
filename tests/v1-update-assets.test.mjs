import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSignedManifest} from '../packaging/sign-update.mjs';
import {selectUpdateAsset, verifyManifest} from '../lib/v1/self-update.mjs';

const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const privateKeyPem=privateKey.export({type:'pkcs8',format:'pem'});
const publicKeyPem=publicKey.export({type:'spki',format:'pem'});
const asset={platform:'darwin',arch:'universal',kind:'macos-app-zip',channel:'faravan',
  bundleId:'com.faravan.app',url:'Faravan-0.2.0-universal-unsigned.zip',archive:Buffer.from('complete fake bundle archive')};
const signed=(assets=[asset])=>buildSignedManifest({tarball:Buffer.from('legacy linux archive'),
  version:'0.2.0',tarballUrl:'faravan_0.2.0_linux_amd64.tar.gz',privateKeyPem,assets});

test('publisher signs a complete Mac asset while preserving the legacy Linux manifest',()=>{
  const {bytes,signature}=signed();const manifest=verifyManifest(bytes,signature,publicKeyPem);
  assert.equal(manifest.schema,1);
  assert.equal(manifest.tarball,'faravan_0.2.0_linux_amd64.tar.gz');
  assert.equal(manifest.assets_schema,1);
  assert.equal(manifest.assets[0].kind,'macos-app-zip');
  assert.equal(manifest.assets[0].size,asset.archive.length);
  assert.match(manifest.assets[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(manifest.assets[0].archive,undefined);
});

test('Mac selection binds architecture, channel and bundle without Linux fallback',async()=>{
  const {selectUpdateAsset}=await import('../lib/v1/self-update.mjs');
  const {bytes,signature}=signed();const manifest=verifyManifest(bytes,signature,publicKeyPem);
  const target={platform:'darwin',arch:'arm64',channel:asset.channel,bundleId:asset.bundleId};
  assert.equal(selectUpdateAsset(manifest,target).url,asset.url);
  assert.throws(()=>selectUpdateAsset(manifest,{...target,channel:'other-product'}),/compatible/i);
  assert.throws(()=>selectUpdateAsset(manifest,{...target,bundleId:'another.app'}),/compatible/i);
  assert.throws(()=>selectUpdateAsset(manifest,{...target,arch:'riscv64'}),/compatible/i);
  assert.equal(selectUpdateAsset(manifest,{platform:'linux'}).url,manifest.tarball);
});

test('asset signatures and duplicate identities fail closed',()=>{
  assert.throws(()=>signed([asset,asset]),/duplicate/i);
  assert.throws(()=>signed([{...asset,url:'../outside.zip'}]),/asset/i);
  assert.throws(()=>signed([{...asset,url:'http://example.invalid/app.zip'}]),/asset/i);
  const {bytes,signature}=signed();const changed=JSON.parse(bytes);changed.assets[0].channel='faravan';
  assert.throws(()=>verifyManifest(Buffer.from(JSON.stringify(changed)),signature,publicKeyPem),/not signed/i);
});

const linuxTarball=Buffer.from('legacy linux archive'), tarballUrl='https://example.invalid/faravan_0.2.0_linux_amd64.tar.gz';
const tarballAsset={archive:linuxTarball,platform:'linux',arch:'x64',kind:'tarball',channel:'faravan',url:tarballUrl};
const debBytes=Buffer.from('fake package bytes');
const debOptions=(over={})=>({archive:debBytes,arch:'x64',channel:'faravan',file:'faravan_amd64.deb',...over});
const signedLinux=({assets,deb}={})=>buildSignedManifest({tarball:linuxTarball,version:'0.2.0',tarballUrl,privateKeyPem,assets,deb});
const signTool=fileURLToPath(new URL('../packaging/sign-update.mjs',import.meta.url));
const execFileAsync=promisify(execFile);

test('a .deb entry in assets is refused, because older Linux clients refuse asset kinds they do not know',()=>{
  assert.throws(()=>signedLinux({assets:[tarballAsset,{...tarballAsset,arch:'x64',kind:'deb',url:'https://example.invalid/faravan_amd64.deb',archive:debBytes}]}),/asset/i);
});

test('a .deb object validates beside the tarball, and the tarball self-updater selects the tarball',()=>{
  const {bytes,signature}=signedLinux({assets:[tarballAsset],deb:debOptions()});
  const manifest=verifyManifest(bytes,signature,publicKeyPem);
  assert.deepEqual(Object.keys(manifest.deb),['arch','channel','size','sha256','file']);
  assert.deepEqual(manifest.assets.map(a=>a.kind),['tarball']);
  const selected=selectUpdateAsset(manifest,{platform:'linux',arch:'x64',channel:'faravan'});
  assert.equal(selected.kind,'tarball');
  assert.equal(selected.url,tarballUrl);
});

test('the .deb object never changes what the tarball self-updater selects, even with no tarball asset',()=>{
  const {bytes,signature}=signedLinux({deb:debOptions()});
  const manifest=verifyManifest(bytes,signature,publicKeyPem);
  assert.equal(selectUpdateAsset(manifest,{platform:'linux',arch:'x64',channel:'faravan'}).url,tarballUrl);
});

test('a .deb object with a bad arch, size, channel or file name is refused',()=>{
  assert.throws(()=>signedLinux({deb:debOptions({arch:'riscv64'})}),/asset/i);
  assert.throws(()=>signedLinux({deb:debOptions({archive:Buffer.alloc(0)})}),/asset/i);
  assert.throws(()=>signedLinux({deb:debOptions({channel:'Stable!'})}),/asset/i);
  assert.throws(()=>signedLinux({deb:debOptions({file:'faravan.rpm'})}),/asset/i);
  assert.throws(()=>signedLinux({deb:debOptions({file:'../faravan.deb'})}),/asset/i);
});


test('sign-update writes the .deb object with its own size, sha256 and file name',{timeout:120000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sign-update-deb-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'update-private.pem'),privateKeyPem);
  await writeFile(join(dir,'faravan.tar.gz'),linuxTarball);
  await writeFile(join(dir,'faravan_amd64.deb'),debBytes);
  await execFileAsync(process.execPath,[signTool,'--tarball',join(dir,'faravan.tar.gz'),'--version','0.2.0',
    '--key',join(dir,'update-private.pem'),'--out',join(dir,'out'),'--tarball-url',tarballUrl,'--linux-channel','faravan','--linux-arch','x64',
    '--deb',join(dir,'faravan_amd64.deb'),'--deb-arch','x64']);
  const bytes=await readFile(join(dir,'out/update.json')), signature=await readFile(join(dir,'out/update.json.sig'),'utf8');
  const manifest=verifyManifest(bytes,signature,publicKeyPem);
  assert.deepEqual(manifest.deb,{arch:'x64',channel:'faravan',size:debBytes.length,sha256:createHash('sha256').update(debBytes).digest('hex'),file:'faravan_amd64.deb'});
  assert.deepEqual(manifest.assets.map(a=>a.kind),['tarball'], 'the .deb is not an asset');
  assert.equal(selectUpdateAsset(manifest,{platform:'linux',arch:'x64',channel:'faravan'}).kind,'tarball');
  const {validateManifestAssets:validateNow}=await import('../lib/v1/update-assets.mjs');
  assert.doesNotThrow(()=>validateNow(manifest));
});

test('sign-update refuses a .deb without a linux channel',{timeout:120000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sign-update-deb-bad-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'update-private.pem'),privateKeyPem);
  await writeFile(join(dir,'faravan.tar.gz'),linuxTarball);
  await writeFile(join(dir,'faravan_amd64.deb'),debBytes);
  await assert.rejects(execFileAsync(process.execPath,[signTool,'--tarball',join(dir,'faravan.tar.gz'),'--version','0.2.0',
    '--key',join(dir,'update-private.pem'),'--out',join(dir,'out'),'--deb',join(dir,'faravan_amd64.deb')]),/needs --linux-channel/);
});
