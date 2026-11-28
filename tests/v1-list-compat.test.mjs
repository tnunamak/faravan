import './helpers/no-browser.mjs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {buildSourceManifest} from '../lib/source-manifest.mjs';
import {createTar} from '../lib/tar-writer.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {randomUUID,sign,createHash} from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openV1Store } from '../lib/v1/store.mjs';
import { createV1Handler } from '../lib/v1/server.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { digest, canonicalize, privateKeyFromSeed, verifyEnvelope } from '../lib/protocol/index.mjs';

// A circle holds jobs of every generation. A client from before results_v1 has a closed validator
// that refuses a source-none or typed-result job with unsupported_version, and one refusal ends its
// whole listJobs(). The coordinator must therefore show such a client only the jobs it can read.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vectors = JSON.parse(readFileSync(join(root, 'docs/protocol/vectors/golden.json')));
const keys = vectors.keys.map(k => privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const ids = vectors.keys.map(k => k.fingerprint);
const circle = vectors.objects.job.envelope.payload.circle;
const roster = vectors.objects.roster.envelope;
const job = vectors.objects.job.envelope;
const historicalGolden=JSON.parse(readFileSync(join(root,'tests/fixtures/pre-run-request-golden-job.json')));
const T0 = Date.parse('2026-10-09T12:02:00Z') / 1000;
const clone = value => structuredClone(value);

// The real client and validator exactly as they were before results_v1, extracted into a disposable
// directory (never imported from the working tree, so later edits cannot change what "old" means).
async function legacyClientModule(t) {
  const frozen=JSON.parse(gunzipSync(readFileSync(join(root,'tests/fixtures/pre-results-client.json.gz'))));
  assert.equal(frozen.revision,'e54ef1d747eac5ed890a030475231022701ae120');
  const dir=mkdtempSync(join(tmpdir(),'pre-results-client-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for (const [file,source] of Object.entries(frozen.files)) {
    mkdirSync(join(dir,dirname(file)),{recursive:true});writeFileSync(join(dir,file),source);
  }
  return import(pathToFileURL(join(dir,'lib/v1/client.mjs')).href+'?'+randomUUID());
}

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'v1-list-compat-'));
  let time = T0, handler;
  const server = createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const store = openV1Store({ path: join(dir, 'store.sqlite'), origin, circle, rootFingerprint: ids[2], initialRoster: roster, clock: () => time });
  handler = createV1Handler({ store, blobDir: join(dir, 'blobs'), clock: () => time });
  t.after(async () => {
    handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const clientWith = (create, index = 0, options = {}) => {
    let snapshot = { current: roster, history: [], highestAcceptedEpoch: roster.payload.epoch, highestAcceptedDigest: digest(roster.payload) };
    return create({ origin, circle, deviceKey: keys[index], pinnedRootFingerprint: ids[2],
      rosterCache: { get: async () => snapshot, set: async value => { snapshot = value; } }, clock: () => time, retry: { maxAttempts: 1 }, ...options });
  };
  const owner = clientWith(createClient);
  const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
  function retainHistorical(signed) {
    const payload=signed.payload,job_digest=digest(payload),record={job_digest,signed,bytes:canonicalize(signed),author:ids[0],state:'queued',
      attempts_started:0,max_attempts:3,generation:0,current_attempt:null,result_digest:null,published_at:time,expiry:Date.parse(payload.expires_at)/1000};
    const db=new DatabaseSync(join(dir,'store.sqlite'));
    try{db.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run(job_digest,JSON.stringify(record));
      db.prepare('INSERT INTO job_queue(id,egress,ready,expiry,published,requirements) VALUES(?,?,?,?,?,?)').run(job_digest,payload.requirements.egress,0,record.expiry,time,JSON.stringify(payload.requirements));}finally{db.close();}
    return job_digest;
  }
  async function publish(shape) {
    time += 1;
    const prompt = await owner.uploadArtifact(Buffer.from('prompt ' + time), 'text/plain');
    const payload = { ...clone(job.payload), prompt, roster_epoch: roster.payload.epoch, intent_id: randomUUID(),
      created_at: iso(time), expires_at: iso(time + 3600) };
    if (shape === 'legacy'||shape==='parent') payload.source = { kind: 'archive', artifact: await owner.uploadArtifact(Buffer.from('src ' + time), 'application/gzip') };
    else if(['source_manifest_v1','working_directory_v1','filtered_git_v1','budget_v1'].includes(shape)) {
      const tar=createTar([{name:'packages/app/note.txt',data:Buffer.from('fixture'),type:'0',mode:0o644}]);
      payload.source={kind:'archive',artifact:await owner.uploadArtifact(gzipSync(tar),'application/gzip')};
      payload.requirements={...payload.requirements,capabilities:[shape]};
      if(shape==='source_manifest_v1')payload.source_manifest=buildSourceManifest(tar);
      if(shape==='working_directory_v1')payload.working_directory='packages/app';
      if(shape==='budget_v1')payload.budget_v1={max_list_usd:5};
      if(shape==='filtered_git_v1')payload.source={kind:'git',url:'https://example.test/pinned',commit:'a'.repeat(40),object_format:'sha1'};
    } else {
      payload.source = { kind: 'none' }; payload.result = { kind: shape };
      payload.requirements = { ...payload.requirements, capabilities: ['results_v1'] };
    }
    if(shape!=='auto')payload.requirements.model=clone(historicalGolden.job.payload.requirements.model);
    delete payload.runRequest;
    payload.requirements.capabilities=payload.requirements.capabilities.filter(cap=>cap!=='run_request_v1');
    if(shape==='auto'){delete payload.result;payload.source={kind:'archive',artifact:await owner.uploadArtifact(Buffer.from('src '+time),'application/gzip')};payload.auto_run_v1={intent:'cheapest'};delete payload.requirements.model;payload.requirements={...payload.requirements,capabilities:['auto_run_v1']};}
    if(shape==='parent'){payload.parent={job_digest:'sha256:'+'a'.repeat(64),result_digest:'sha256:'+'b'.repeat(64)};payload.requirements.capabilities.push('parent_link_v1');}
    // Historical bytes are loaded from disk, never admitted through the new-submission API.
    const signed={payload,signature:{algorithm:'Ed25519',key_id:ids[0],value:sign(null,
      Buffer.concat([Buffer.from('faravan/job/v1\0'),createHash('sha256').update(canonicalize(payload)).digest()]),keys[0]).toString('base64url')}};
    return retainHistorical(signed);
  }
  return { publish, retainHistorical, owner, clientWith, dbPath:join(dir,'store.sqlite') };
}
const collect = async (client, options) => { const found = []; for await (const view of client.listJobs(options)) found.push(view.job_digest); return found; };



test('a results_v1 client lists every job, typed and legacy, across pages', async t => {
  const f = await fixture(t), modern = f.clientWith(createClient, 1);
  const all = []; for (const shape of ['legacy', 'message', 'files', 'legacy', 'message']) all.push(await f.publish(shape));
  for (const limit of [1, 2, 100]) assert.deepEqual(await collect(modern, { limit }), all, 'limit ' + limit);
});




async function preSourceClientModule(t) {
 const frozen=JSON.parse(gunzipSync(readFileSync(join(root,'tests/fixtures/pre-source-client.json.gz'))));
 assert.equal(frozen.revision,'048de8734b1250b16f378219586466d50c0908be');
 const dir=mkdtempSync(join(tmpdir(),'pre-source-client-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const [file,source] of Object.entries(frozen.files)){mkdirSync(join(dir,dirname(file)),{recursive:true});writeFileSync(join(dir,file),source);}
 return import(pathToFileURL(join(dir,'lib/v1/client.mjs')).href+'?'+randomUUID());
}
const offers=async(client,limit)=>{const found=[];for await(const view of client.listOffers({limit,waitSeconds:0}))found.push(view.job_digest);return found;};


test('budget visibility participates in the cursor view without changing source capability bindings',async t=>{
 const f=await fixture(t);let cursor;
 const transport=async(url,options)=>{
  const headers={...options.headers};
  const name=Object.keys(headers).find(key=>key.toLowerCase()==='faravan-client-capabilities');
  if(name)headers[name]=headers[name].split(',').filter(cap=>cap!=='budget_v1').join(',');
  const response=await fetch(url,{...options,headers});
  if(String(url).includes('/jobs?'))cursor??=(await response.clone().json()).next_cursor;
  return response;
 };
 const before=await f.publish('legacy'),budget=await f.publish('budget_v1'),after=await f.publish('legacy');
 const reader=f.clientWith(createClient,1,{fetch:transport});
 assert.deepEqual(await collect(reader,{limit:1}),[before,after]);assert.ok(cursor);
 assert.deepEqual(await collect(f.owner,{limit:1}),[before,budget,after]);
 await assert.rejects(collect(f.owner,{limit:1,cursor}),{code:'cursor_invalid'});
});

test('a stored historical job reads unchanged but the same job cannot be submitted anew',async t=>{
 const f=await fixture(t),digest=await f.publish('legacy');
 const view=await f.owner.getJob(digest);
 assert.equal(view.job.payload.runRequest,undefined,'reading history invents no request');
 const old=f.clientWith((await legacyClientModule(t)).createClient,0);
 await assert.rejects(old.submitJob(view.job.payload),{code:'invalid_request'});
 await assert.rejects(f.owner.submitJob(view.job.payload),{code:'invalid_run_request'});
 assert.equal((await f.owner.getJob(digest)).job_digest,digest);
});

test('a historical job already running before upgrade can still post its result',async t=>{
  const f=await fixture(t),jobDigest=await f.publish('legacy'),view=await f.owner.getJob(jobDigest);
  const attempt={attempt_id:randomUUID(),job_digest:jobDigest,generation:1,holder:ids[1],state:'active',
    claimed_at:new Date(T0*1000).toISOString().replace('.000Z','Z'),lease_expires_at:new Date((T0+1200)*1000).toISOString().replace('.000Z','Z'),
    execution_started_at:new Date(T0*1000).toISOString().replace('.000Z','Z'),execution_observed_at:null,reason:null,compute_stopped:false,stopped_at:null};
  const db=new DatabaseSync(f.dbPath);
  try{
    const row=JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(jobDigest).data);
    Object.assign(row,{state:'claimed',current_attempt:attempt.attempt_id,generation:1,attempts_started:1});
    db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row),jobDigest);
    db.prepare('INSERT INTO attempts(id,data,claimed_epoch) VALUES(?,?,?)').run(attempt.attempt_id,JSON.stringify(attempt),roster.payload.epoch);
  }finally{db.close();}
  const lender=f.clientWith(createClient,1),result=clone(vectors.objects.result.envelope.payload),at=new Date((T0+1)*1000).toISOString().replace('.000Z','Z');
  delete result.receipt.selection;
  Object.assign(result,{job_digest:jobDigest,attempt_id:attempt.attempt_id,generation:1,executor:ids[1],submitted_at:at,
    candidate:await lender.uploadArtifact(Buffer.from('historical result'),'application/gzip'),
    transcript:await lender.uploadArtifact(Buffer.from('{}\n'),'application/x-ndjson')});
  Object.assign(result.receipt,{source:view.job.payload.source,limits_applied:view.job.payload.requirements.limits,
    capabilities_applied:view.job.payload.requirements.capabilities,egress_applied:view.job.payload.requirements.egress,
    started_at:attempt.execution_started_at,finished_at:at,duration_ms:1000});
  assert.equal((await lender.completeAttempt(attempt,result)).status,'result-accepted');
  const finished=await f.owner.getJob(jobDigest);
  assert.equal(finished.state,'result-accepted');assert.equal(finished.job.payload.runRequest,undefined);
});

test('historical automatic-choice jobs stay readable without advertising new automatic runs',async t=>{
  const f=await fixture(t),id=await f.publish('auto');
  const view=await f.owner.getJob(id);
  assert.equal(view.job.payload.auto_run_v1.intent,'cheapest');
  assert.equal(view.job.payload.runRequest,undefined);
  assert.ok((await collect(f.owner)).includes(id));
});


test('the exact signed trunk model job verifies and reads unchanged while new model submissions are refused',async t=>{
  assert.equal(historicalGolden.revision,'dc3432854ea309e4f6595ae808906c6e0fce2150');
  assert.match(historicalGolden.warning,/TEST-ONLY/);
  const original=historicalGolden.job;
  assert.equal(verifyEnvelope('job',original,historicalGolden.publicKey).ok,true,'the signed trunk model restriction stays readable');
  const f=await fixture(t),id=f.retainHistorical(original);
  assert.deepEqual((await f.owner.getJob(id)).job,original);
  assert.ok((await collect(f.owner)).includes(id));
  await assert.rejects(f.owner.submitJob(clone(original.payload)),{code:'invalid_run_request'});
  const mixed=clone(job.payload);mixed.requirements.model=clone(original.payload.requirements.model);
  await assert.rejects(f.owner.submitJob(mixed),{code:'invalid_request'});
  assert.deepEqual((await f.owner.getJob(id)).job,original,'rejected new work leaves historical bytes intact');
});
