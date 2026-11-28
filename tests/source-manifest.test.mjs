import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createTar} from '../lib/tar-writer.mjs';
import {buildSourceManifest} from '../lib/source-manifest.mjs';
import {filterSourceArchive} from '../lib/source-filter.mjs';
import {digestBytes} from '../lib/protocol/index.mjs';
test('privacy N1: excluded paths stay out of the shared manifest',()=>{
 const excluded='synthetic-confidential-project/.env.production';
 const tar=createTar([{name:'main.js',type:'0',mode:0o600,data:Buffer.from('synthetic source')},
  {name:excluded,type:'0',mode:0o600,data:Buffer.from('synthetic excluded contents')}]);
 const filtered=filterSourceArchive(tar),manifest=buildSourceManifest(filtered.buffer,{omitted:filtered.omitted});
 assert.deepEqual(filtered.omitted,[{path:excluded,reason:'credentials'}]);
 assert.equal(manifest.files.some(file=>file.path===excluded),false);
 assert.doesNotMatch(JSON.stringify(manifest),/synthetic-confidential-project|\.env\.production|synthetic excluded contents/);
 assert.deepEqual(manifest.not_sent,[{reason:'credentials',count:1}]);
});

test('privacy N1: omission summaries deduplicate paths and share fixed reasons only',()=>{
 const tar=createTar([{name:'main.js',type:'0',mode:0o600,data:Buffer.from('source')}]);
 const manifest=buildSourceManifest(tar,{omitted:[{path:'private/.env',reason:'credentials'},
  {path:'private/.env',reason:'credentials'},{path:'elsewhere/.env',reason:'credentials'},
  {path:'private/node_modules',reason:'not_source',kind:'directory'},{path:'private/other',reason:'a private filename'}]});
 assert.equal(manifest.not_sent_count,4);
 assert.deepEqual(manifest.not_sent,[{reason:'credentials',count:2},{reason:'not_source',count:1,kind:'directory'},{reason:'other',count:1}]);
 assert.equal(manifest.not_sent_truncated,false);
 assert.doesNotMatch(JSON.stringify(manifest),/private|elsewhere|node_modules/);
});
test('manifest describes the frozen filtered bytes, never source file contents',()=>{
 const tar=createTar([{name:'note.txt',type:'0',data:Buffer.from('hello'),mode:0o644}]);
 const manifest=buildSourceManifest(tar,{omitted:[{path:'.env',reason:'credentials'}]});
 assert.equal(manifest.archive_digest,digestBytes(gzipSync(tar)));
 assert.deepEqual(manifest.files,[{path:'note.txt',bytes:5}]);assert.equal(manifest.total_bytes,5);
 assert.equal(manifest.packed_bytes,gzipSync(tar).length);assert.equal(manifest.not_sent_count,1);
 assert.equal(manifest.check,'filename-rules-only');assert.doesNotMatch(JSON.stringify(manifest),/hello/);
});
test('large receipts retain exact totals with bounded file and exclusion lists',()=>{
 const tar=createTar(Array.from({length:1005},(_,i)=>({name:'file-'+i,type:'0',mode:0o644,data:Buffer.from('x')})));
 const omitted=Array.from({length:1005},(_,i)=>({path:'key'+i,reason:'credentials'}));
 const manifest=buildSourceManifest(tar,{omitted});
 assert.equal(manifest.file_count,1005);assert.equal(manifest.files.length,1000);assert.equal(manifest.files_truncated,true);
 assert.equal(manifest.not_sent_count,1005);assert.deepEqual(manifest.not_sent,[{reason:'credentials',count:1005}]);assert.equal(manifest.not_sent_truncated,false);
 const local=buildSourceManifest(tar,{omitted,includeOmittedPaths:true});
 assert.equal(local.not_sent.length,1000);assert.equal(local.not_sent_truncated,true);assert.equal(local.not_sent[0].path,'key0');
});

test('signed manifests bind the archive digest and require an upgraded lender capability',async()=>{
 const {readFileSync}=await import('node:fs');
 const p=await import('../lib/protocol/index.mjs');
 const vectors=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
 const key=p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex'));
 const tar=createTar([{name:'note.txt',type:'0',mode:0o644,data:Buffer.from('test')}]);
 const manifest=buildSourceManifest(tar),job=structuredClone(vectors.objects.job.envelope.payload);
 job.source={kind:'archive',artifact:{digest:manifest.archive_digest,bytes:manifest.packed_bytes,media_type:'application/gzip'}};
 job.source_manifest=manifest;job.requirements.capabilities=['source_manifest_v1','run_request_v1'];
 assert.doesNotThrow(()=>p.signEnvelope('job',job,key));
 assert.equal(p.validateRequirements(job.requirements,{recognizedCapabilities:['patch-output','verify_v1']}).ok,false);
 job.source_manifest={...manifest,archive_digest:'sha256:'+'0'.repeat(64)};assert.throws(()=>p.signEnvelope('job',job,key));
 job.source_manifest=manifest;job.requirements.capabilities=[];assert.throws(()=>p.signEnvelope('job',job,key));
});

test('signing refuses a preview manifest containing excluded names',async()=>{
 const {readFileSync}=await import('node:fs');
 const p=await import('../lib/protocol/index.mjs');
 const vectors=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
 const key=p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex'));
 const tar=createTar([{name:'main.js',type:'0',mode:0o644,data:Buffer.from('test')}]);
 const manifest=buildSourceManifest(tar,{omitted:[{path:'private/.env',reason:'credentials'}],includeOmittedPaths:true});
 const job=structuredClone(vectors.objects.job.envelope.payload);
 job.source={kind:'archive',artifact:{digest:manifest.archive_digest,bytes:manifest.packed_bytes,media_type:'application/gzip'}};
 job.source_manifest=manifest;job.requirements.capabilities=['source_manifest_v1','run_request_v1'];
 assert.throws(()=>p.signEnvelope('job',job,key));
});

test('a project label is signed, bounded and hidden from validators without its capability',async()=>{
 const {readFileSync}=await import('node:fs');
 const p=await import('../lib/protocol/index.mjs');
 const vectors=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
 const key=p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex'));
 const manifest=buildSourceManifest(createTar([{name:'main.js',type:'0',mode:0o644,data:Buffer.from('test')}]));
 const job=structuredClone(vectors.objects.job.envelope.payload);
 job.source={kind:'archive',artifact:{digest:manifest.archive_digest,bytes:manifest.packed_bytes,media_type:'application/gzip'}};
 job.source_manifest={...manifest,project_name:'booking-site'};
 job.requirements.capabilities=['source_manifest_v1','source_project_name_v1','run_request_v1'];
 assert.doesNotThrow(()=>p.signEnvelope('job',job,key));
 assert.equal(p.validateRequirements(job.requirements,{recognizedCapabilities:['source_manifest_v1']}).ok,false);
 for(const name of ['/home/sam/booking-site','C:\\Users\\sam','a'.repeat(161),'','bad\nname']){
  job.source_manifest.project_name=name;assert.throws(()=>p.signEnvelope('job',job,key));
 }
 job.source_manifest.project_name='booking-site';job.requirements.capabilities=['source_manifest_v1','run_request_v1'];
 assert.throws(()=>p.signEnvelope('job',job,key));
});
