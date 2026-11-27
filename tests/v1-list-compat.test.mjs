import './helpers/no-browser.mjs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {buildSourceManifest} from '../lib/source-manifest.mjs';
import {createTar} from '../lib/tar-writer.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openV1Store } from '../lib/v1/store.mjs';
import { createV1Handler } from '../lib/v1/server.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { digest, privateKeyFromSeed } from '../lib/protocol/index.mjs';

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
    if(shape==='parent'){payload.parent={job_digest:'sha256:'+'a'.repeat(64),result_digest:'sha256:'+'b'.repeat(64)};payload.requirements.capabilities.push('parent_link_v1');}
    return (await owner.submitJob(payload)).jobDigest;
  }
  return { publish, owner, clientWith, dbPath:join(dir,'store.sqlite') };
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
