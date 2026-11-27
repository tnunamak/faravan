import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {createJobMetaStore} from '../lib/v1/job-meta.mjs';

const digest='sha256:'+'a'.repeat(64),circle={id:'synthetic-transcript-circle'};
const attempt={attempt_id:'a-long-synthetic-attempt',job_digest:digest,holder:'synthetic-holder',generation:1,state:'active'};
async function setup(t,overrides={}) {
  const home=await mkdtemp(join(tmpdir(),'faravan-transcript-read-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const counts={clients:0,jobs:0,live:0},view={job_digest:digest,state:'claimed',current_attempt:attempt};
  const client={getJob:async()=>{counts.jobs++;return view;},fetchLiveTranscript:async()=>{counts.live++;return {text:'Real projected output',available:true};},...overrides};
  const device={keyId:'synthetic-author',selectCircle:async()=>circle,listCircles:async()=>[circle],
    intentStore:()=>({list:async()=>[{jobDigest:digest}]}),client:async()=>{counts.clients++;return client;}};
  return {ops:createJobOperations({device,home}),counts,client,view,meta:createJobMetaStore(join(home,'v1')),input:{digest,circle:circle.id}};
}

test('transcript state selects one client and starts job and relay reads together',{timeout:5000},async t=>{
  const job=Promise.withResolvers(),relay=Promise.withResolvers(),both=Promise.withResolvers(),started=[];
  const begin=name=>{started.push(name);if(started.length===2)both.resolve();};
  const f=await setup(t,{getJob:()=>{begin('job');return job.promise;},fetchLiveTranscript:()=>{begin('relay');return relay.promise;}});
  await f.meta.record(digest,{title:'Preserved observation',prompt:'A task',circle:circle.id});
  const reading=f.ops.transcriptState(f.input);
  await both.promise;
  assert.deepEqual(started,['job','relay']);assert.equal(f.counts.clients,1);
  job.resolve(f.view);relay.resolve({text:'The live record',available:true});
  assert.deepEqual(await reading,{state:'claimed',relay:{text:'The live record',available:true},relayError:null});
  assert.deepEqual((await f.meta.get(digest)).runs,[attempt],'the optimized read still retains job history');
});

test('a lender with a local buffer makes no relay read',async t=>{
  const f=await setup(t);
  assert.deepEqual(await f.ops.transcriptState(f.input,{includeLive:false}),{state:'claimed',relay:null,relayError:null});
  assert.deepEqual(f.counts,{clients:1,jobs:1,live:0});
});

test('job authorization failure wins over a successful live read',async t=>{
  const error=Object.assign(new Error('Denied'),{code:'not_found'}),f=await setup(t,{getJob:async()=>{throw error;}});
  await assert.rejects(f.ops.transcriptState(f.input),cause=>cause===error);
  assert.equal(f.counts.live,1);
});

for(const code of ['host_too_old','not_found','network'])test('active relay failure remains available to the app policy: '+code,async t=>{
  const error=Object.assign(new Error(code),{code}),f=await setup(t,{fetchLiveTranscript:async()=>{throw error;}});
  const result=await f.ops.transcriptState(f.input);
  assert.equal(result.state,'claimed');assert.equal(result.relay,null);assert.equal(result.relayError,error);
});

for(const failed of [false,true])test('a completed job discards retained live output and remembers the verified attempt: '+failed,async t=>{
  const f=await setup(t,{fetchLiveTranscript:async()=>{if(failed)throw new Error('Live relay is unavailable');return {text:'Old live output',available:true};}});
  f.view.state='result-accepted';f.view.current_attempt={...attempt,state:'completed'};
  assert.deepEqual(await f.ops.transcriptState(f.input),{state:'result-accepted',relay:null,relayError:null});
  let bound;
  f.client.fetchTranscript=async(_digest,options)=>{bound=options.attempt;return Buffer.from('Signed archive');};
  assert.equal((await f.ops.fetchTranscript(f.input)).toString(),'Signed archive');
  assert.deepEqual(bound,f.view.current_attempt);assert.equal(f.counts.jobs,1,'verification reuses the independently observed attempt');
  f.view.current_attempt={...attempt,holder:'conflicting-holder'};
  await assert.rejects(f.ops.transcriptState(f.input),{code:'stale_attempt'});
});


test('finished metadata and authorization failures never wait for an irrelevant live read',{timeout:5000},async t=>{
  const relay=Promise.withResolvers(),f=await setup(t,{fetchLiveTranscript:()=>relay.promise});
  try {
    f.view.state='result-accepted';
    assert.equal((await f.ops.transcriptState(f.input)).state,'result-accepted');
    const error=Object.assign(new Error('Denied'),{code:'not_found'});
    f.client.getJob=async()=>{throw error;};
    await assert.rejects(f.ops.transcriptState(f.input),cause=>cause===error);
  } finally {relay.resolve({text:'Irrelevant retained output',available:true});}
});
