import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createWatchPoller} from '../lib/v1/sandbox-shared-watcher.mjs';
import {ownershipStatus} from '../lib/v1/sandbox-record-owner.mjs';
import {watchProofStore} from '../lib/v1/sandbox-watch-proofs.mjs';
import {fileSbx,receiptBackend,writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';

// A watched row closes on one thing: a saved proof that this sandbox, in this sandbox home and owner scope, for this create
// and watch generation, was seen present and then absent. Time, absence alone and any other proof never close it.
const ENV=['FARAVAN_SBX_HOME','FARAVAN_SCRATCH_ROOT'];
const NAME='wf-0123456789abcdef',READY=180000;
async function watchedRoot(t) {
  const root=await mkdtemp(join(tmpdir(),'wf-proofs-'));
  const saved=Object.fromEntries(ENV.map(name=>[name,process.env[name]]));
  process.env.FARAVAN_SBX_HOME=join(root,'sbx-home');process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
  await mkdir(process.env.FARAVAN_SBX_HOME,{recursive:true});await mkdir(process.env.FARAVAN_SCRATCH_ROOT,{recursive:true});
  t.after(async()=>{
    for(const name of ENV)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
    await rm(root,{recursive:true,force:true});
  });
  const sbx=fileSbx(join(root,'sbx')),directory=join(root,'profile','v1','sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:'job-proof',name:NAME,ownerScope:sandboxOwnerScope(),home:process.env.FARAVAN_SBX_HOME,
    scratchRoot:process.env.FARAVAN_SCRATCH_ROOT,created:false,settled:false});
  const first=JSON.parse(await readFile(join(directory,id+'.json'),'utf8'));
  await mkdir(first.scratch_dir,{recursive:true});
  const clock={at:Date.UTC(2026,10,7)},released=[];
  const storage={available:async()=>true,release:async name=>{released.push(name);}};
  const make=(run=sbx.run)=>receiptBackend(root,{...sbx,run},{now:()=>clock.at,storage});
  const row=async()=>JSON.parse(await readFile(join(directory,id+'.json'),'utf8'));
  const store=()=>watchProofStore({home:process.env.FARAVAN_SBX_HOME,owner:sandboxOwnerScope()});
  // The first check hands the name to the watcher and sees it absent.
  await make().reconcileOwnedSandboxes();
  return {root,sbx,directory,id,clock,released,make,row,store,scratch:first.scratch_dir};
}
const records=async directory=>(await readdir(directory).catch(()=>[])).filter(name=>name.endsWith('.json'));
const removals=sbx=>sbx.calls().filter(args=>args[0]==='rm');

test('recent absence and a proof for a different create cannot close a watched name',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  assert.equal(adopted.watch_state,'watch_adopted');
  assert.equal(Number.isFinite(f.store().matching(adopted).seen_absent_at),true,'the first empty listing is saved');
  assert.equal(f.store().gone(adopted),null);
  // Old absent creates now drain behind permanent fences. Keep these
  // wrong-binding proof cases inside the recent-absence window.
  f.clock.at+=READY;
  await f.make().reapCleanup();
  assert.equal((await records(f.directory)).length,1,'recent absence does not close the row');
  assert.equal(existsSync(f.scratch),true);assert.deepEqual(f.released,[]);
  // A proof of another generation, another create, another owner scope, another home or another name is not this row's.
  const proofs=join(process.env.FARAVAN_SBX_HOME,'.faravan-shared-watch','proofs.json');
  const good=JSON.parse(await readFile(proofs,'utf8')),base={...good.proofs[NAME],state:'gone',seen_present:true,gone_at:1};
  const variants={
    generation:{...good,proofs:{[NAME]:{...base,watch_generation:randomUUID()}}},
    create:{...good,proofs:{[NAME]:{...base,create_incarnation:randomUUID()}}},
    owner:{...good,owner:'another-owner',proofs:{[NAME]:base}},
    home:{...good,home:join(f.root,'other-home'),proofs:{[NAME]:base}},
    name:{...good,proofs:{'wf-fedcba9876543210':{...base,name:'wf-fedcba9876543210'}}},
  };
  for(const [label,data] of Object.entries(variants)) {
    await writeFile(proofs,JSON.stringify(data));
    await f.make().reapCleanup();
    assert.equal((await records(f.directory)).length,1,label+': the row stays');
    assert.equal(existsSync(f.scratch),true,label);assert.deepEqual(f.released,[],label);
  }
});

test('a saved proof closes the row after a restart, and the scratch and storage reservation are released with it',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  // The watcher saw the name, removed it and saw it gone; the app then stopped before it could clean up.
  await f.store().observe(adopted,true);await f.store().observe(adopted,false);
  assert.equal(f.store().gone(adopted).state,'gone');
  assert.equal((await records(f.directory)).length,1);
  await f.make().reapCleanup();
  assert.deepEqual(await records(f.directory),[]);
  assert.equal(existsSync(f.scratch),false);
  assert.deepEqual(f.released,[NAME]);
  assert.deepEqual(removals(f.sbx),[],'the proof is the removal: nothing is removed twice');
});

test('a proof never closes a newer generation of the same name',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await f.store().observe(adopted,true);await f.store().observe(adopted,false);
  // The name is handed over again under a new generation before the close runs.
  const newer={...adopted,watch_generation:randomUUID()};
  await writeFile(join(f.directory,f.id+'.json'),JSON.stringify(newer));
  await f.make().reapCleanup();
  assert.equal((await records(f.directory)).length,1,'the newer generation stays open');
  assert.equal(existsSync(f.scratch),true);assert.deepEqual(f.released,[]);
  assert.equal(JSON.parse(await readFile(join(f.directory,f.id+'.json'),'utf8')).watch_generation,newer.watch_generation);
});

test('the watcher and the app never act on one name at once, and the row closes once',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await f.sbx.run(['create','--name',NAME]);
  // One shared counter sees every removal either side runs.
  let active=0,peak=0;
  const run=async(args,options)=>{
    if(args[0]!=='rm')return f.sbx.run(args,options);
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,40));
    try{return await f.sbx.run(args,options);}finally{active--;}
  };
  const item={name:NAME,create_incarnation:adopted._cleanupId,watch_generation:adopted.watch_generation,state:'watch_adopted'};
  const poller=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:f.store(),
    run:async(args,options)=>{const result=await run(args,options);return args[0]==='ls'?{...result,code:result.code}:result;}});
  await Promise.all([poller.tick(),f.make(run).reapCleanup()]);
  await poller.drain();
  assert.equal(peak,1,'never two removals of one name in flight');
  // Whichever side removed it, a later check closes the row exactly once on the saved proof.
  await poller.tick();await poller.drain();
  // Changed for docs/design/SANDBOX-CLEANUP-RECOVERY.md "Ownership": the watcher holds the record until it saves the gone proof,
  // so the app cannot observe in between; its close runs after the proof. It used to run before the watcher's second pass.
  await f.make(run).reapCleanup();
  assert.deepEqual(await records(f.directory),[]);
  assert.deepEqual(f.released,[NAME],'storage is released once');
  assert.equal(existsSync(f.scratch),false);
  assert.deepEqual(f.sbx.read(),[]);
});

test('the watcher removes only a name it saw absent first, and records the listing before acting',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await rm(join(process.env.FARAVAN_SBX_HOME,'.faravan-shared-watch','proofs.json'),{force:true});
  await f.sbx.run(['create','--name',NAME]);
  const item={name:NAME,create_incarnation:adopted._cleanupId,watch_generation:adopted.watch_generation,state:'watch_adopted'};
  const poller=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:f.store(),run:f.sbx.run});
  await poller.tick();await poller.drain();
  assert.deepEqual(removals(f.sbx),[],'listed from the first look: no create receipt, no removal');
  assert.equal(f.store().matching(adopted).seen_present,true,'the sighting is saved');
  assert.equal(f.store().mayRemove(adopted),false);
});

test('the journal itself refuses to close a watched row on a receipt that has no matching proof',async t=>{
  const {createSandboxCleanupJournal}=await import('../lib/sandbox-cleanup-journal.mjs');
  const {writeFileSync,readFileSync,existsSync:exists,mkdirSync,mkdtempSync,rmSync}=await import('node:fs');
  const root=mkdtempSync(join(tmpdir(),'wf-journal-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(root,'journal'),scratch=join(root,'scratch');mkdirSync(directory);mkdirSync(scratch);
  const id=randomUUID(),row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'job-j',sandbox_id:NAME,
    scratch_dir:join(scratch,'wf-job-'+NAME+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:false,
    data_cleanup:'pending',policy_cleanup:'pending',exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),watch_challenge:randomUUID()};
  writeFileSync(join(directory,id+'.json'),JSON.stringify(row));
  // A backend that claims removal every time it is asked.
  let journal;
  journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>({removed:false}),
    resolveAdopted:async locked=>{journal.finish(locked,{removed:true,sbx_home:locked.sbx_home,scratch_removed:true,policy_removed:true});return {};}});
  await journal.reap();
  assert.equal(exists(join(directory,id+'.json')),true,'a removal claim without a proof closes nothing');
  const store=watchProofStore({home:root,owner:sandboxOwnerScope()});
  await store.observe(row,true);await store.observe(row,false);
  // The retry deferral is per journal; a fresh journal sees the saved proof at once.
  journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>({removed:false}),
    resolveAdopted:async locked=>{journal.finish(locked,{removed:true,sbx_home:locked.sbx_home,scratch_removed:true,policy_removed:true});return {};}});
  await journal.reap();
  assert.equal(exists(join(directory,id+'.json')),false,'the same claim closes it once the proof matches');
  assert.ok(JSON.parse(readFileSync(join(root,'.faravan-shared-watch','proofs.json'),'utf8')).proofs[NAME]);
});

// Review follow-ups. A listing is evidence only about the moment it was taken, so one that was taken before a later sighting
// of the same name must not undo that sighting.
const proofFile=()=>join(process.env.FARAVAN_SBX_HOME,'.faravan-shared-watch','proofs.json');
const manifestItem=row=>({name:NAME,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,state:'watch_adopted'});

test('an older empty listing never closes a sandbox that a newer listing saw present',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await rm(proofFile(),{force:true});
  // The permanent-name rule now permits removal. Refuse it here so this case
  // isolates sighting order without weakening any stale-result assertion.
  const run=f.sbx.run;f.sbx.run=(args,options)=>args[0]==='rm'?Promise.resolve({code:1,stdout:'',stderr:'synthetic refusal'}):run(args,options);
  let release;const delayed=new Promise(resolve=>{release=resolve;});
  const poller=createWatchPoller({read:()=>({names:[manifestItem(adopted)]}),publish:()=>{},proofs:f.store(),
    run:async args=>args[0]==='ls'?delayed:{code:0,stdout:'',stderr:''}});
  // The watcher's listing is taken first (it shows nothing) but its result arrives late.
  const pending=poller.tick();
  await f.sbx.run(['create','--name',NAME]);
  // Changed for docs/design/SANDBOX-CLEANUP-RECOVERY.md "Ownership": while the watcher holds the record the app cannot observe it.
  // The watcher's tenure ends here, and the app then saves the sighting as the new owner.
  poller.stop();await poller.drain();
  await f.make().reapCleanup();
  assert.equal(f.store().matching(adopted).seen_present,true,'the app saw the name present');
  release({code:0,stdout:'[]',stderr:''});await pending;await poller.drain();
  assert.equal(f.store().gone(adopted),null,'the older empty listing is not a gone proof');
  await f.make().reapCleanup();
  assert.equal((await records(f.directory)).length,1,'the row stays while the sandbox is listed');
  assert.deepEqual(f.sbx.read(),[NAME]);
  assert.equal(existsSync(f.scratch),true);assert.deepEqual(f.released,[]);
  poller.stop();
});

test('after a stale empty listing is dropped, a later empty listing still closes the row',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await rm(proofFile(),{force:true});
  let release;const delayed=new Promise(resolve=>{release=resolve;});let lists=0;
  const poller=createWatchPoller({read:()=>({names:[manifestItem(adopted)]}),publish:()=>{},proofs:f.store(),
    run:async args=>{if(args[0]!=='ls')return {code:0,stdout:'',stderr:''};return lists++===0?delayed:{code:0,stdout:'[]',stderr:''};}});
  const pending=poller.tick();
  // Changed for docs/design/SANDBOX-CLEANUP-RECOVERY.md "Ownership": the first watcher's tenure ends before another owner saves the
  // sighting (the record has one owner at a time), and a restarted watcher takes the later, ordered empty listing.
  poller.stop();await poller.drain();
  await f.store().observe(adopted,true);
  release({code:0,stdout:'[]',stderr:''});await pending;
  assert.equal(f.store().gone(adopted),null);
  const restarted=createWatchPoller({read:()=>({names:[manifestItem(adopted)]}),publish:()=>{},proofs:f.store(),run:async args=>args[0]==='ls'?{code:0,stdout:'[]',stderr:''}:{code:0,stdout:'',stderr:''}});
  await restarted.tick();await restarted.drain();restarted.stop();
  assert.equal(f.store().gone(adopted)?.state,'gone','the same empty result seen again, from a newer listing, is accepted');
});

test('the watcher never acts on a record while the app holds it, so one listing never feeds two removals',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await f.sbx.run(['create','--name',NAME]);
  let acted=false,release,entered;const gate=new Promise(resolve=>{release=resolve;}),owned=new Promise(resolve=>{entered=resolve;});
  // The app's listing shows the name and is held back. The record stays the app's for that whole action (design "Release rule:
  // the watcher holds a record per action").
  const run=async(args,options)=>{
    const result=await f.sbx.run(args,options);
    // Availability reads do not own this record. The per-action ownership
    // rule above still requires freezing only the app's owned listing.
    const owner=ownershipStatus(f.store().directory,NAME);
    if(args[0]==='ls'&&result.stdout.includes(NAME)&&!acted&&owner?.role==='app'&&owner.held){entered();await gate;}
    return result;
  };
  const poller=createWatchPoller({read:()=>({names:[manifestItem(adopted)]}),publish:()=>{},proofs:f.store(),run:f.sbx.run});
  const app=f.make(run).reapCleanup();
  await owned;
  await poller.tick();await poller.drain();acted=true;poller.stop();
  assert.equal(removals(f.sbx).length,0,'the watcher skips a record the app is acting on');
  release();await app;
  assert.equal(removals(f.sbx).length,1,'the name is removed once, by the actor that held the record');
});

test('a saved gone record without presence and absence evidence authorizes nothing and is kept',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  const good=JSON.parse(await readFile(proofFile(),'utf8'));
  const binding={name:NAME,create_incarnation:adopted._cleanupId,watch_generation:adopted.watch_generation};
  const shapes={
    'a state label alone':{...binding,state:'gone'},
    'a sighting without a time':{...binding,state:'gone',seen_present:true,gone_at:1},
    'an absence without a sighting':{...binding,state:'gone',gone_at:1,seen_absent_at:1},
    'an absence before the sighting':{...binding,state:'gone',seen_present:true,present_at:20,absent_at:10,gone_at:30},
  };
  for(const [label,entry] of Object.entries(shapes)) {
    const bytes=JSON.stringify({...good,proofs:{[NAME]:entry}});
    await writeFile(proofFile(),bytes);
    assert.equal(f.store().gone(adopted),null,label);
    await f.make().reapCleanup().catch(()=>{});
    assert.equal((await records(f.directory)).length,1,label+': the row stays');
    assert.equal(existsSync(f.scratch),true,label);assert.deepEqual(f.released,[],label);
    assert.equal(await readFile(proofFile(),'utf8'),bytes,label+': the record is kept for diagnosis');
  }
});

test('a row whose create identities disagree matches no proof, not even one for the other create',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  const other=randomUUID();
  // A complete gone proof for create `other`.
  const foreign={...adopted,_cleanupId:undefined,create_incarnation:other};
  await f.store().observe(foreign,true);await f.store().observe(foreign,false);
  assert.equal(f.store().gone(foreign)?.state,'gone');
  const confused={...adopted,create_incarnation:other};
  assert.notEqual(confused._cleanupId,other);
  assert.equal(f.store().gone(confused),null,'the row\'s own cleanup id decides, and the stale copy contradicts it');
  assert.equal(f.store().matching(confused),null);
  await assert.rejects(f.store().observe(confused,true),/binding is invalid/);
  const bytes=JSON.stringify({...adopted,create_incarnation:other});
  await writeFile(join(f.directory,f.id+'.json'),bytes);
  await f.make().reapCleanup().catch(()=>{});
  assert.equal(await readFile(join(f.directory,f.id+'.json'),'utf8'),bytes,'the malformed row is kept unchanged');
  assert.equal(existsSync(f.scratch),true);assert.deepEqual(f.released,[]);
});

test('the app cannot remove a name the watcher holds, so the name is removed once',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await f.sbx.run(['create','--name',NAME]);
  const store=f.store();let appRan=false,app;
  // The watcher lists the name present and saves that. Before it acts, the app takes the action lock, removes the name, sees it
  // gone and closes the row.
  const watched={...store,observe:async(...args)=>{
    const entry=await store.observe(...args);
    if(args[1]&&!appRan){appRan=true;app=f.make(f.sbx.run).reapCleanup();await app;}
    return entry;
  }};
  const poller=createWatchPoller({read:()=>({names:[manifestItem(adopted)]}),publish:()=>{},proofs:watched,run:f.sbx.run});
  await poller.tick();await poller.drain();
  assert.equal(appRan,true);
  // Changed for docs/design/SANDBOX-CLEANUP-RECOVERY.md "Ownership": the app that ran while the watcher held the record removed
  // nothing; the watcher alone removed the name. The row closes on the watcher's proof afterwards. It used to be removed by the app.
  assert.equal(removals(f.sbx).length,1,'the name is removed once, by the watcher that holds the record');
  assert.deepEqual(f.sbx.read(),[]);
  await poller.tick();await poller.drain();poller.stop();await poller.drain();
  await f.make(f.sbx.run).reapCleanup();
  assert.equal(removals(f.sbx).length,1);
  assert.deepEqual(f.released,[NAME],'the row closed once');
});

test('the watcher removes a present name it saw absent first, after its own check under the lock',async t=>{
  const f=await watchedRoot(t),adopted=await f.row();
  await f.sbx.run(['create','--name',NAME]);
  const listings=()=>f.sbx.calls().filter(args=>args[0]==='ls').length,before=listings();
  const poller=createWatchPoller({read:()=>({names:[manifestItem(adopted)]}),publish:()=>{},proofs:f.store(),run:f.sbx.run});
  await poller.tick();await poller.drain();poller.stop();
  assert.equal(removals(f.sbx).length,1);
  assert.deepEqual(f.sbx.read(),[]);
  assert.equal(listings()-before,2,'one listing for the pass and one under the lock before the removal');
});
