import './no-browser.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openV1Store } from '../../lib/v1/store.mjs';
import { createV1Handler } from '../../lib/v1/server.mjs';
import { createClient } from '../../lib/v1/client.mjs';
import * as p from '../../lib/protocol/index.mjs';
import { lenderFixture } from './v1-lender-fixture.mjs';
export async function realLenderFixture(t,options={}) {
  const f=await lenderFixture(t,options),dir=await mkdtemp(join(tmpdir(),'v1-lender-real-'));
  const vectors=JSON.parse(readFileSync(new URL('../../docs/protocol/vectors/golden.json',import.meta.url)));
  const keys=vectors.keys.map(k=>p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex')));
  // memberStore:true adds the lender's own member store (owner-offline topology): a second real store and handler at its
  // own origin, with the lender's roster entry recording that origin, trusted by both stores and every client.
  let memberServer,memberOrigin,memberHandler,memberStore;
  let server,handler,store;
  const memberRequests=[];
  t.after(async()=>{
    const failures=[];
    const clean=async action=>{try{await action();}catch(error){failures.push(error);}};
    await clean(()=>f.stop?.());
    for(const [ownedHandler,ownedServer,ownedStore] of [[handler,server,store],[memberHandler,memberServer,memberStore]]) {
      await clean(()=>ownedHandler?.close?.());
      await clean(()=>ownedServer?.closeAllConnections());
      await clean(()=>ownedServer?.listening?new Promise((resolve,reject)=>
        ownedServer.close(error=>error?reject(error):resolve())):undefined);
      await clean(()=>ownedStore?.close());
    }
    await clean(()=>rm(dir,{recursive:true,force:true}));
    if(failures.length) {
      const [primary,...others]=failures;
      if(others.length&&primary instanceof Error)primary.cleanupErrors=[...(primary.cleanupErrors??[]),...others];
      throw primary;
    }
  });
  if(options.memberStore===true) {
    memberServer=createServer((req,res)=>{
      const proof=JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url'));
      memberRequests.push({url:req.url,key:req.headers['idempotency-key'],bodyDigest:proof.payload.body_digest});
      if(options.memberIntercept?.(req,res)===true)return;
      memberHandler(req,res);
    });
    memberServer.listen(0,'127.0.0.1');await once(memberServer,'listening');
    memberOrigin='http://127.0.0.1:'+memberServer.address().port;
  }
  // members:true adds keys[3] as a second lender. The root key re-signs the roster, so the store and clients trust it.
  // Long-running restart replays cross the golden roster's seven-day lifetime.
  const golden=options.rosterValidUntil?p.signEnvelope('roster',{...vectors.objects.roster.envelope.payload,
    valid_until:options.rosterValidUntil},keys[2]):vectors.objects.roster.envelope;
  let roster=options.members===true?p.signEnvelope('roster',{...golden.payload,members:[...golden.payload.members,
    {key_id:vectors.keys[3].fingerprint,public_key:vectors.keys[3].public_key,joined_epoch:golden.payload.epoch}]},keys[2]):golden;
  if(memberOrigin)roster=p.signEnvelope('roster',{...roster.payload,members:roster.payload.members.map(member=>
    member.key_id===vectors.keys[1].fingerprint?{...member,origin:memberOrigin}:member)},keys[2]);
  const circle=roster.payload.circle;
  const requests=[];
  server=createServer((req,res)=>{
    const proof=JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url'));
    requests.push({url:req.url,key:req.headers['idempotency-key'],bodyDigest:proof.payload.body_digest});
    if(options.intercept?.(req,res)===true)return;
    handler(req,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const seconds=()=>Math.floor(f.clock.now()/1000);
  store=openV1Store({path:join(dir,'store.sqlite'),origin,circle,
    rootFingerprint:vectors.keys[2].fingerprint,initialRoster:roster,clock:seconds});
  handler=createV1Handler({store,blobDir:join(dir,'blobs'),clock:seconds});
  if(memberServer) {
    memberStore=openV1Store({path:join(dir,'member.sqlite'),origin:memberOrigin,circle,
      rootFingerprint:vectors.keys[2].fingerprint,initialRoster:roster,clock:seconds});
    memberHandler=createV1Handler({store:memberStore,blobDir:join(dir,'member-blobs'),clock:seconds});
  }
  function clientAt(index,at) {
    let saved={current:roster,history:[],highestAcceptedEpoch:roster.payload.epoch,highestAcceptedDigest:p.digest(roster.payload)};
    return createClient({origin:at,circle,deviceKey:keys[index],pinnedRootFingerprint:vectors.keys[2].fingerprint,
      rosterCache:{get:async()=>saved,set:async v=>{saved=v;}},clock:seconds,retry:{maxAttempts:1}});
  }
  const client=index=>clientAt(index,origin);
  const owner=client(0),lender=client(1);
  await lender.heartbeat({boot:'fixture-accounts',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
    agents:[{adapter:f.adapters[0].spec.harness_id,readiness:'ready',models:['example-model'],per_job_max_minutes:2}],
    capabilities:['run_request_v1'],accounts:f.runOptions.runAccounts()});
  if(options.offers!==true)delete lender.listJobs;
  async function submit() {
    const payload=structuredClone(f.job.payload);
    payload.intent_id=randomUUID();
    payload.prompt=await owner.uploadArtifact(Buffer.from('Synthetic real HTTP regression'),'text/plain');
    return (await owner.submitJob(payload)).jobDigest;
  }
  Object.assign(f,{client:lender,clientFor:client,owner,store,storePath:join(dir,'store.sqlite'),realRequests:requests,submit,origin});
  if(memberStore) {
    const memberOwner=clientAt(0,memberOrigin);
    f.member={origin:memberOrigin,store:memberStore,requests:memberRequests,owner:memberOwner,client:index=>clientAt(index,memberOrigin)};
    await f.member.client(1).heartbeat({boot:'fixture-accounts',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
      agents:[],capabilities:['run_request_v1'],accounts:f.runOptions.runAccounts()});
    // One signed request carried to each named store: the same envelope and prompt bytes, so every store holds the identical job.
    f.publish=async({designated=false,at=['incumbent','member'],text='Synthetic dual-authority regression'}={})=>{
      const payload=structuredClone(f.job.payload);
      payload.intent_id=randomUUID();
      if(designated) {
        payload.designated_member=vectors.keys[1].fingerprint;
        payload.requirements.capabilities=[...new Set([...(payload.requirements.capabilities??[]),'designated_member_v1'])];
      }
      const owners={incumbent:owner,member:memberOwner};let digest;
      for(const name of at) {
        payload.prompt=await owners[name].uploadArtifact(Buffer.from(text),'text/plain');
        digest=(await owners[name].submitJob(payload)).jobDigest;
      }
      return digest;
    };
  }
  let heartbeatSeq=0;
  f.refreshAccountHeartbeat=async()=>{
    const heartbeat={boot:'fixture-accounts',seq:++heartbeatSeq,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
      agents:[],capabilities:['run_request_v1'],accounts:f.runOptions.runAccounts()};
    await lender.heartbeat(heartbeat);
    if(f.member)await f.member.client(1).heartbeat(heartbeat);
  };
  if(options.publish!==false)f.jobDigest=await submit();
  if(options.exposeTeardown)f.teardownResources={handler,server,dir};
  return f;
}
