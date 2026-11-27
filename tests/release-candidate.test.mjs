import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {parseOptions,checkIdentity,verifyCandidate,macArchitecture,assertNewRelease,checkReleaseAssets,verifyMacApp} from '../scripts/release-candidate.mjs';
import {buildSignedManifest} from '../packaging/sign-update.mjs';
const version='0.2.0-preview.20261126.1',commit='a'.repeat(40);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('candidate arguments reject missing, conflicting and malformed inputs',()=>{
  for(const args of [[],['--commit','HEAD'],['--commit',commit,'--version','1.0.0'],['--commit',commit,'--version',version,'--linux-only','--mac-zip','app.zip']])
    assert.throws(()=>parseOptions(args));
  assert.equal(parseOptions(['--commit',commit,'--version',version,'--dry-run','--linux-only']).dryRun,true);
  assert.equal(parseOptions(['--promote',version]).promote,version);
});
test('embedded version and source SHA must match the requested commit',()=>{
  const metadata={schemaVersion:1,sourceSha:commit,version};
  assert.doesNotThrow(()=>checkIdentity(version+'\n',metadata,{version,commit}));
  for(const changed of [{...metadata,version:'0.1.0'},{...metadata,sourceSha:'b'.repeat(40)},{...metadata,schemaVersion:2}])
    assert.throws(()=>checkIdentity(version,changed,{version,commit}));
  assert.throws(()=>checkIdentity('0.1.0',metadata,{version,commit}));
});
test('signed manifest includes both Linux downloads and verifies exact bytes and hashes',()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const linux=Buffer.from('portable'),deb=Buffer.from('debian'),mac=Buffer.from('mac');
  const url='https://github.com/tnunamak/faravan-updates/releases/download/v'+version+'/linux.tar.gz';
  const signed=buildSignedManifest({tarball:linux,version,sourceSha:commit,tarballUrl:url,privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}),
    assets:[{archive:linux,platform:'linux',arch:'x64',kind:'tarball',channel:'faravan',url},
      {archive:mac,platform:'darwin',arch:'universal',kind:'macos-app-zip',channel:'faravan',bundleId:'com.faravan.app',url:'https://example.test/mac.zip'}],
    deb:{archive:deb,arch:'x64',channel:'faravan',file:'faravan.deb'}});
  const artifacts=[{file:'linux.tar.gz',sha256:hash(linux),size:linux.length},{file:'faravan.deb',sha256:hash(deb),size:deb.length},{file:'mac.zip',sha256:hash(mac),size:mac.length}];
  const input={...signed,publicKey:publicKey.export({type:"spki",format:"pem"}),version,commit,artifacts};
  assert.equal(verifyCandidate(input).version,version);
  assert.equal(verifyCandidate(input).sourceSha,commit);
  assert.throws(()=>verifyCandidate({...input,commit:'b'.repeat(40)}),/sourceSha/);
  assert.throws(()=>verifyCandidate({...input,bytes:Buffer.concat([signed.bytes,Buffer.from('\n')])}),/signed/);
  assert.throws(()=>verifyCandidate({...input,version:'0.2.1-preview.20261126.1'}),/version/);
  assert.throws(()=>verifyCandidate({...input,artifacts:[{...artifacts[0],sha256:'f'.repeat(64)},...artifacts.slice(1)]}),/hash|artifact/);
  assert.throws(()=>verifyCandidate({...input,artifacts:artifacts.slice(1)}),/artifact/);
});
test('Mac architecture comes from the archived launcher, not its filename',()=>{
  const arm=Buffer.alloc(8);arm.writeUInt32LE(0xfeedfacf);arm.writeUInt32LE(0x100000c,4);
  assert.equal(macArchitecture(arm),'arm64');
  const intel=Buffer.from(arm);intel.writeUInt32LE(0x1000007,4);assert.equal(macArchitecture(intel),'x64');
  assert.throws(()=>macArchitecture(Buffer.from('not a Mac executable')));
});

test('--promote refuses an authentic signed manifest without sourceSha before any mutation',async t=>{
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const root=await mkdtemp(join(tmpdir(),'candidate-promote-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(root,'bin');await mkdir(bin);
  const shim=`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(process.env.GH_CALLS,JSON.stringify(args)+'\\n');
if(args[0]!=='api'||args.includes('--method'))throw Error('Unexpected mutation');
if(args[1].endsWith('/pages'))console.log('gh-pages');
else if(args[1].includes('/git/ref/'))console.log(JSON.stringify({object:{sha:'a'.repeat(40)}}));
else if(args[1].includes('/git/commits/'))console.log(JSON.stringify({tree:{sha:'b'.repeat(40)}}));
else {const suffix=args[1].includes('update.json.sig')?'.sig':'';
console.log(JSON.stringify({encoding:'base64',content:readFileSync(process.env.GH_FIXTURE+suffix).toString('base64')}));}
`;
  await writeFile(join(bin,'gh'),shim,{mode:0o755});
  const script=new URL('../scripts/release-candidate.mjs',import.meta.url).pathname;
  await assert.rejects(promisify(execFile)(process.execPath,[script,'--promote','0.1.0-preview.20261110.73','--dry-run'],{env:{...process.env,PATH:bin+':'+process.env.PATH,TMPDIR:root,
    GH_CALLS:join(root,'calls'),GH_FIXTURE:new URL('./fixtures/release-candidate/without-source.json',import.meta.url).pathname}}),/sourceSha/);
  const calls=(await readFile(join(root,'calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,3);assert.ok(calls.every(args=>args[0]==='api'&&!args.includes('--method')));
});


test('signer refuses abbreviated or malformed source commits',()=>{
  for(const sourceSha of ['a'.repeat(7),'a'.repeat(39),'g'.repeat(40),'a'.repeat(41)])
    assert.throws(()=>buildSignedManifest({tarball:Buffer.from('linux'),version,tarballUrl:'https://example.test/linux.tar.gz',sourceSha}),/sourceSha/);
});

test('target feed refuses older, equal and backdated releases',()=>{
  const old={version,released:'2026-11-26T12:00:00Z'};
  for(const next of [old,{...old,version:'0.2.0-preview.20261125.9'},
    {version:'0.2.0-preview.20261127.1',released:'2026-11-25T12:00:00Z'}])
    assert.throws(()=>assertNewRelease(next,old),/newer/);
  assert.doesNotThrow(()=>assertNewRelease({...old,version:'0.2.0-preview.20261127.1'},old));
  assert.doesNotThrow(()=>assertNewRelease(old,null));
  assert.throws(()=>assertNewRelease({...old,released:'invalid'},null),/newer/);
  assert.throws(()=>assertNewRelease({...old,version:'0.2.0-preview.20261127.1'},{...old,released:'invalid'}),/newer/);
});
test('published release must contain every signed asset at its signed size and digest',()=>{
  const manifest={tarball:'https://example.test/linux.tar.gz',size:12,sha256:'a'.repeat(64),
    deb:{file:'app.deb',size:7,sha256:'b'.repeat(64)},assets:[{url:'https://example.test/mac.zip',size:9,sha256:'c'.repeat(64)}]};
  const release={isDraft:false,assets:[{name:'linux.tar.gz',size:12,digest:'sha256:'+'a'.repeat(64)},{name:'app.deb',size:7},{name:'mac.zip',size:9}]};
  assert.doesNotThrow(()=>checkReleaseAssets(manifest,release));
  for(const broken of [{...release,isDraft:true},{...release,assets:release.assets.slice(1)},
    {...release,assets:[{...release.assets[0],size:13},...release.assets.slice(1)]},
    {...release,assets:[{...release.assets[0],digest:'sha256:'+'d'.repeat(64)},...release.assets.slice(1)]}])
    assert.throws(()=>checkReleaseAssets(manifest,broken),/release|asset/i);
});
test('fat Mac launcher must contain exactly arm64 and x64',async()=>{
  const {fatMachO,machO}=await import('./helpers/macos-app.mjs');
  assert.equal(macArchitecture(fatMachO([machO('arm64'),machO('x86_64')])),'universal');
  for(const slices of [[machO('arm64')],[machO('arm64'),machO('arm64')],[machO('arm64'),machO('x86_64'),machO('arm64')]])
    assert.throws(()=>macArchitecture(fatMachO(slices)));
});
test('release Mac verification refuses incomplete and development bundles',async t=>{
  const {mkdtemp,rm,writeFile,mkdir}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {makeApp}=await import('./helpers/macos-app.mjs');
  const root=await mkdtemp(join(tmpdir(),'release-mac-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const app=await makeApp(root,{arch:'universal',version});
  const res=join(app,'Contents/Resources/faravan');
  await writeFile(join(res,'installed-source.json'),JSON.stringify({schemaVersion:1,version,sourceSha:commit}));
  await assert.rejects(verifyMacApp(app,{version,commit}),/missing|ENOENT/);
  const {MAC_UPDATE_REQUIRED_FILES}=await import('../lib/v1/macos-update-helper.mjs');
  const {access}=await import('node:fs/promises');const {dirname}=await import('node:path');
  for(const path of MAC_UPDATE_REQUIRED_FILES) {
    const target=join(app,path);
    try{await access(target);}catch{await mkdir(dirname(target),{recursive:true});await writeFile(target,'fixture');}
  }
  assert.equal((await verifyMacApp(app,{version,commit})).arch,'universal');
  const {machO,fatMachO}=await import('./helpers/macos-app.mjs');
  await writeFile(join(res,'runtime/bin/node'),machO('arm64'));
  await assert.rejects(verifyMacApp(app,{version,commit}),/needs arm64 \+ x86_64/);
  await writeFile(join(res,'runtime/bin/node'),fatMachO([machO('arm64'),machO('x86_64')]));
  const bin=join(root,'bin');await mkdir(bin);
  await writeFile(join(bin,'codesign'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  const previousPath=process.env.PATH;process.env.PATH=bin;
  try {await assert.rejects(verifyMacApp(app,{version,commit}),/codesign/);}
  finally {process.env.PATH=previousPath;}
  await writeFile(join(res,'runtime/LICENSE'),'development runtime');
  await assert.rejects(verifyMacApp(app,{version,commit}),/development/);
});

test('dry-run promote checks signed target order and published assets before any write',async t=>{
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const root=await mkdtemp(join(tmpdir(),'promote-order-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(root,'bin');await mkdir(bin);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const key=privateKey.export({type:'pkcs8',format:'pem'});
  const signed=v=>buildSignedManifest({tarball:Buffer.from('linux'),version:v,sourceSha:commit,releasedAt:new Date('2026-11-26T12:00:00Z'),
    tarballUrl:'https://github.com/tnunamak/faravan-updates/releases/download/v'+v+'/linux.tar.gz',privateKeyPem:key});
  const candidate=signed(version);
  await writeFile(join(root,'candidate.json'),candidate.bytes);await writeFile(join(root,'candidate.sig'),candidate.signature);
  await writeFile(join(root,'public.pem'),publicKey.export({type:'spki',format:'pem'}));
  const shim=`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),root=process.env.GH_ROOT;
appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');
if(args.includes('--method')||args[0]==='release'&&args[1]!=='view')throw Error('Unexpected mutation');
if(args[0]==='release') {
 if(process.env.GH_MISSING==='1')throw Error('Release not found');
 console.log(JSON.stringify({isDraft:false,assets:[{name:'linux.tar.gz',size:process.env.GH_BAD_SIZE==='1'?6:5}]}));
} else if(args[1].endsWith('/pages'))console.log('gh-pages');
else {
 const folder=args[1].includes('/candidate/')?'candidate':'preview';
 if(folder==='preview'&&process.env.GH_EMPTY==='1'){console.error('HTTP 404');process.exit(1);}
 const suffix=args[1].includes('update.json.sig')?'sig':'json';
 console.log(JSON.stringify({encoding:'base64',content:readFileSync(root+'/'+folder+'.'+suffix).toString('base64')}));
}
`;
  await writeFile(join(bin,'gh'),shim,{mode:0o755});
  const script=join(root,'promote.mjs');
  await writeFile(script,`import {promote} from ${JSON.stringify(new URL('../scripts/release-candidate.mjs',import.meta.url).href)};
import {readFile} from 'node:fs/promises';
await promote(${JSON.stringify(version)},process.env.GH_ROOT,{dryRun:true,publicKey:await readFile(process.env.GH_ROOT+'/public.pem','utf8')});`);
  const run=async extra=>{
    await writeFile(join(root,'calls'),'');
    return promisify(execFile)(process.execPath,[script,'--dry-run'],{env:{...process.env,PATH:bin+':'+process.env.PATH,GH_ROOT:root,...extra}});
  };
  for(const target of [version,'0.2.0-preview.20261127.1']) {
    const current=signed(target);await writeFile(join(root,'preview.json'),current.bytes);await writeFile(join(root,'preview.sig'),current.signature);
    await assert.rejects(run({}),/newer/);
    assert.doesNotMatch(await readFile(join(root,'calls'),'utf8'),/release/,'refuse target order before release or write');
  }
  const older=signed('0.2.0-preview.20261125.1');await writeFile(join(root,'preview.json'),older.bytes);await writeFile(join(root,'preview.sig'),older.signature);
  await assert.rejects(run({GH_MISSING:'1'}),/Release not found/);
  await assert.rejects(run({GH_BAD_SIZE:'1'}),/asset/);
  assert.match((await run({})).stdout,/DRY RUN/);
  assert.match((await run({GH_EMPTY:'1'})).stdout,/DRY RUN/);
  await writeFile(join(root,'preview.sig'),'invalid');
  await assert.rejects(run({}),/signed|signature/i);
});

test('feed write compares the exact parent commit after a concurrent publication',async t=>{
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const root=await mkdtemp(join(tmpdir(),'publish-parent-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(root,'bin');await mkdir(bin);
  const fixture=new URL('./fixtures/release-candidate/without-source.json',import.meta.url).pathname;
  await writeFile(join(bin,'gh'),`#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(process.env.GH_CALLS,JSON.stringify(args)+'\\n');
if(args[0]!=='api'||args.includes('--method'))throw Error('Unexpected mutation');
if(args[1].includes('/git/ref/'))console.log(JSON.stringify({object:{sha:'c'.repeat(40)}}));
else console.log(JSON.stringify({encoding:'base64',content:readFileSync(process.env.GH_FIXTURE+(args[1].includes('.sig')?'.sig':'')).toString('base64')}));
`,{mode:0o755});
  const script=join(root,'publish.mjs');
  await writeFile(script,`import {publishPair} from ${JSON.stringify(new URL('../scripts/release-candidate.mjs',import.meta.url).href)};
import {readFile} from 'node:fs/promises';
await publishPair(process.env.GH_ROOT,'gh-pages','candidate',await readFile(process.env.GH_FIXTURE),await readFile(process.env.GH_FIXTURE+'.sig'));`);
  await assert.rejects(promisify(execFile)(process.execPath,[script,'--dry-run'],{env:{...process.env,PATH:bin+':'+process.env.PATH,
    GH_ROOT:root,GH_CALLS:join(root,'calls'),GH_FIXTURE:fixture}}),/newer/);
  const calls=(await readFile(join(root,'calls'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,3);
  assert.ok(calls.slice(1).every(args=>args[1].endsWith('?ref='+'c'.repeat(40))));
});
