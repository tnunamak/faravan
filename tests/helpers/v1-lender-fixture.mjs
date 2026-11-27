import './no-browser.mjs';
import { HOST_CAPABILITIES } from '../../lib/v1/versions.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../../lib/v1/client.mjs';
import { legacyProxyHarness } from './legacy-proxy-harness.mjs';
import * as p from '../../lib/protocol/index.mjs';
import { resultArchive } from './v1-journey.mjs';
import { guestExec, collectGuest } from './git-guest.mjs';

// Synthetic public vectors only; no developer account, sandbox, provider or model.
const vectors = JSON.parse(readFileSync(new URL('../../docs/protocol/vectors/golden.json', import.meta.url)));
const keys = vectors.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const ids = vectors.keys.map(k => k.fingerprint);
const pubs = vectors.keys.map(k => k.public_key);
const roster = vectors.objects.roster.envelope;
const ref = (bytes, media_type) => ({ digest: p.digestBytes(bytes), bytes: bytes.length, media_type });
export const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
// 8 s, not 2 s: under the full parallel suite a real-HTTP lender step can
// take several seconds; the deadline only matters when a test is failing.
export async function until(check, label='expected condition', ms=30000) {
  const deadline=Date.now()+ms;
  while(!check()) { assert.ok(Date.now()<deadline, 'Timed out: '+label); await new Promise(r=>setTimeout(r,2)); }
}
export function fakeClock() {
  let time=Date.parse('2026-10-09T12:02:00Z'), next=0;
  const timers=new Map();
  return {
    now:()=>time,
    setTimeout(fn,ms) { const id=++next; timers.set(id,{at:time+ms,fn}); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end=time+ms;
      for(;;) {
        const ready=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!ready) break;
        time=ready[1].at; timers.delete(ready[0]); ready[1].fn();
      }
      time=end;
    },
    pending:()=>[...timers.values()].map(v=>v.at-time)
  };
}
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
function json(res,value,status=200) {
  const body=Buffer.from(p.canonicalize(value));
  res.writeHead(status,{'content-type':'application/json','content-length':body.length});res.end(body);
}
function problem(res,code,status=409) {
  const body=Buffer.from(p.canonicalize({type:'urn:faravan:problem:'+code,title:code,status,code,retryable:status===429||status>=500,outcome:'not_applied'}));
  res.writeHead(status,{'content-type':'application/problem+json','content-length':body.length});res.end(body);
}
export async function lenderFixture(t, options={}) {
  const clock=fakeClock(), root=await mkdtemp(join(tmpdir(),'faravan-lender-offline-'));
  const events=[], calls=[], requests=[], errors=[], strays=[], artifacts=new Map(), nonces=new Set();
  const execution=deferred(), entered=deferred();
  execution.promise.catch(()=>{});
  const prompt=Buffer.from('Synthetic task: write a greeting. No external execution.');
  const payload=structuredClone(vectors.objects.job.envelope.payload);
  const harness=options.harness??'codex';
  if(options.harness)payload.requirements.harness=[harness];
  payload.source={kind:'git',url:'https://github.com/example/synthetic.git',object_format:'sha1',commit:'1'.repeat(40)};
  payload.prompt=ref(prompt,'text/plain');
  payload.requirements.egress='internet';
  delete payload.requirements.model;
  payload.requirements.capabilities=[];
  payload.requirements.limits.wall_seconds=120;
  if(options.authorIndex!==undefined)payload.author=ids[options.authorIndex];
  options.mutateJob?.(payload);
  const job=p.signEnvelope('job',payload,keys[options.authorIndex??0]), jobDigest=p.digest(payload), circle=payload.circle;
  artifacts.set(payload.prompt.digest,prompt);
  let active={attempt_id:vectors.objects.result.envelope.payload.attempt_id,job_digest:jobDigest,
    generation:1,holder:ids[1],state:'active',claimed_at:iso(clock.now()),
    lease_expires_at:iso(clock.now()+120000),reason:null,compute_stopped:false,stopped_at:null,execution_started_at:null};
  let stopRequest=null,origin, claimed=false;
  const f={clock,root,events,calls,requests,errors,strays,artifacts,execution,entered,job,jobDigest,override:null,
    attempt:()=>structuredClone(active), result:null, dropCompleteAck:false};
  const server=createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const bytes=Buffer.concat(chunks), route=req.url.slice(('/v1/circles/'+circle).length);
      const body=req.headers['content-type']==='application/json'&&bytes.length?JSON.parse(bytes):null;
      // Only the lender device signs its requests. A request with no proof came from another client
      // that reached this port (ports are reused across test processes); answer it, record it, move on.
      if(req.headers['faravan-proof']===undefined){strays.push({method:req.method,url:req.url});res.writeHead(401);res.end();return;}
      const proof=JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url'));
      const verified=await p.verifyRequestProof(req.headers['faravan-proof'],{
        publicKey:pubs[1],now:()=>Math.floor(clock.now()/1000),
        expected:{circle,key_id:ids[1],roster_epoch:7,method:req.method,target:origin+req.url,
          body_digest:p.digestBytes(bytes),content_length:bytes.length,content_type:req.headers['content-type']??'',
          artifact_media_type:req.headers['faravan-media-type']??'',idempotency_key:req.headers['idempotency-key']??''},
        consumeNonce:async(key,nonce)=>{const id=key+nonce;if(nonces.has(id))return false;nonces.add(id);return true;}
      });
      assert.equal(verified.ok,true,JSON.stringify(verified));
      if(body)assert.equal(bytes.toString(),p.canonicalize(body));
      const record={req,res,route,body,bytes,proof,at:clock.now()};requests.push(record);
      if(f.override&&await f.override(record))return;
      if(route==='/capabilities')return json(res,{artifact_head:false,faravan:null,min_member:null,capabilities:options.hostCapabilities??[...HOST_CAPABILITIES]});
      if(route==='/roster')return json(res,roster);
      if(route==='/jobs/claim-next'){
        if(claimed||(body.exclude??[]).includes(jobDigest))return json(res,null);
        claimed=true;return json(res,{job_digest:jobDigest,job,attempt:active});
      }
      if(route.startsWith('/artifacts/')){
        const id='sha256:'+route.split('/')[2];
        if(req.method==='GET'){
          if(!artifacts.has(id))return problem(res,'artifact_not_found',404);
          const value=artifacts.get(id);res.writeHead(200,{'content-type':'application/octet-stream','content-length':value.length});return res.end(value);
        }
        assert.equal(p.digestBytes(bytes),id);artifacts.set(id,bytes);
        return json(res,ref(bytes,req.headers['faravan-media-type']));
      }
      if(route==='/attempts/'+active.attempt_id+'/stop-request'){
        if(req.method==='GET')return json(res,stopRequest);
        assert.equal(req.method,'POST');assert.equal(body.generation,active.generation);
        if(active.state!=='active')return problem(res,'job_terminal');
        if(!active.execution_started_at)return problem(res,'conflict');
        stopRequest??={attempt_id:active.attempt_id,job_digest:jobDigest,generation:active.generation,requested_at:iso(clock.now())};
        return json(res,stopRequest);
      }
      if(route==='/attempts/'+active.attempt_id)return json(res,active);
      if(route.endsWith('/start')){
        assert.equal(body.generation,active.generation);
        assert.equal(active.state,'active');
        active={...active,execution_started_at:active.execution_started_at??iso(clock.now())};
        return json(res,active);
      }
      if(route.endsWith('/observed-start')){
        assert.equal(body.generation,active.generation);
        assert.equal(typeof active.execution_started_at,'string');
        active={...active,execution_observed_at:active.execution_observed_at??iso(clock.now())};
        return json(res,active);
      }
      if(route.endsWith('/renew')){
        active={...active,lease_expires_at:iso(clock.now()+body.lease_seconds*1000)};return json(res,active);
      }
      if(route.endsWith('/release')||route.endsWith('/fail')){
        active={...active,state:route.endsWith('/release')?'released':'failed',reason:body.reason};return json(res,active);
      }
      if(route.endsWith('/stopped')){
        active={...active,compute_stopped:true,stopped_at:iso(clock.now())};return json(res,active);
      }
      if(route.endsWith('/complete')){
        assert.ok(active.execution_started_at,'completion requires acknowledged execution start');
        assert.equal(p.verifyEnvelope('result',body,pubs[1]).ok,true);
        if(f.result)assert.equal(p.canonicalize(f.result),p.canonicalize(body),'completion retry changed signed result');
        f.result=body;
        if(f.dropCompleteAck){f.dropCompleteAck=false;return req.socket.destroy();}
        return json(res,{job_digest:jobDigest,result_digest:p.digest(body.payload),attempt_id:active.attempt_id,
          generation:active.generation,accepted_at:iso(clock.now()),status:'result-accepted'});
      }
      // The optional progress channel: this fake coordinator behaves like one that does not have it.
      if(route.endsWith('/progress')||route.endsWith('/transcript'))return problem(res,'not_found',404);
      throw new Error('Unexpected fake v1 route: '+route);
    }catch(error){errors.push(error);if(!res.headersSent)problem(res,'invalid_request',400);else res.destroy();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  const client=createClient({origin,circle,deviceKey:keys[1],pinnedRootFingerprint:ids[2],
    rosterCache:{get:async()=>({current:roster,history:[],highestAcceptedEpoch:7,highestAcceptedDigest:p.digest(roster.payload)}),set:async()=>{}},
    clock:()=>Math.floor(clock.now()/1000),retry:{maxAttempts:2},sleep:async(ms,signal)=>signal?.throwIfAborted()});
  if(options.offers!==true)delete client.listJobs;
  const evidence={'api.example.test':'allowed'};
  const backend={
    sandboxOwnership:()=>({owner_scope:'f'.repeat(64),sbx_home:root}),
    ensureGuestRuntime:async()=>({node:process.execPath}),
    lenderCapabilities:()=>({available:true,backend_id:'fake',pinned_git:true,enforced_limits:Object.keys(payload.requirements.limits),
      max_limits:{...payload.requirements.limits,wall_seconds:600},egress:['internet','provider-only'],capabilities:['patch-output']}),
    admitJob(spec){calls.push(['admit',spec]);return options.admission??{ok:true,enforced_limits:['cpu','memory','wall','output','storage'],unenforced:[]};},
    async probeCapabilities(){calls.push(['probe']);return {available:true};},
    async prepare(spec){calls.push(['prepare',spec]);return {sandbox_id:'synthetic-only',scratch_dir:root,_entrypoint:spec.entrypoint,
      _execution:options.executionEvidence??{egress_evidence:evidence,enforced_limits:['cpu','memory','wall','output','storage'],unenforced:[]}};},
    // verify_v1 checks: a separate synthetic sandbox with its own empty workspace.
    async prepareCheck(agent){calls.push(['prepareCheck']);const dir=await mkdtemp(join(tmpdir(),'faravan-lender-check-'));
      t.after(()=>rm(dir,{recursive:true,force:true}));
      return {sandbox_id:'synthetic-check',scratch_dir:dir,_entrypoint:'true',_execution:{}};},
    async cloneGitSource(handle,source){calls.push(['clone',source]);options.onClone?.(handle,source);if(options.verifiedCommit!==false)handle._execution.verified_commit=options.verifiedCommit??source.commit;},
    async start(handle,opts={}){
      // Cloning is synthetic in this fixture; the real guest filtering path is
      // exercised by executor.test.mjs with an actual Git repository.
      if(handle._sourcePreparation&&handle._entrypoint.includes('FARAVAN_GIT_SOURCE_OK')){handle._lastExecStdout='FARAVAN_GIT_SOURCE_OK\n';return;}
      if(await guestExec(handle,handle._entrypoint))return;
      if(handle._entrypoint.startsWith('mkdir -p .wf-result')){calls.push(['pack']);return;}
      if(handle._entrypoint==='codex login status'){calls.push(['status']);return;}
      calls.push(['run']);await opts.onLaunchDurable?.();opts.onExecutionStarted?.();entered.resolve();
      // The guard reports a reading for every run it meters. This fake run consumes nothing, so its reading is zero.
      const lendingReading=opts.lendingBudget?{readings:[],limit_reached:false,using_overage:false,
        tokens:options.guardTokens??{input:0,cached_input:0,cache_write:0,output:0,reasoning_output:0},model:null,cost_usd:options.guardTokens?null:0,final:true}:null;
      if(lendingReading)opts.onMeter?.(lendingReading);
      await options.agent?.(handle.scratch_dir);
      if(options.hold)await execution.promise;
      if(options.runError)throw options.runError;
      handle._lastExecStdout=options.stdout??'{"type":"turn.completed","usage":{"input_tokens":13,"output_tokens":5}}\n';
      opts.onLog?.({stream:'stdout',chunk:Buffer.from(handle._lastExecStdout)});
      return lendingReading?{stop:null,meter:lendingReading}:undefined;
    },
    async collectDeclaredOutputs(handle,manifest){calls.push(['collect']);return await collectGuest(handle,manifest)??[{path:'.wf-result/result.tar.gz',bytes_content:resultArchive()}];},
    async cancel(){calls.push(['cancel']);execution.reject(Object.assign(new Error('synthetic cancellation'),{name:'AbortError'}));return {compute_stopped:true};},
    async destroy(){calls.push(['destroy']);return {removed:true};}
  };
  // Queue/runtime tests model the legacy host proxy; native file lending has its own refusal tests.
  const adapters=[{spec:legacyProxyHarness(harness),installed:true,signedIn:true,harnessVersion:'test-only',
    models:['example-model'],capabilities:[],...(options.run?{run:options.run}:{})}];
  let saved=options.saved??null;
  const saves=[];
  const policy={checkJobIsolation:async()=>({state:"pass"}),enabled:true,mode:'ask',idleOnly:false,dailyJobs:10,dailyMinutes:60,maxWallSeconds:300,
    leaseSeconds:120,renewMs:30000,pollMs:1000,legacyHoldMs:options.policy?.approvalTimeoutMs??30000,
    quota:()=>({provider:'claude',remaining:100,observedAt:clock.now()}),quotaReserve:10,
    storage:{get:async()=>saved,set:async(value)=>{saved=structuredClone(value);saves.push(saved);}},
    ...options.policy};
  if(policy.mode==='auto'&&policy.standingRules===undefined)policy.standingRules=[{id:'legacy-fixture-rule',circle,people:[job.payload.author],agents:[harness],maxWallSeconds:300,dailyJobs:10,weeklyJobs:70,dailyMinutes:60,weeklyMinutes:420,expiresAt:clock.now()+30*86400000}];
  // Keep legacy lender behavior tests on the current candidate contract. The fake exposes quota
  // readings through the candidate boundary; it does not emulate the durable pace50 adapter.
  const fixtureCandidate={
    registry:{bind(){},unbind(){}},
    async gate({provider,automatic=false}){
      const reading=typeof policy.quota==='function'?policy.quota():null;
      const fresh=reading&&reading.provider===provider&&Number.isFinite(reading.remaining)&&
        Number.isFinite(reading.observedAt)&&reading.observedAt<=clock.now()&&
        clock.now()-reading.observedAt<=(policy.quotaMaxAgeMs??60000);
      if(!fresh)return automatic?'quota_unknown':null;
      return reading.remaining<=policy.quotaReserve?'quota_reserve':null;
    },
    async reserve({provider,model,automatic=false}){
      const reason=await this.gate({provider,automatic});
      return reason?{ok:false,reason}:{ok:true,reservation:{provider,model},decision:{effort_max:null}};
    },
    // The durable candidate answers the final start admission; the fake's default is to admit. Tests that
    // deny or stall it override this method on the fixture's candidate.
    async admitStart(){return {ok:true,reason:null};},
    async started(){return {applied:true};},
    async recordCleanup(){return {applied:true};},
    async finish(){return {applied:true,metered:{model:null}};},
    async settle(){return {applied:true};},
  };
  policy.lendingRuntime??={candidate:fixtureCandidate};
  Object.assign(f,{client,backend,adapters,policy,saves,saved:()=>saved,evidence,
    json,problem,count:route=>requests.filter(r=>r.route.endsWith(route)).length});
  t.after(async()=>{try{await f.stop?.();}finally{server.closeAllConnections();await new Promise(r=>server.close(r));
    try{await f.policy.lendingRuntime?.close?.();}finally{await rm(root,{recursive:true,force:true});}}
    assert.deepEqual(errors,[],errors.map(e=>e.stack).join('\n'));});
  return f;
}
