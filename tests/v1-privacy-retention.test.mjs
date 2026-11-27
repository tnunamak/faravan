import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID, sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as p from '../lib/protocol/index.mjs';
import {openV1Store} from '../lib/v1/store.mjs';
import {createV1Handler} from '../lib/v1/server.mjs';

// Public TEST-ONLY signing vectors; no provider, browser or external service.
const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
assert.match(golden.warning,/TEST-ONLY/);
const keys=golden.keys.map(k=>p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex')));
const fp=keys.map(k=>p.fingerprint(p.exportPublicKey(k)));
const vectors=Object.fromEntries(Object.entries(golden.objects).map(([k,v])=>[k,v.envelope]));
const circle=vectors.job.payload.circle,origin='https://coordinator.example';
const base=origin+'/v1/circles/'+circle,DAY=86400;
const iso=n=>new Date(n*1000).toISOString().replace('.000Z','Z');

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'faravan-privacy-retention-'));
  const path=join(dir,'coordinator.sqlite'),blobDir=join(dir,'blobs');
  mkdirSync(blobDir,{mode:0o700});
  let now=Date.parse('2026-10-09T12:00:00Z')/1000,epoch=7,handler,interval;
  const store=openV1Store({path,circle,origin,rootFingerprint:fp[2],initialRoster:vectors.roster,clock:()=>now});
  const raw=new DatabaseSync(path);
  // Keep synthetic scratch for inspection, as requested for this audit fix.
  t.after(()=>{handler?.close();raw.close();store.close();});
  const ctx=(device,method,route,body,overrides={})=>({proof:p.buildRequestProof({circle,roster_epoch:epoch,method,
    target:base+route,body:method==='GET'?Buffer.alloc(0):Buffer.from(p.canonicalize(body)),
    content_type:method==='GET'?'':'application/json',artifact_media_type:'',
    idempotency_key:method==='POST'?randomUUID():'',created:now,nonce:randomBytes(16).toString('base64url'),...overrides},keys[device])});
  function upload(bytes,media_type) {
    const ref={digest:p.digestBytes(bytes),bytes:bytes.length,media_type};
    const proof=p.buildRequestProof({circle,roster_epoch:epoch,method:'PUT',target:base+'/artifacts/'+ref.digest.slice(7),
      body_digest:ref.digest,content_length:ref.bytes,content_type:'application/octet-stream',artifact_media_type:media_type,
      idempotency_key:'',created:now,nonce:randomBytes(16).toString('base64url')},keys[0]);
    const reservation=store.reserveArtifact(fp[0],ref,{proof});
    writeFileSync(join(blobDir,ref.digest.slice(7)),bytes,{mode:0o600});
    store.commitArtifact(fp[0],reservation.reservation_id,ref,ctx(0,'POST','/artifact-reservations/'+reservation.reservation_id+'/commit',ref));
    return ref;
  }
  const f={store,raw,path,blobDir,ctx,get now(){return now;},advance(seconds){now+=seconds;},
    publish(idempotencyKey=randomUUID()) {
      const source={kind:'archive',artifact:upload(Buffer.from('synthetic source'),'application/gzip')};
      const prompt=upload(Buffer.from('synthetic prompt'),'text/plain');
      const job=p.signEnvelope('job',{...vectors.job.payload,source,prompt,intent_id:randomUUID(),
        created_at:iso(now),expires_at:iso(now+3600)},keys[0]);
      store.publishJob(job,ctx(0,'POST','/jobs',job,{idempotency_key:idempotencyKey}));return job;
    },
    refreshRoster() {
      epoch++;
      const roster=p.signEnvelope('roster',{...vectors.roster.payload,epoch,issued_at:iso(now),valid_until:iso(now+7*DAY)},keys[2]);
      store.installRoster(roster,ctx(0,'PUT','/roster',roster));
    },
    host() {
      handler=createV1Handler({store,blobDir,clock:()=>now,maintenanceTiming:{
        setInterval(fn,ms){assert.equal(ms,60000);interval=fn;return {unref(){}};},
        clearInterval(){interval=null;}
      }});
      return handler;
    },
    tick(){assert.equal(typeof interval,'function','host schedules collection without a request');interval();},
    get scheduled(){return typeof interval==='function';}
  };
  return f;
}

test('privacy M2: late expiry observation uses the actual job expiry as its end',t=>{
  const f=fixture(t),job=f.publish(),digest=p.digest(job.payload);
  f.advance(2*DAY);f.refreshRoster();
  const retained=f.store.getRetention(fp[0],digest,f.ctx(0,'GET','/jobs/'+digest.slice(7)+'/retention'));
  assert.equal(retained.ended_at,job.payload.expires_at);
  assert.equal(retained.retained_until,iso(Date.parse(job.payload.expires_at)/1000+30*DAY));
});

test('privacy M2: host startup collects jobs first observed more than 30 days after expiry',t=>{
  const f=fixture(t),job=f.publish();
  f.advance(31*DAY);f.host();
  assert.equal(f.raw.prepare('SELECT count(*) n FROM jobs').get().n,0);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM job_tombstones').get().n,1);
  assert.equal(existsSync(join(f.blobDir,job.payload.prompt.digest.slice(7))),false);
});

test('privacy M2: online host collects at the deadline without requests and stops its timer',t=>{
  const f=fixture(t),job=f.publish(),handler=f.host();
  f.advance(3600+30*DAY-1);f.tick();
  assert.equal(f.raw.prepare('SELECT count(*) n FROM jobs').get().n,1,'retained until the deadline');
  assert.ok(existsSync(join(f.blobDir,job.payload.prompt.digest.slice(7))));
  f.advance(1);f.tick();
  assert.equal(f.raw.prepare('SELECT count(*) n FROM jobs').get().n,0);
  assert.equal(existsSync(join(f.blobDir,job.payload.prompt.digest.slice(7))),false);
  handler.close();assert.equal(f.scheduled,false);
});

test('privacy M2: startup repairs an expiry previously recorded at observation time',t=>{
  const f=fixture(t),job=f.publish(),digest=p.digest(job.payload);
  const row=JSON.parse(f.raw.prepare('SELECT data FROM jobs WHERE id=?').get(digest).data);
  row.state='expired';row.terminal_reason='job_expired';row.terminal_at=f.now+31*DAY;
  f.raw.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row),digest);
  f.advance(31*DAY);f.host();
  assert.equal(f.raw.prepare('SELECT count(*) n FROM jobs').get().n,0);
  const tomb=JSON.parse(f.raw.prepare('SELECT data FROM job_tombstones WHERE id=?').get(digest).data);
  assert.equal(tomb.terminal_at,Date.parse(job.payload.expires_at)/1000);
});

test('privacy M3: retirement minimizes signed-job replays and keeps retries compatible',t=>{
  const f=fixture(t),publishKey=randomUUID(),claimKey=randomUUID(),job=f.publish(publishKey),digest=p.digest(job.payload);
  const route='/jobs/'+digest.slice(7),ad={harnesses:['codex'],models:['example-model'],capabilities:['patch-output'],egress:['provider-only'],
    enforced_limits:Object.keys(job.payload.requirements.limits),max_limits:job.payload.requirements.limits};
  const claimBody={advertisement:ad,lease_seconds:120};
  const claim=()=>f.store.claimJob(fp[1],digest,ad,f.ctx(1,'POST',route+'/claim',claimBody,{idempotency_key:claimKey}),120);
  claim();
  const cancellation=p.signEnvelope('cancellation',{schema:'faravan.cancellation.v1',circle,job_digest:digest,
    author:fp[0],roster_epoch:7,created_at:iso(f.now),reason:'synthetic cancellation'},keys[0]);
  f.store.cancel(cancellation,f.ctx(0,'POST',route+'/cancel',cancellation));
  assert.equal(f.raw.prepare("SELECT count(*) n FROM idempotency WHERE instr(response,'faravan.job.v1')>0").get().n,2);
  f.store.deleteJob(fp[0],digest,f.ctx(0,'POST',route+'/delete',{}));
  const fullJobCopies=()=>f.raw.prepare("SELECT count(*) n FROM idempotency WHERE instr(response,'faravan.job.v1')>0").get().n;
  assert.equal(fullJobCopies(),0,'neither original POST response keeps the job envelope');
  const retry=()=>f.store.publishJob(job,f.ctx(0,'POST','/jobs',job,{idempotency_key:publishKey}));
  assert.deepEqual(retry().job,job,'publication retry reconstitutes the envelope from the supplied body');
  assert.deepEqual(retry(),retry(),'original key remains idempotent');
  assert.deepEqual(f.store.publishJob(job,f.ctx(0,'POST','/jobs',job)).job,job,'fresh-key retry uses the tombstone');
  assert.equal(fullJobCopies(),0,'retrying must not put the signed job back into replay storage');
  assert.throws(claim,e=>e instanceof p.ProtocolError&&e.code==='job_terminal');
  assert.throws(claim,e=>e instanceof p.ProtocolError&&e.code==='job_terminal');
  assert.equal(f.raw.prepare('SELECT count(*) n FROM jobs').get().n,0);
});

test('host refuses an independently signed manifest containing excluded paths',t=>{
  const f=fixture(t),original=f.publish(),payload=structuredClone(original.payload);
  payload.intent_id=randomUUID();payload.requirements.capabilities=['source_manifest_v1'];
  payload.source_manifest={schema:'faravan.source-manifest.v1',archive_digest:payload.source.artifact.digest,
    file_count:0,total_bytes:0,packed_bytes:payload.source.artifact.bytes,files:[],files_truncated:false,
    not_sent:[{path:'private/.env',reason:'credentials'}],not_sent_count:1,not_sent_truncated:false,check:'filename-rules-only'};
  const bytes=Buffer.concat([Buffer.from('faravan/job/v1\0'),Buffer.from(p.digest(payload).slice(7),'hex')]);
  const job={payload,signature:{algorithm:'Ed25519',key_id:fp[0],value:sign(null,bytes,keys[0]).toString('base64url')}};
  assert.throws(()=>f.store.publishJob(job,f.ctx(0,'POST','/jobs',job)),e=>e.code==='invalid_request');
});

test('retirement removes a lapsed job queue entry and collection still succeeds',t=>{
  const f=fixture(t),job=f.publish(),digest=p.digest(job.payload),route='/jobs/'+digest.slice(7);
  const ad={harnesses:['codex'],models:['example-model'],capabilities:['patch-output'],egress:['provider-only'],
    enforced_limits:Object.keys(job.payload.requirements.limits),max_limits:job.payload.requirements.limits};
  const a=f.store.claimJob(fp[1],digest,ad,f.ctx(1,'POST',route+'/claim',{advertisement:ad,lease_seconds:120}),120).attempt;
  f.store.start(fp[1],a.attempt_id,a.generation,f.ctx(1,'POST','/attempts/'+a.attempt_id+'/start',{generation:a.generation}));
  f.store.observeExecutionStart(fp[1],a.attempt_id,a.generation,f.ctx(1,'POST','/attempts/'+a.attempt_id+'/observed-start',{generation:a.generation}));
  f.advance(121);f.store.deleteJob(fp[0],digest,f.ctx(0,'POST',route+'/delete',{}));
  f.advance(3600);assert.doesNotThrow(()=>f.store.collect());
  assert.equal(f.raw.prepare('SELECT count(*) n FROM job_queue WHERE id=?').get(digest).n,0);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM job_tombstones WHERE id=?').get(digest).n,1);
});

test('collection repairs a pre-existing orphaned queue row',t=>{
  const f=fixture(t),job=f.publish(),digest=p.digest(job.payload);
  f.raw.prepare('DELETE FROM jobs WHERE id=?').run(digest);
  f.advance(3601);assert.doesNotThrow(()=>f.store.collect());
  assert.equal(f.raw.prepare('SELECT count(*) n FROM job_queue WHERE id=?').get(digest).n,0);
});
