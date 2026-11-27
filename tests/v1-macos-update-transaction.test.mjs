import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMacBundleTransaction} from '../lib/v1/macos-update-transaction.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mac-transaction-')); t.after(() => rm(root, {recursive:true, force:true}));
  const appPath = join(root, 'Faravan.app'), journalPath = join(root, 'journal.json'), events = [];
  async function bundle(path, version) {
    for (const file of ['launcher', 'helper', 'runtime']) { await mkdir(join(path, file), {recursive:true}); await writeFile(join(path, file, 'version'), version); }
  }
  await bundle(appPath, 'A'); await bundle(appPath + '.next', 'B');
  const contents = async path => Promise.all(['launcher','helper','runtime'].map(file => readFile(join(path,file,'version'),'utf8')));
  const callbacks = {
    verifyBundle: async (path, version) => (await contents(path)).every(v => v === version),
    quiescent: async () => {events.push('quiet'); return true;},
    launch: async (path, identity) => {events.push('launch:' + identity.version); return {identity};},
    waitReady: async (handle, identity) => {events.push('ready:' + identity.version); return {...identity, authenticated:true};},
    stopOwnedLaunch: async () => {events.push('stop'); return true;},
    isNewer: (a,b) => a > b,
    // Linux fixture only: the production callback uses Darwin's atomic exchange.
    exchange: async (a,b) => {const temp=a+'.test-exchange';await rename(a,temp);await rename(b,a);await rename(temp,b);},
    ...overrides,
  };
  const make = (extra = {}) => createMacBundleTransaction({appPath,journalPath,version:'B',previousVersion:'A',...callbacks,...extra});
  return {root,appPath,journalPath,events,contents,make};
}

test('whole bundle swaps only after quiescence and commits after exact readiness', async t => {
  const f=await fixture(t); assert.equal(await f.make().apply(),'committed');
  assert.deepEqual(await f.contents(f.appPath), ['B','B','B']);
  assert.deepEqual(await f.contents(f.appPath+'.previous'), ['A','A','A']);
  assert.deepEqual(f.events,['quiet','launch:B','ready:B']);
  assert.equal(JSON.parse(await readFile(f.journalPath)).phase,'committed');
});

test('busy or unknown quiescence refuses without renaming', async t => {
  for (const answer of [false, undefined]) {
    const f=await fixture(t,{quiescent:async()=>answer});
    await assert.rejects(f.make().apply(), {code:'not_quiescent'});
    assert.deepEqual(await f.contents(f.appPath), ['A','A','A']);
    assert.deepEqual(await f.contents(f.appPath+'.next'), ['B','B','B']);
  }
});

test('retaining old bundle failure restores the complete old bundle and fences version', async t => {
  let calls=0; const f=await fixture(t,{rename:async (...args)=>{if(++calls===1)throw Error('rename failed'); return rename(...args);}});
  await assert.rejects(f.make().apply(), /rename failed/);
  assert.deepEqual(await f.contents(f.appPath), ['A','A','A']);
  assert.deepEqual(f.events,['quiet','quiet','launch:A','ready:A']);
  await assert.rejects(f.make().apply(), {code:'failed_version'});
});

test('crash after exchange recovers from journal and is idempotent', async t => {
  const f=await fixture(t,{afterRename:async phase=>{if(phase==='exchanging')throw Object.assign(Error('crash'),{simulatedCrash:true});}});
  await assert.rejects(f.make().apply(), /crash/);
  assert.equal(await f.make({afterRename:async()=>{}}).recover(),'rolled-back');
  assert.deepEqual(await f.contents(f.appPath),['A','A','A']);
  assert.equal(await f.make().recover(),'rolled-back');
  assert.deepEqual(f.events,['quiet','quiet','launch:A','ready:A']);
});

test('normal installed entry stays reachable if the helper dies during replacement',async t=>{
  const f=await fixture(t,{afterRename:async phase=>{if(phase==='exchanging')throw Object.assign(Error('helper died'),{simulatedCrash:true});}});
  await assert.rejects(f.make().apply(),/helper died/);
  // A helper that dies cannot run its own recovery. The normal installed path
  // must still contain a complete app that can start recovery on the next open.
  const versions=await f.contents(f.appPath);
  assert.ok(versions.every(v=>v==='A')||versions.every(v=>v==='B'));
});

test('wrong readiness stops owned candidate and restores all files before old launch', async t => {
  const f=await fixture(t,{waitReady:async (_h, id)=>({...id,version:id.rollback?'A':'wrong',authenticated:true})});
  await assert.rejects(f.make().apply(), {code:'not_ready'});
  assert.deepEqual(await f.contents(f.appPath),['A','A','A']);
  assert.deepEqual(f.events,['quiet','launch:B','stop','quiet','launch:A']);
  assert.equal(JSON.parse(await readFile(f.journalPath)).phase,'rolled-back');
});

test('unknown candidate cessation keeps journal and refuses destructive rollback', async t => {
  const f=await fixture(t,{waitReady:async()=>null,stopOwnedLaunch:async()=>false});
  await assert.rejects(f.make().apply(), {code:'ownership_unknown'});
  assert.deepEqual(await f.contents(f.appPath),['B','B','B']);
  assert.deepEqual(await f.contents(f.appPath+'.previous'),['A','A','A']);
  assert.equal(JSON.parse(await readFile(f.journalPath)).phase,'starting');
});

test('invalid stage, symlink and mismatched journal are refused', async t => {
  const f=await fixture(t);
  await writeFile(join(f.appPath+'.next','runtime','version'),'wrong');
  await assert.rejects(f.make().apply(), {code:'invalid_bundle'});
  await rm(f.appPath+'.next',{recursive:true}); await symlink(f.appPath,f.appPath+'.next');
  await assert.rejects(f.make().apply(), {code:'invalid_layout'});
  await writeFile(f.journalPath,JSON.stringify({schema:1,appPath:'/unrelated',version:'B',previousVersion:'A',id:'00000000-0000-0000-0000-000000000000',phase:'exchanging'}));
  await assert.rejects(f.make().recover(), {code:'invalid_journal'});
  assert.deepEqual(await f.contents(f.appPath),['A','A','A']);
});

test('concurrent apply cannot take the install lock', async t => {
  let release, entered; const started=new Promise(r=>{entered=r;}); const hold=new Promise(r=>{release=r;});
  const f=await fixture(t,{quiescent:async()=>{entered();await hold;return true;}});
  const first=f.make().apply(); await started;
  await assert.rejects(f.make().apply(), {code:'lock_busy'});
  release(); assert.equal(await first,'committed');
});

test('launch failure restores old bundle and a crash after retaining the old bundle recovers', async t => {
  const f=await fixture(t,{launch:async (_path,id)=>{if(!id.rollback)throw Error('launch failed');return {};}});
  await assert.rejects(f.make().apply(), /launch failed/);
  assert.deepEqual(await f.contents(f.appPath),['A','A','A']);
  const g=await fixture(t,{afterRename:async phase=>{if(phase==='retaining')throw Object.assign(Error('crash'),{simulatedCrash:true});}});
  await assert.rejects(g.make().apply(), /crash/);
  assert.equal(await g.make({afterRename:async()=>{}}).recover(),'rolled-back');
  assert.deepEqual(await g.contents(g.appPath),['A','A','A']);
});

test('missing and malformed journal cannot cause recovery renames', async t => {
  const f=await fixture(t); assert.equal(await f.make().recover(),'none');
  await writeFile(f.journalPath,'{');
  await assert.rejects(f.make().recover(),{code:'invalid_journal'});
  assert.deepEqual(await f.contents(f.appPath),['A','A','A']);
});

async function setVersion(path, value) {
  for (const name of ['launcher','helper','runtime']) await writeFile(join(path,name,'version'), value);
}

test('committed B permits C after verifying and retiring the owned A bundle', async t => {
  const f=await fixture(t); await f.make().apply();
  await mkdir(f.appPath+'.next');
  for (const name of ['launcher','helper','runtime']) await mkdir(join(f.appPath+'.next',name));
  await setVersion(f.appPath+'.next','C');
  assert.equal(await f.make({version:'C',previousVersion:'B'}).apply(),'committed');
  assert.deepEqual(await f.contents(f.appPath),['C','C','C']);
  assert.deepEqual(await f.contents(f.appPath+'.previous'),['B','B','B']);
});

test('failed B stays fenced but permits newer C', async t => {
  const f=await fixture(t,{waitReady:async (_h,id)=>({...id,version:id.version==='B'?'wrong':id.version,authenticated:true})});
  await assert.rejects(f.make().apply(),{code:'not_ready'});
  await assert.rejects(f.make().apply(),{code:'failed_version'});
  await setVersion(f.appPath+'.next','C');
  assert.equal(await f.make({version:'C',previousVersion:'A'}).apply(),'committed');
  assert.deepEqual(await f.contents(f.appPath),['C','C','C']);
});

test('old app readiness failure retains the recoverable journal', async t => {
  const f=await fixture(t,{waitReady:async()=>null});
  await assert.rejects(f.make().apply(),{code:'old_not_ready'});
  assert.deepEqual(await f.contents(f.appPath),['A','A','A']);
  assert.equal(JSON.parse(await readFile(f.journalPath)).phase,'restarting-old');
});

test('J4-4 interrupted previous removal resumes without verifying a partial bundle',async t=>{
  const f=await fixture(t);await f.make().apply();
  await mkdir(f.appPath+'.next',{recursive:true});
  for(const name of ['launcher','helper','runtime']){await mkdir(join(f.appPath+'.next',name));await writeFile(join(f.appPath+'.next',name,'version'),'C');}
  let interrupted=false;
  const remove=async(path,options)=>{await rm(join(path,'runtime'),{recursive:true});interrupted=true;throw Object.assign(Error('interrupted cleanup'),{code:'EIO'});};
  await assert.rejects(f.make({version:'C',previousVersion:'B',remove}).apply(),/interrupted cleanup/);
  assert.equal(interrupted,true);
  assert.equal(await f.make({version:'C',previousVersion:'B'}).apply(),'committed');
  assert.deepEqual(await f.contents(f.appPath),['C','C','C']);
});

test('J4-4 cleanup refuses a replacement previous directory',async t=>{
  const f=await fixture(t);await f.make().apply();
  await mkdir(f.appPath+'.next');for(const name of ['launcher','helper','runtime'])await mkdir(join(f.appPath+'.next',name));
  await setVersion(f.appPath+'.next','C');
  await assert.rejects(f.make({version:'C',previousVersion:'B',remove:async()=>{throw Error('cleanup failed');}}).apply(),/cleanup failed/);
  await rename(f.appPath+'.previous',f.appPath+'.saved');await mkdir(f.appPath+'.previous');
  await writeFile(join(f.appPath+'.previous','keep'),'unrelated');
  await assert.rejects(f.make({version:'C',previousVersion:'B'}).apply(),{code:'invalid_layout'});
  assert.equal(await readFile(join(f.appPath+'.previous','keep'),'utf8'),'unrelated');
});

test('preflight refuses an unowned previous bundle without touching anything', async t => {
  const f=await fixture(t); await mkdir(f.appPath+'.previous');
  await assert.rejects(f.make().preflight(), {code:'invalid_layout'});
  assert.deepEqual(f.events,[]);
  assert.deepEqual(await f.contents(f.appPath), ['A','A','A']);
  await assert.rejects(readFile(f.journalPath), {code:'ENOENT'});
});

test('preflight accepts a clean layout without a journal, a lock or a bundle check', async t => {
  const f=await fixture(t,{verifyBundle:async()=>{throw Error('preflight must not verify signatures');}});
  await f.make().preflight(); assert.deepEqual(f.events,[]);
});

test('a refusal before the first journal write is marked refused; one after is not', async t => {
  const a=await fixture(t); await mkdir(a.appPath+'.previous');
  await assert.rejects(a.make().apply(), e => e.code==='invalid_layout' && e.refused===true);
  const b=await fixture(t,{quiescent:async()=>false});
  await assert.rejects(b.make().apply(), e => e.code==='not_quiescent' && e.refused===true);
  const c=await fixture(t,{waitReady:async (_h,id)=>id.rollback?{...id,authenticated:true}:null});
  await assert.rejects(c.make().apply(), e => e.code==='not_ready' && e.refused===undefined);
});
