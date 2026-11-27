import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,rename,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSignedManifest} from '../packaging/sign-update.mjs';
import {updaterForInstall,scheduleUpdates,runUpdateCommand,verifyManifest} from '../lib/v1/self-update.mjs';
import {createUpdateService} from '../lib/v1/update-service.mjs';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';

function zip(bad=false, content='fixture') {
  const names=bad?['Faravan.app/../escape']:[
    'Faravan.app/Contents/Info.plist','Faravan.app/Contents/MacOS/faravan-launch',
    'Faravan.app/Contents/MacOS/faravan-tray','Faravan.app/Contents/MacOS/faravan-process-identity',
    'Faravan.app/Contents/Helpers/FaravanNotify.app/Contents/Info.plist',
    'Faravan.app/Contents/Resources/faravan/runtime/bin/node','Faravan.app/Contents/Resources/faravan/VERSION'];
  const locals=[],centrals=[];let offset=0;
  for(const name of names){const data=Buffer.from(content),file=Buffer.from(name);let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(file.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x031e,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(file.length,28);central.writeUInt32LE((0o100644<<16)>>>0,38);central.writeUInt32LE(offset,42);
    const block=Buffer.concat([local,file,data]);locals.push(block);centrals.push(Buffer.concat([central,file]));offset+=block.length;
  }
  const cd=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(names.length,8);end.writeUInt16LE(names.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cd,end]);
}
async function fakeBundle(path,version,tag){
  await mkdir(path,{recursive:true,mode:0o755});
  const files={'Contents/Info.plist':tag,'Contents/MacOS/launcher':tag,'Contents/MacOS/faravan-tray':tag,
    'Contents/MacOS/faravan-process-identity':tag,'Contents/Helpers/FaravanNotify.app/Contents/Info.plist':tag,
    'Contents/Resources/faravan/runtime/bin/node':tag,'Contents/Resources/faravan/VERSION':version};
  for(const [name,contents] of Object.entries(files)){const file=join(path,name);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,contents);}
}
async function fixture(t,{badSignature=false,badHash=false,badTarget=false,badZip=false,invalidBundle=false,managed=true}={}) {
  const root=await mkdtemp(join(tmpdir(),'mac-factory-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const appPath=join(root,'Faravan.app'),installDir=join(appPath,'Contents/Resources/faravan'),home=join(root,'home');
  await fakeBundle(appPath,'0.1.0-preview.20261029.20','A');await mkdir(join(home,'v1'),{recursive:true,mode:0o700});
  await writeFile(join(installDir,'channel.json'),JSON.stringify({id:'faravan',bundleId:'com.faravan.app'}));

  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),pub=publicKey.export({type:'spki',format:'pem'}),priv=privateKey.export({type:'pkcs8',format:'pem'});
  const archive=zip(badZip);
  const asset={platform:'darwin',arch:'universal',kind:'macos-app-zip',channel:badTarget?'other-product':'faravan',bundleId:'com.faravan.app',url:'https://example.test/app.zip',archive};
  const signed=buildSignedManifest({tarball:Buffer.from('legacy'),version:'0.1.0-preview.20261029.21',tarballUrl:'https://example.test/linux.tar.gz',privateKeyPem:priv,assets:[asset]});
  const files=new Map([['https://example.test/update.json',signed.bytes],['https://example.test/update.json.sig',Buffer.from(badSignature?'bad':signed.signature)],['https://example.test/app.zip',badHash?Buffer.from('wrong'):archive]]);
  let extracted=0,prepared=0,releaseCount=0,context=managed?{snapshot:async()=>[{role:'app'}],signal:new AbortController().signal,markHandoff:()=>true}:null;
  const fetch=async url=>files.has(url)?new Response(files.get(url)) :new Response('',{status:404});
  const extract=async(file,out)=>{extracted++;assert.deepEqual(await readFile(file),archive);await fakeBundle(join(out,'Faravan.app'),'0.1.0-preview.20261029.21','B');};
  const verifyBundle=async(path,version)=>!invalidBundle&&(await readFile(join(path,'Contents/Resources/faravan/VERSION'),'utf8').catch(()=>''))===version;
  const prepare=async options=>{prepared++;const release=await options.exclusive();return {ready:true,cancel:async()=>{releaseCount++;await release();},spec:options.spec};};
  const make=(extra={})=>updaterForInstall({home,installDir,platform:'darwin',arch:'arm64',publicKey:pub,manifestUrl:'https://example.test/update.json',fetch,extract,verifyBundle,prepare,managedContext:()=>context,...extra});
  const updater=await make();
  return {root,home,appPath,installDir,updater,make,files,signed,pub,priv,context,counts:()=>({extracted,prepared,releaseCount})};
}

test('a packaged manual check cannot continue its downloads or publish after owner stop',async t=>{
  const f=await fixture(t);let enter,resume;
  const entered=new Promise(resolve=>{enter=resolve;}),download=new Promise(resolve=>{resume=resolve;}),requests=[];
  const updater=await f.make({fetch:async url=>{requests.push(url);if(!url.endsWith('.sig')){enter();await download;}return new Response(f.files.get(url));}});
  const owner=new AppLifetime(),handle=owner.register('updater','producer',{blockedByHold:true});
  const work=handle.run(({signal})=>updater.check({signal,admit:()=>handle.commit(()=>{}),commit:replace=>handle.commit(replace)})).catch(error=>error);
  try {
    await entered;const stopping=owner.stop('quit');resume();await work;await stopping;
    assert.equal(requests.length,1);await assert.rejects(readFile(join(f.home,'v1/update.json')),{code:'ENOENT'});
  }finally{resume();await work;await owner.stop('quit');}
});

test('packaged factory stages signed preview and scheduler hands off after exclusion',async t=>{
  const f=await fixture(t);assert.equal(f.updater.kind,'packaged-mac');const events=[];
  let ticket;const service=createUpdateService({updater:f.updater});const schedule=scheduleUpdates({updater:service,isIdle:async()=>true,exclusive:async()=>{events.push('exclusive');return ()=>events.push('release');},
    onHandoff:async value=>{ticket=value;events.push('close');},onApplied:assert.fail,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  await schedule.step();assert.deepEqual(events,['exclusive','close']);assert.equal(f.counts().extracted,2);assert.equal(f.counts().prepared,1);
  assert.equal(await readFile(join(f.appPath,'Contents/MacOS/launcher'),'utf8'),'A');assert.equal(await readFile(join(f.appPath+'.next','Contents/MacOS/launcher'),'utf8'),'B');
  assert.equal(await readFile(join(f.appPath+'.next','Contents/Resources/faravan/runtime/bin/node'),'utf8'),'B');
  assert.equal(await readFile(join(f.appPath+'.next','Contents/Helpers/FaravanNotify.app/Contents/Info.plist'),'utf8'),'B');await ticket.cancel();
});

test('bad signature, hash, target, archive and bundle refuse before handoff',async t=>{
  for(const mode of ['badSignature','badHash','badTarget','badZip','invalidBundle']){
    const f=await fixture(t,{[mode]:true});assert.equal(await f.updater.tick({idle:true}),'failed',mode);
    assert.equal(f.counts().prepared,0);if(mode!=='invalidBundle')assert.equal(f.counts().extracted,0,mode);
    assert.equal(await readFile(join(f.appPath,'Contents/MacOS/launcher'),'utf8'),'A');
  }
});

test('busy and unmanaged handoff preserve the staged bundle and old app',async t=>{
  for(const managed of [true,false]) {
    const f=await fixture(t,{managed});assert.equal(await f.updater.tick({idle:true}),'handoff');
    await assert.rejects(f.updater.prepareHandoff({signal:new AbortController().signal,exclusive:async()=>null}),{code:managed?'busy':'managed_required'});
    assert.ok((await lstat(f.appPath+'.next')).isDirectory());assert.equal(await readFile(join(f.appPath,'Contents/MacOS/launcher'),'utf8'),'A');
  }
});

test('signed receipt is revalidated and pending or failed journal prevents installation',async t=>{
  const f=await fixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  const journal={schema:1,id:'11111111-1111-1111-1111-111111111111',appPath:f.appPath,home:f.home,channel:'faravan',bundleId:'com.faravan.app',version:'0.1.0-preview.20261029.21',previousVersion:'0.1.0-preview.20261029.20',phase:'starting'};
  await writeFile(f.appPath+'.update-journal.json',JSON.stringify(journal),{mode:0o600});assert.equal(await f.updater.tick({idle:true}),'failed');
  await writeFile(f.appPath+'.update-journal.json',JSON.stringify({...journal,phase:'rolled-back'}),{mode:0o600});assert.equal(await f.updater.tick({idle:true}),'skipped-failed-version');
  await rm(f.appPath+'.update-journal.json');const receipt=join(f.home,'v1','macos-update-stage.json'),saved=JSON.parse(await readFile(receipt,'utf8'));saved.signature='bad';await writeFile(receipt,JSON.stringify(saved),{mode:0o600});
  await assert.rejects(f.updater.prepareHandoff({signal:new AbortController().signal,exclusive:async()=>()=>{}}),{code:'bad_signature'});
});

test('a version the helper refused after stopping the app is not handed off again and stays visible after the restart',async t=>{
  const f=await fixture(t);assert.equal(await f.updater.tick({idle:true}),'handoff');
  const refusal=join(f.home,'v1','macos-update-refusal.json');
  const note=version=>writeFile(refusal,JSON.stringify({schema:1,version,previousVersion:'0.1.0-preview.20261029.20',code:'invalid_layout',at:'2026-11-06T00:00:00.000Z'}),{mode:0o600});
  await note('0.1.0-preview.20261029.21');
  const prepared=f.counts().prepared;assert.equal(await f.updater.tick({idle:true}),'failed');assert.equal(f.counts().prepared,prepared);
  const restarted=await f.make(),status=await restarted.status();
  assert.deepEqual(status.refused,{version:'0.1.0-preview.20261029.21',code:'invalid_layout',at:'2026-11-06T00:00:00.000Z'});
  const service=createUpdateService({updater:restarted,currentVersion:'0.1.0-preview.20261029.20',owner:'faravan'});await service.restore();
  assert.equal(service.status().state,'failed');assert.equal(service.status().candidate,'0.1.0-preview.20261029.21');assert.match(service.status().error,/could not be installed/);
  // A note about another version, or about a version the install has reached, does not block anything.
  await note('0.1.0-preview.20261029.19');assert.equal((await (await f.make()).status()).refused,undefined);
  await note('0.1.0-preview.20261029.22');assert.equal(await f.updater.tick({idle:true}),'handoff');
});

test('manual Mac command checks only and both verifiers accept preview versions',async t=>{
  const f=await fixture(t);let output='';const code=await runUpdateCommand([],{updater:f.updater,appRunning:async()=>false,stdout:{write:s=>{output+=s;}},stderr:{write:assert.fail}});
  assert.equal(code,0);assert.match(output,/Open Faravan/);assert.equal(f.counts().extracted,0);
  assert.equal(verifyManifest(f.signed.bytes,f.signed.signature,f.pub).version,'0.1.0-preview.20261029.21');
});

test('publisher CLI signs bytes from an explicit local asset map',async t=>{
  const {spawn}=await import('node:child_process');const root=await mkdtemp(join(tmpdir(),'mac-sign-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),pub=publicKey.export({type:'spki',format:'pem'}),priv=privateKey.export({type:'pkcs8',format:'pem'});
  await writeFile(join(root,'key.pem'),priv,{mode:0o600});await writeFile(join(root,'linux.tar.gz'),'linux');const archive=zip();await writeFile(join(root,'mac.zip'),archive);
  await writeFile(join(root,'map.json'),JSON.stringify([{file:'mac.zip',platform:'darwin',arch:'universal',kind:'macos-app-zip',channel:'faravan',bundleId:'com.faravan.app',url:'https://example.test/mac.zip'}]));
  const script=new URL('../packaging/sign-update.mjs',import.meta.url).pathname,out=join(root,'out');
  const child=spawn(process.execPath,[script,'--tarball',join(root,'linux.tar.gz'),'--tarball-url','https://example.test/linux.tar.gz','--linux-channel','faravan','--version','0.1.0-preview.20261029.21','--key',join(root,'key.pem'),'--out',out,'--asset-map',join(root,'map.json')],{stdio:'ignore'});
  assert.equal(await new Promise(r=>child.once('exit',r)),0);
  const {verifyMacManifest}=await import('../lib/v1/self-update.mjs');
  const manifest=verifyMacManifest(await readFile(join(out,'update.json')),await readFile(join(out,'update.json.sig'),'utf8'),pub,'faravan');
  assert.equal(manifest.assets[0].size,archive.length);assert.equal(manifest.assets[0].url,'https://example.test/mac.zip');
});

test('restart reuses a verified stage and a cancelled helper cannot close the app',async t=>{
  const f=await fixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  const resumed=await f.make(),check=await resumed.check();await resumed.stage(check.manifest);assert.equal(f.counts().extracted,1);
  const ticket=await resumed.prepareHandoff({signal:new AbortController().signal,exclusive:async()=>()=>{}});assert.equal(ticket.ready,true);await ticket.cancel();
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.updater.prepareHandoff({signal:controller.signal,exclusive:async()=>()=>{}}));
  assert.equal(f.counts().prepared,1);assert.equal(await readFile(join(f.appPath,'Contents/MacOS/launcher'),'utf8'),'A');
});

test('a new signed payload for the same version replaces the previously staged ZIP',async t=>{
  const f=await fixture(t);
  assert.equal(await f.updater.tick({idle:false}),'staged');
  const archive=zip(false,'revised'); // Same size and same layout, independently signed bytes.
  const old=JSON.parse(f.signed.bytes), asset=old.assets[0];
  const next=buildSignedManifest({tarball:Buffer.from('legacy'),version:old.version,tarballUrl:old.tarball,privateKeyPem:f.priv,
    releasedAt:new Date(Date.parse(old.released)+1000),assets:[{...asset,archive}]});
  f.files.set('https://example.test/update.json',next.bytes);
  f.files.set('https://example.test/update.json.sig',Buffer.from(next.signature));
  f.files.set(asset.url,archive);
  let extractions=0;
  const updater=await f.make({extract:async(file,out)=>{
    extractions++;
    assert.deepEqual(await readFile(file),archive);
    await fakeBundle(join(out,'Faravan.app'),old.version,'C');
  }});
  const {manifest}=await updater.check();
  assert.equal(manifest.version,old.version);
  assert.notEqual(manifest.assets[0].sha256,asset.sha256);
  await updater.stage(manifest);
  assert.equal(extractions,1);
  assert.deepEqual(await readFile(join(f.home,'v1/macos-update-stage.zip')),archive);
  assert.equal(await readFile(join(f.appPath+'.next','Contents/MacOS/launcher'),'utf8'),'C');
  await updater.stage(manifest);
  assert.equal(extractions,1,'exact selected bytes are reused on the next stage call');
});


test('oversized and credential-bearing downloads refuse before extraction',async t=>{
  const f=await fixture(t);f.files.set('https://example.test/update.json',Buffer.alloc(512*1024+1));
  assert.equal(await f.updater.tick({idle:true}),'failed');assert.equal(f.counts().extracted,0);
  const bad=await f.make({manifestUrl:'https://user:secret@example.test/update.json'});
  await assert.rejects(bad.check(),{code:'bad_manifest'});assert.equal(f.counts().extracted,0);
});

test('a replaced staging directory cannot borrow an old signed receipt',async t=>{
  const f=await fixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  await rename(f.appPath+'.next',f.appPath+'.displaced');await fakeBundle(f.appPath+'.next','0.1.0-preview.20261029.21','B');
  await assert.rejects(f.updater.prepareHandoff({signal:new AbortController().signal,exclusive:async()=>()=>{}}),{code:'invalid_stage'});
  assert.equal(f.counts().prepared,0);assert.equal(await readFile(join(f.appPath,'Contents/MacOS/launcher'),'utf8'),'A');
});

test('handoff reconstructs a modified staged tree from the signed archive',async t=>{
  const f=await fixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  await writeFile(join(f.appPath+'.next','Contents/MacOS/launcher'),'tampered');
  const ticket=await f.updater.prepareHandoff({signal:new AbortController().signal,exclusive:async()=>()=>{}});
  assert.equal(await readFile(join(f.appPath+'.next','Contents/MacOS/launcher'),'utf8'),'B');
  assert.equal(f.counts().extracted,2);await ticket.cancel();
});

test('tampered retained archive refuses before a helper is started',async t=>{
  const f=await fixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  const path=join(f.home,'v1','macos-update-stage.zip'),bytes=await readFile(path);bytes[30]^=1;await writeFile(path,bytes,{mode:0o600});
  await assert.rejects(f.updater.prepareHandoff({signal:new AbortController().signal,exclusive:async()=>()=>{}}),{code:'bad_hash'});
  assert.equal(f.counts().prepared,0);assert.equal(f.counts().extracted,1);
});

test('a verified manifest object cannot be changed before staging',async t=>{
  const f=await fixture(t),{manifest}=await f.updater.check();manifest.version='0.1.0-preview.20261029.22';
  await assert.rejects(f.updater.stage(manifest),{code:'bad_signature'});assert.equal(f.counts().extracted,0);
});


test('HTTPS release redirects stay bounded and never downgrade',async t=>{
  const f=await fixture(t),seen=[];
  const fetch=async(url,options)=>{
    seen.push(url);assert.equal(options.redirect,'manual');
    const parsed=new URL(url);
    if(parsed.hostname==='example.test')return new Response(null,{status:302,headers:{location:'https://assets.test'+parsed.pathname}});
    const bytes=f.files.get('https://example.test'+parsed.pathname);return new Response(bytes??'',{status:bytes?200:404});
  };
  const redirected=await f.make({fetch});assert.equal(await redirected.tick({idle:true}),'handoff');
  assert.ok(seen.includes('https://assets.test/app.zip'));
  for(const location of ['http://assets.test/update.json','https://user:secret@assets.test/update.json']){
    const unsafe=await f.make({fetch:async()=>new Response(null,{status:302,headers:{location}})});
    await assert.rejects(unsafe.check(),{code:'bad_manifest'});
  }
  let calls=0;const loop=await f.make({fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location:'/loop'}});}});
  await assert.rejects(loop.check(),{code:'fetch_failed'});assert.ok(calls<=6);
});

test('a packaged Mac install path selects the Mac updater with or without a trailing slash, and a tarball install gets a slash-free dir',async t=>{
  const f=await fixture(t);
  for(const spelling of [f.installDir,f.installDir+'/']){
    const updater=await f.make({installDir:spelling});
    assert.equal(updater?.kind,'packaged-mac',spelling);assert.equal(updater.installDir,f.installDir);
  }
  const root=await mkdtemp(join(tmpdir(),'tarball-factory-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const tree=join(root,'lib','faravan');await mkdir(tree,{recursive:true});await writeFile(join(tree,'.installed-via'),'tarball');
  const updater=await updaterForInstall({home:join(root,'home'),env:{},installDir:tree+'/',platform:'linux'});
  assert.equal(updater.installDir,tree);
});

async function supersessionFixture(t,extra={}) {
  const f=await fixture(t);
  const {createMacUpdaterForInstall}=await import('../lib/v1/macos-update-factory.mjs');
  let version='0.1.0-preview.20261029.45';
  await writeFile(join(f.installDir,'VERSION'),'0.1.0-preview.20261029.44');
  function feed(value) {
    version=value;
    const archive=zip(),signed=buildSignedManifest({tarball:Buffer.from('legacy'),version,tarballUrl:'https://example.test/linux.tar.gz',privateKeyPem:f.priv,
      assets:[{platform:'darwin',arch:'universal',kind:'macos-app-zip',channel:'faravan',bundleId:'com.faravan.app',url:'https://example.test/app.zip',archive}]});
    f.files.set('https://example.test/update.json',signed.bytes);
    f.files.set('https://example.test/update.json.sig',Buffer.from(signed.signature));
  }
  feed(version);
  const make=(options={})=>createMacUpdaterForInstall({home:f.home,installDir:f.installDir,arch:'arm64',publicKey:f.pub,
    manifestUrl:'https://example.test/update.json',fetch:async url=>new Response(f.files.get(url)),
    extract:async(_file,out)=>fakeBundle(join(out,'Faravan.app'),version,version),
    verifyBundle:async(path,expected)=>(await readFile(join(path,'Contents/Resources/faravan/VERSION'),'utf8'))===expected,
    managedContext:()=>f.context,prepare:async options=>({ready:true,spec:options.spec,cancel:await options.exclusive()}),...extra,...options});
  return {...f,feed,make,updater:await make()};
}

test('busy .44 stages .45 then the next idle tick hands off .46',async t=>{
  const f=await supersessionFixture(t);
  assert.equal(await f.updater.tick({idle:false}),'staged');
  f.feed('0.1.0-preview.20261029.46');
  assert.equal(await f.updater.tick({idle:true}),'handoff');
  const ticket=await f.updater.prepareHandoff({exclusive:async()=>()=>{}});
  assert.equal(ticket.spec.version,'0.1.0-preview.20261029.46');
  assert.equal(ticket.spec.previousVersion,'0.1.0-preview.20261029.44');
  assert.equal(await readFile(join(f.appPath+'.next','Contents/Resources/faravan/VERSION'),'utf8'),ticket.spec.version);
  await ticket.cancel();
  const {createMacBundleTransaction}=await import('../lib/v1/macos-update-transaction.mjs');
  const transaction=createMacBundleTransaction({...ticket.spec,
    verifyBundle:async(path,expected)=>(await readFile(join(path,'Contents/Resources/faravan/VERSION'),'utf8'))===expected,
    quiescent:async()=>true,launch:async()=>({}),waitReady:async(_handle,identity)=>({...identity,authenticated:true}),
    stopOwnedLaunch:async()=>true,isNewer:(a,b)=>a>b,
    exchange:async(a,b)=>{const temp=a+'.exchange';await rename(a,temp);await rename(b,a);await rename(temp,b);}});
  assert.equal(await transaction.apply(),'committed');
  assert.equal(await readFile(join(f.installDir,'VERSION'),'utf8'),'0.1.0-preview.20261029.46');
});

test('crash after stage rename before receipt recovers the owned newer stage',async t=>{
  const f=await supersessionFixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  f.feed('0.1.0-preview.20261029.46');
  let crashed=false;
  const crashing=await f.make({afterStageRename:async()=>{crashed=true;throw Error('simulated crash');}});
  const {manifest}=await crashing.check();
  await assert.rejects(crashing.stage(manifest),/simulated crash/);
  assert.equal(crashed,true);
  const resumed=await f.make();assert.equal(await resumed.tick({idle:true}),'handoff');
  const ticket=await resumed.prepareHandoff({exclusive:async()=>()=>{}});
  assert.equal(ticket.spec.version,'0.1.0-preview.20261029.46');await ticket.cancel();
});

test('supersession never deletes an unknown next directory',async t=>{
  const f=await supersessionFixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  f.feed('0.1.0-preview.20261029.46');assert.equal(await f.updater.tick({idle:false}),'staged');
  await rename(f.appPath+'.next',f.appPath+'.saved');
  await mkdir(f.appPath+'.next');await writeFile(join(f.appPath+'.next','unknown'),'keep');
  f.feed('0.1.0-preview.20261029.47');
  assert.equal(await f.updater.tick({idle:true}),'failed');
  assert.equal(await readFile(join(f.appPath+'.next','unknown'),'utf8'),'keep');
});

test('supersession refuses a substituted saved archive or receipt',async t=>{
  for(const target of ['archive','receipt']) {
    const f=await supersessionFixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
    f.feed('0.1.0-preview.20261029.46');assert.equal(await f.updater.tick({idle:false}),'staged');
    const before=await lstat(f.appPath+'.next');
    if(target==='archive')await writeFile(join(f.home,'v1','macos-update-stage.zip'),'substitute',{mode:0o600});
    else {
      const path=join(f.home,'v1','macos-update-stage.json'),receipt=JSON.parse(await readFile(path,'utf8'));
      receipt.signature='substitute';await writeFile(path,JSON.stringify(receipt),{mode:0o600});
    }
    f.feed('0.1.0-preview.20261029.47');assert.equal(await f.updater.tick({idle:true}),'failed');
    assert.equal((await lstat(f.appPath+'.next')).ino,before.ino);
    assert.equal(await readFile(join(f.appPath+'.next','Contents/Resources/faravan/VERSION'),'utf8'),'0.1.0-preview.20261029.46');
  }
});

test('an interrupted removal of the old stage is finished by the next tick',async t=>{
  const f=await supersessionFixture(t);assert.equal(await f.updater.tick({idle:false}),'staged');
  f.feed('0.1.0-preview.20261029.46');
  // A read-only directory makes the recursive removal stop part-way, like a crash during it.
  const sub=join(f.appPath+'.next','Contents','Helpers');await chmod(sub,0o555);
  assert.equal(await f.updater.tick({idle:false}),'failed');
  await chmod(sub,0o755);
  assert.equal(await f.updater.tick({idle:false}),'staged');
  assert.equal(await readFile(join(f.appPath+'.next','Contents/Resources/faravan/VERSION'),'utf8'),'0.1.0-preview.20261029.46');
  f.feed('0.1.0-preview.20261029.47');assert.equal(await f.updater.tick({idle:false}),'staged');
  assert.ok(!(await readdir(join(f.home,'v1'))).some(name=>name.endsWith('.pending')),'no stage intent is left behind');
});

test('a feed without this installation\'s asset reads as current when it offers nothing newer',async t=>{
  const f=await fixture(t,{badTarget:true});
  await writeFile(join(f.installDir,'VERSION'),'0.1.0-preview.20261029.21');
  assert.equal(await f.updater.tick({idle:true}),'current');assert.equal(f.counts().extracted,0);
});

test('the Mac release mark refuses future-dated and older releases, and is kept under home/v1',async t=>{
  const f=await fixture(t);
  const markPath=join(f.home,'v1','update.json');
  const release=(version,released)=>{
    const asset={platform:'darwin',arch:'universal',kind:'macos-app-zip',channel:'faravan',bundleId:'com.faravan.app',url:'https://example.test/app.zip',archive:zip()};
    const signed=buildSignedManifest({tarball:Buffer.from('legacy'),version,releasedAt:new Date(released),tarballUrl:'https://example.test/linux.tar.gz',privateKeyPem:f.priv,assets:[asset]});
    f.files.set('https://example.test/update.json',signed.bytes);f.files.set('https://example.test/update.json.sig',Buffer.from(signed.signature));
  };
  const mark=async()=>JSON.parse(await readFile(markPath,'utf8')).accepted;
  release('0.1.0-preview.20261029.22','2030-01-01T00:00:00.000Z');
  await assert.rejects(f.updater.check(),{code:'bad_manifest'});
  assert.equal(await readFile(markPath,'utf8').catch(()=>null),null);
  release('0.1.0-preview.20261029.21','2026-10-19T09:00:00.000Z');
  assert.equal((await f.updater.check()).manifest.version,'0.1.0-preview.20261029.21');
  assert.equal((await mark()).version,'0.1.0-preview.20261029.21');
  assert.equal((await mark()).channel,'faravan');
  release('0.1.0-preview.20261029.21','2026-10-18T09:00:00.000Z');
  await assert.rejects(f.updater.check(),{code:'metadata_rollback'});
  release('0.1.0-preview.20261029.20','2026-10-20T09:00:00.000Z');
  await assert.rejects(f.updater.check(),{code:'metadata_rollback'});
  assert.equal((await mark()).version,'0.1.0-preview.20261029.21');
});

test('a Mac check is not blocked while a stage or handoff holds the install lock',async t=>{
  const f=await fixture(t);
  const {acquireProcessLock}=await import('../lib/v1/lock.mjs');
  const held=await acquireProcessLock(f.appPath+'.update.lock',{timeoutMs:0});
  try{assert.equal((await f.updater.check()).manifest.version,'0.1.0-preview.20261029.21');}
  finally{held();}
});

test('a Mac release mark from another channel is ignored, so this channel still updates',async t=>{
  const f=await fixture(t);
  await mkdir(join(f.home,'v1'),{recursive:true});
  await writeFile(join(f.home,'v1','update.json'),JSON.stringify({accepted:{version:'0.5.0',released:'2026-10-01T00:00:00.000Z',channel:'faravan',parts:3}}));
  assert.equal((await f.updater.check()).manifest.version,'0.1.0-preview.20261029.21');
});

for(const phase of ['committed','rolled-back'])test(`stale ${phase} journal does not report a failed update check`,async t=>{
  const f=await fixture(t);
  const journal={schema:1,id:'11111111-1111-1111-1111-111111111111',appPath:f.appPath,home:f.home,channel:'faravan',bundleId:'com.faravan.app',version:'0.1.0-preview.20261029.19',previousVersion:'0.1.0-preview.20261029.18',phase};
  await writeFile(f.appPath+'.update-journal.json',JSON.stringify(journal),{mode:0o600});
  const service=createUpdateService({updater:f.updater});
  await service.tick({idle:false});
  assert.equal(service.status().state,'staged');
  assert.deepEqual(JSON.parse(await readFile(f.appPath+'.update-journal.json','utf8')),journal);
});

test('J4-5 managed update stops the verified coordinator and cancellation restores wanted hosting',async t=>{
  const f=await fixture(t),events=[],record={pid:123,owner:{start:'42'}};
  const hosts={record:async()=>record,stop:async value=>{assert.equal(value,record);events.push('stop');},start:async()=>events.push('start')};
  const updater=await f.make({hosts});assert.equal(await updater.tick({idle:true}),'handoff');
  const ticket=await updater.prepareHandoff({exclusive:async()=>()=>{}});
  assert.deepEqual(events,['stop']);await ticket.cancel();assert.deepEqual(events,['stop','start']);
});

test('Mac hosted handoff keeps helper readiness live and never restarts after uncertain cancellation',async t=>{
  const f=await fixture(t),events=[];let live=true;
  const hosts={record:async()=>({pid:123,owner:{}}),stop:async()=>events.push('stop'),start:async()=>events.push('start')};
  const updater=await f.make({hosts,prepare:async options=>{
    const release=await options.exclusive();return {get ready(){return live;},cancel:async()=>{await release();throw Object.assign(Error('helper still running'),{code:'ownership_unknown'});}};
  }});
  assert.equal(await updater.tick({idle:true}),'handoff');
  const ticket=await updater.prepareHandoff({exclusive:async()=>()=>{}});live=false;
  const ready=ticket.ready;await assert.rejects(ticket.cancel(),{code:'ownership_unknown'});
  assert.equal(ready,false);assert.deepEqual(events,['stop']);
});

test('R2 concurrent cancellation shares helper cessation and retries transient host restoration',async t=>{
  const f=await fixture(t);let stops=0,starts=0,releaseHelper;
  const helperDone=new Promise(resolve=>{releaseHelper=resolve;});
  const updater=await f.make({hosts:{record:async()=>({owner:{}}),stop:async()=>{},start:async()=>{if(++starts===1)throw Object.assign(Error('temporary read failure'),{code:'EIO'});}},
    prepare:async options=>{const release=await options.exclusive();return {ready:true,cancel:async()=>{stops++;await helperDone;await release();}};}});
  await updater.tick({idle:true});const ticket=await updater.prepareHandoff({exclusive:async()=>()=>{}});
  const first=ticket.cancel(),second=ticket.cancel();
  const results=Promise.allSettled([first,second]);releaseHelper();
  const answers=await results;
  assert.equal(first,second,'concurrent calls share the pending promise');
  assert.deepEqual(answers.map(x=>x.status),['rejected','rejected']);assert.equal(stops,1);assert.equal(starts,1);
  await ticket.cancel();assert.equal(stops,1);assert.equal(starts,2);
  await ticket.cancel();assert.equal(starts,2);
});

for(const phase of ['helper','hosting'])test('R2 cancellation does not retry '+(phase==='helper'?'uncertain cessation':'permanent restoration failure'),async t=>{
  const f=await fixture(t);let stops=0,starts=0;
  const updater=await f.make({hosts:{record:async()=>({owner:{}}),stop:async()=>{},start:()=>{starts++;throw Object.assign(Error('permission denied'),{code:'EACCES'});}},
    prepare:async options=>{const release=await options.exclusive();return {ready:true,cancel:async()=>{stops++;await release();if(phase==='helper')throw Object.assign(Error('cannot confirm stop'),{code:'ownership_unknown'});}};}});
  await updater.tick({idle:true});const ticket=await updater.prepareHandoff({exclusive:async()=>()=>{}});
  const first=ticket.cancel();await assert.rejects(first,{code:phase==='helper'?'ownership_unknown':'EACCES'});
  assert.equal(ticket.cancel(),first);await assert.rejects(ticket.cancel());assert.equal(stops,1);assert.equal(starts,phase==='helper'?0:1);
});

for(const [failure,cancelled] of [
  ['legacy_exposure_pending',false], ['host_stop_failed',false], ['cancelled',true], ['legacy_exposure_pending',true],
])test('managed Mac stop refusal reports only safe update guidance: '+failure+(cancelled?' while cancelled':''),async t=>{
  const f=await fixture(t),record={pid:123,owner:{start:'42'}};
  const signal=new AbortController();
  let stops=0;
  const hosts={record:async()=>record,stop:async value=>{
    assert.equal(value,record);stops++;
    if(cancelled) signal.abort();
    throw Object.assign(new Error('private provider detail /synthetic/saved/path'),{code:failure});
  },start:async()=>{}};
  const updater=await f.make({hosts}),service=createUpdateService({updater});
  assert.equal(await service.tick({idle:true}),'handoff');
  assert.equal(service.status().state,'staged');
  await assert.rejects(service.prepareHandoff({signal:signal.signal,exclusive:async()=>()=>{}}),{code:failure});
  assert.equal(stops,1);
  assert.equal(f.counts().prepared,0,'no helper was prepared or handed off');
  const view=service.status();
  assert.equal(view.state,'failed');
  assert.equal(view.candidate,'0.1.0-preview.20261029.21');
  assert.equal(await readFile(join(f.appPath,'Contents/MacOS/launcher'),'utf8'),'A');
  assert.equal(await readFile(join(f.appPath+'.next','Contents/MacOS/launcher'),'utf8'),'B');
  assert.doesNotMatch(JSON.stringify(view),/private provider detail|synthetic\/saved\/path/);
  if(failure==='legacy_exposure_pending'&&!cancelled) assert.equal(view.error,'Review the saved legacy exposure before trying the update again. Your current version keeps running.');
  else assert.equal(view.error,'The update could not start. Your current version keeps running.');
});

test('Mac installed updater reads early-build preference at startup',async t=>{
  const f=await fixture(t);await writeFile(join(f.home,'v1/app-settings.json'),JSON.stringify({earlyBuilds:true}));
  const requested=[];
  const updater=await f.make({manifestUrl:undefined,env:{},fetch:async url=>{requested.push(url);return new Response('',{status:404});}});
  await assert.rejects(updater.check());
  assert.equal(requested[0],'https://tnunamak.github.io/faravan-updates/candidate/update.json');
});
