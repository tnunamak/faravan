import './helpers/no-browser.mjs';
import {superviseBound} from './helpers/supervise-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {superviseSandboxDeadline} from '../lib/sandbox-deadline-supervisor.mjs';

const name='wf-0123456789abcdef';
const deadline={sandbox_id:name,sbx_home:'/fixture/home',binary:'/fixture/sbx',deadline_at:1,deadline_clock:{version:1,boot_id:'fixture',boot_at:1}};
const complete=names=>({code:0,stdout:JSON.stringify(names.map(name=>({name}))),stderr:''});
const flaws={failed:{code:1},truncated:{truncated:true},killed:{killed:true},timeout:{timedOut:true},error:{errorCode:'EPIPE'},stderr:{stderr:'partial inventory'}};
function backendFixture({settled=true,before=complete([]),after=complete([]),saved}={}) {
  const row=saved??{...deadline,create:'dispatched',compute_created:settled,create_settled:settled,absent_since:0};
  let lists=0;const calls=[];
  const backend=Object.assign(Object.create(DockerSbxBackend.prototype),{
    _rowHomeMatches:()=>true,_watchInventoryCurrent:()=>false,_now:()=>1_000_000,sandboxDeadlines:{observed:()=>false},
    cleanupJournal:{authority:()=>({...row}),closed:()=>false,mark:(_row,facts)=>{Object.assign(row,facts);return true;}},
    _rowRun:async(_row,args)=>{calls.push(args);if(args[0]==='ls')return ++lists===1?before:after;
      if(args[0]==='secret')return {code:0,stdout:JSON.stringify({secrets:[],custom_secrets:[],shadowed_services:[],env_only_count:0}),stderr:''};
      if(args[0]==='policy')return {code:0,stdout:'{"rules":[]}',stderr:''};
      return {code:0,stdout:'',stderr:''};},
  });
  return {backend,row,calls,resolve:()=>backend._resolveCompute(row)};
}

for(const [label,flaw] of Object.entries(flaws)) {
  for(const stage of ['before','after'])test(`compute proof rejects ${label} ${stage} inventory`,async()=>{
    const f=backendFixture(stage==='before'?{before:{...complete([]),...flaw}}:{before:complete([name]),after:{...complete([]),...flaw}});
    const proof=await f.resolve();assert.equal(proof.removed,false,'partial listing is not absence proof');
  });
  test(`never-observed create cannot release its watch on ${label} inventory`,async()=>{
    const f=backendFixture({settled:false,before:{...complete([]),...flaw}});
    const proof=await f.resolve();assert.equal(proof.removed,false);assert.notEqual(proof.watching,true);
  });
  test(`deadline guard retains obligation on ${label} inventory`,async()=>{
    const states=[],stop=Error('held control completed');let sleeps=0;
    await assert.rejects(superviseBound(superviseSandboxDeadline,deadline,{clock:()=>({wall:2,boot_id:'fixture',boot_ms:2}),
      readRecord:()=>({create:'dispatched',create_settled:true}),publish:s=>states.push(s),
      run:async()=>({...complete([]),...flaw}),pause:async()=>{if(++sleeps===2)throw stop;}}),e=>e===stop);
    assert.equal(states.some(s=>s.state==='removed'),false);
  });
}

test('an ended create and complete empty inventory still retain the daemon obligation across restart',async()=>{
  const first=backendFixture({settled:false});
  const proof=await first.resolve();assert.equal(proof.removed,false);assert.equal(proof.watching,true);
  const saved=JSON.parse(JSON.stringify(first.row));
  const resumed=backendFixture({saved});
  assert.equal((await resumed.resolve()).removed,false,'client death and elapsed wait cannot fence the daemon');
  assert.equal(saved.create_settled,false);
});

test('restart during the absence wait retains the row and does not convert time into cessation',async()=>{
  const first=backendFixture({settled:false});first.backend._now=()=>50;
  const before=await first.resolve();assert.equal(before.removed,false);assert.notEqual(before.watching,true);
  const saved=JSON.parse(JSON.stringify(first.row));
  const restarted=backendFixture({saved});restarted.backend._now=()=>100;
  const middle=await restarted.resolve();assert.equal(middle.removed,false);assert.notEqual(middle.watching,true);
  restarted.backend._now=()=>1_000_000;
  const after=await restarted.resolve();assert.equal(after.removed,false);assert.equal(after.watching,true);
  assert.equal(saved.create_settled,false);
});

test('a name appearing after the absence wait is removed rather than assumed absent',async()=>{
  const f=backendFixture({settled:false});assert.equal((await f.resolve()).watching,true);
  const late=backendFixture({saved:JSON.parse(JSON.stringify(f.row)),before:complete([name]),after:complete([])});
  assert.equal((await late.resolve()).removed,true);
  assert.equal(late.calls.filter(args=>args[0]==='rm').length,1);
  assert.equal(late.row.create_settled,true);
});

test('a genuinely ceased row exits its guard; a held row does not',async()=>{
  const states=[];
  // Frozen change (lib/sandbox-deadline-supervisor.mjs, immutable startup binding): a record's own `compute_stopped` flag is a claim, not
  // proof. Only an exact-binding `gone` proof ends the guard, so a flagged row keeps its duty until the proof store holds one.
  const claimed=Error('claimed cessation retained');
  await assert.rejects(superviseBound(superviseSandboxDeadline,deadline,{readRecord:()=>({compute_stopped:true}),publish:s=>states.push(s),
    pause:async()=>{throw claimed;},run:async()=>complete([])}),e=>e===claimed);
  assert.equal(states.some(s=>s.state==='removed'),false);
  const stop=Error('held'),held=[];
  await assert.rejects(superviseBound(superviseSandboxDeadline,deadline,{clock:()=>({wall:2,boot_id:'fixture',boot_ms:2}),
    readRecord:()=>({create:'dispatched',compute_created:false,create_settled:false}),publish:s=>held.push(s),
    run:async()=>complete([]),pause:async()=>{throw stop;}}),e=>e===stop);
  assert.equal(held.some(s=>s.state==='removed'),false);
});

// Explicit daemon state is separate from client completion: the accepted
// create can materialize later even after a clean client exit or process death.
const initial=()=>({dispatch:false,client:'not-started',daemonPending:false,present:false,complete:false,waited:false,
  recordLock:true,nameReserved:true,watch:true,ceased:false});
const invariant=s=>!s.ceased||(!s.daemonPending&&!s.present);
const trace=()=>{
  let s=initial();const states=[s];
  const step=change=>{s={...s,...change};states.push(s);};
  step({dispatch:true,client:'live',daemonPending:true});
  step({client:'ended'}); // success, failure, timeout and death do not imply daemon cancellation
  step({recordLock:false}); // crash releases the process lock, not the durable reservation
  step({recordLock:true,complete:true,waited:true}); // restarted absence wait has elapsed
  return {states,s};
};
test('model rejects client-ended/elapsed-absence cessation and partial inventory mutants',()=>{
  const {s,states}=trace();assert.ok(states.every(invariant));
  const early={...s,client:'live',ceased:true};assert.equal(invariant(early),false);
  const elapsed={...s,ceased:true};assert.equal(invariant(elapsed),false);
  const partial={...s,complete:false,present:true,daemonPending:false,ceased:true};assert.equal(invariant(partial),false);
  // Name reservations prevent another dispatch, not this already accepted one.
  const late={...s,daemonPending:false,present:true};assert.equal(late.nameReserved,true);assert.equal(invariant(late),true);
  const removed={...late,present:false,complete:true,ceased:true};assert.equal(invariant(removed),true);
});


test('a previously validated complete background snapshot is not treated as a missing fresh command',async()=>{
  const f=backendFixture({settled:false});const snapshot={names:[]};
  f.backend._watchInventoryCurrent=value=>value===snapshot;
  const proof=await f.backend._resolveCompute(f.row,{watchInventory:snapshot});
  assert.equal(proof.removed,false);assert.equal(proof.background_watch,true);
  assert.equal(f.calls.filter(args=>args[0]==='ls').length,0);
});
