import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileSbx,receiptBackend,receiptJob} from './helpers/sandbox-receipt-fixture.mjs';

const REFUSAL='not signed in to docker';
async function world(t,{result={code:1,exited:true,stderr:REFUSAL},cancel=false,journalFailure=null}={}) {
  const root=await mkdtemp(join(tmpdir(),'docker-refusal-')),saved={};
  for(const [key,value] of Object.entries({FARAVAN_SBX_HOME:join(root,'sbx-home'),FARAVAN_SCRATCH_ROOT:join(root,'scratch')})){
    saved[key]=process.env[key];process.env[key]=value;await mkdir(value,{recursive:true});
  }
  t.after(async()=>{
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await rm(root,{recursive:true,force:true});
  });
  let land,listingFails=false,refuseRemoval=false,settled;
  const stop=new AbortController(),sbx=fileSbx(join(root,'inventory'),{create:async(_name,_args,_options,inventory)=>{
    land=inventory.materialize;return {code:result.code,stderr:result.stderr,materialize:false};
  }});
  const run=async(args,options)=>{
    if(listingFails&&args[0]==='ls'&&args[1]==='--json')return {code:1,stdout:'',stderr:'fixture daemon disconnected'};
    if(refuseRemoval&&args[0]==='rm')return {code:1,stdout:'',stderr:'fixture removal refused'};
    const response=await sbx.run(args,options);
    if(args[0]==='create'){
      if(cancel)stop.abort(Object.assign(Error('cancelled immediately after create result'),{code:'cancelled'}));
      return {...response,...result};
    }
    return response;
  };
  const at=1000000;
  const backend=receiptBackend(root,{run},{now:()=>at,monotonic:()=>at,
    deadlineClock:()=>({wall:at,boot_id:'fake-refusal-boot',boot_ms:at})}),mark=backend.cleanupJournal.mark.bind(backend.cleanupJournal);
  backend.cleanupJournal.mark=(handle,facts)=>{
    if(facts.create_settled===true&&facts.compute_stopped===true){
      if(journalFailure==='throw')throw Error('fixture journal write failed');
      if(journalFailure==='false')return false;
      const written=mark(handle,facts);settled=backend.cleanupJournal.authority(handle);return written;
    }
    return mark(handle,facts);
  };
  const failure=await backend.prepare(receiptJob(),{signal:stop.signal}).then(()=>assert.fail('create must fail'),error=>error);
  assert.equal(sbx.created().length,1,'the fake CLI received the reserved create');
  return {root,backend,sbx,run,failure,get settled(){return settled;},late(){refuseRemoval=true;land();},failListing(){listingFails=true;}};
}

test('completed Docker refusal is durable and never-created even when cancellation follows the result',async t=>{
  const w=await world(t,{cancel:true});
  assert.equal(w.failure.code,'cancelled');
  assert.equal(w.backend.signInRefused(),true);
  assert.equal(w.settled.create_refused,true);
  assert.equal(w.settled.create_settled,true);assert.equal(w.settled.compute_stopped,true);assert.equal(w.settled.compute_created,false);
  assert.equal(w.failure.cleanup_receipt.removed,true);
  assert.equal(w.backend.cleanupStatus().records,0);
  assert.deepEqual(w.sbx.read(),[]);
});

test('a refused target stays free of cleanup debt after restart and a failed listing',async t=>{
  const w=await world(t);
  w.failListing();
  const restarted=receiptBackend(w.root,{run:w.run});
  assert.equal(restarted.signInRefused(),true);
  assert.equal((await restarted.runSbx(['ls','--json'])).code,1);
  await restarted.recoverSandboxDeadlines();await restarted.reapCleanup();
  assert.equal(restarted.cleanupStatus().state,'clear');assert.equal(restarted.cleanupStatus().records,0);
  assert.equal(restarted.deadlineRecoveryHold(),null);
});

for(const [label,result] of [
  ['create timeout',{code:1,exited:false,timedOut:true,errorCode:'ETIMEDOUT',stderr:REFUSAL}],
  ['transport killed',{code:137,exited:false,killed:true,signal:'SIGKILL',stderr:REFUSAL}],
  ['daemon disconnect after dispatch',{code:1,exited:false,errorCode:'ECONNRESET',stderr:REFUSAL}],
  ['same text without an actual exit',{code:1,stderr:REFUSAL}],
  ['name materializes late',{code:1,exited:false,timedOut:true,stderr:REFUSAL}],
])test(label+' retains cleanup debt instead of claiming never-created',async t=>{
  const w=await world(t,{result});
  assert.equal(w.settled,undefined);
  assert.notEqual(w.failure.cleanup_receipt.removed,true);
  assert.equal(w.backend.cleanupStatus().compute_cleanup_pending,1);
  if(label==='name materializes late'){
    w.late();await w.backend.reapCleanup();
    assert.equal(w.sbx.read().length,1,'late materialization remains present until removal is proven');
    assert.equal(w.backend.cleanupStatus().compute_cleanup_pending,1);
  }
  const restarted=receiptBackend(w.root,{run:w.run});
  assert.equal(restarted.cleanupStatus().compute_cleanup_pending,1,'hold survives restart');
});

for(const journalFailure of ['throw','false'])test('failed journal write ('+journalFailure+') preserves refusal and cleanup hold',async t=>{
  const w=await world(t,{journalFailure});
  assert.equal(w.backend.signInRefused(),true,'refusal is recorded before settlement is attempted');
  assert.equal(w.settled,undefined);
  assert.equal(w.backend.cleanupStatus().compute_cleanup_pending,1);
  assert.notEqual(w.failure.cleanup_receipt.removed,true);
});
