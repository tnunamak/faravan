import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLendingLog, messageForCode } from '../lib/v1/lending-log.mjs';
import { FAILURE_CODES, classify } from '../lib/v1/failures.mjs';
import { createJobMetaStore } from '../lib/v1/job-meta.mjs';
import { runV1Command } from '../lib/v1/cli.mjs';
import { helpFor } from '../lib/v1/help.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';

const GENERIC='The job failed. The exact cause is not shown here because it can contain private details.';
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'faravan-private-log-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,file:join(directory,'lending-errors.jsonl')};
}
test('private log is bounded, newest first, locally titled, and allow-list redacted',async t=>{
  const {directory,file}=await fixture(t),job='sha256:'+'a'.repeat(64);
  assert.deepEqual(await readLendingLog(directory),[]);
  await createJobMetaStore(directory).record(job,{title:'Synthetic title',prompt:'PRIVATE PROMPT'});
  const entries=Array.from({length:60},(_,i)=>({at:new Date(1700000000000+i*1000).toISOString(),job,
    code:'sandbox_not_ready',phase:'prepare',message:'SYNTHETIC SECRET /home/alice token=synthetic',
    stack:'SYNTHETIC STACK',account:'synthetic@example.test'}));
  const original=entries.map(row=>JSON.stringify(row)).join('\n')+'\n{broken\n';
  await writeFile(file,original,{mode:0o600});
  const rows=await readLendingLog(directory);
  assert.equal(rows.length,50);
  assert.equal(rows[0].at,entries[59].at);assert.equal(rows[49].at,entries[10].at);
  assert.equal(rows[0].title,'Synthetic title');
  assert.equal(rows[0].lender_key,'failure.lender_setup.lender');
  assert.deepEqual(JSON.parse(rows[0].details),{code:'sandbox_not_ready',phase:'prepare',message:'The protected workspace (Docker Sandboxes) was not ready.'});
  assert.doesNotMatch(JSON.stringify(rows),/SYNTHETIC SECRET|SYNTHETIC STACK|PRIVATE PROMPT|alice|example.test/);
  assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal(await readFile(file,'utf8'),original);
});
test('private log skips malformed rows and never echoes unknown fields or invalid identifiers',async t=>{
  const {directory,file}=await fixture(t);
  await writeFile(file,[null,[],{at:'bad'},{at:'2026-01-01T00:00:00Z',job:'/private/path',
    code:'synthetic_secret',phase:'secret phase',message:'secret'}].map(JSON.stringify).join('\n'),{mode:0o600});
  const [row]=await readLendingLog(directory);
  assert.deepEqual(row,{at:'2026-01-01T00:00:00.000Z',job:null,title:null,code:null,phase:null,
    message:GENERIC,error_id:classify(null,null,null).error_id,correlation_id:null,lender_key:'failure.platform.lender',details:JSON.stringify({code:null,phase:null,message:GENERIC})});
  await writeFile(file,'x'.repeat(2*1024*1024)+'\n'+JSON.stringify({at:'2026-01-02T00:00:00Z',code:'wall_timeout'}));
  assert.equal((await readLendingLog(directory)).length,1);
});
test('private log refuses symlinks rather than reading another file',async t=>{
  const {directory,file}=await fixture(t),other=join(directory,'synthetic-other');
  await writeFile(other,'synthetic');await symlink(other,file);
  await assert.rejects(readLendingLog(directory),{code:'ELOOP'});
});

const entry=(job,n,extra={})=>JSON.stringify({at:new Date(1700000000000+n*1000).toISOString(),job,code:'sandbox_not_ready',phase:'prepare',
  message:'SYNTHETIC SECRET /home/alice token=synthetic',...extra});

test('faravan lending log prints the private log, newest first, as text and as JSON, without raw error text',async t=>{
  const home=await mkdtemp(join(tmpdir(),'faravan-lending-cli-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const job='sha256:'+'b'.repeat(64);
  const run=async argv=>{let stdout='',stderr='';const code=await runV1Command(argv,{home,stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}});return {code,stdout,stderr};};
  assert.deepEqual(await run(['lending','log']),{code:0,stdout:'No problems recorded.\n',stderr:''});
  await mkdir(join(home,'v1'),{recursive:true});
  await createJobMetaStore(join(home,'v1')).record(job,{title:'Fix the parser',prompt:'PRIVATE PROMPT'});
  await writeFile(join(home,'v1','lending-errors.jsonl'),[entry(job,1),entry(job,2,{code:'wall_timeout',phase:'run'})].join('\n')+'\n',{mode:0o600});
  const text=await run(['lending','log']);
  assert.equal(text.code,0);
  const lines=text.stdout.trim().split('\n');
  assert.equal(lines.length,6);assert.match(lines[0],/Fix the parser +wall_timeout \(run\)$/);assert.match(lines[1],/ran past its time limit/);assert.match(lines[2],/^ +ID SPK-[A-Z2-7]{4}$/);assert.match(lines[3],/Fix the parser +sandbox_not_ready \(prepare\)$/);
  assert.doesNotMatch(text.stdout+text.stderr,/SYNTHETIC SECRET|alice|PRIVATE PROMPT/);
  const json=await run(['lending','log','--json']);
  const rows=JSON.parse(json.stdout);
  assert.deepEqual(rows.map(r=>r.code),['wall_timeout','sandbox_not_ready']);
  assert.doesNotMatch(json.stdout,/SYNTHETIC SECRET|alice|PRIVATE PROMPT/);
  assert.equal((await run(['lending'])).code,2);
  assert.equal((await run(['lending','log','extra'])).code,2);
  assert.match((await run(['lending','log','--help'])).stdout,/Usage: faravan lending log/);
  assert.match(helpFor(['lending']),/never sent to a circle/);
});

test('GET /api/lending/log serves the lender its own log; a borrower app has none; nothing reaches the circle',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const job='sha256:'+'c'.repeat(64);
  await writeFile(join(lender.home,'v1','lending-errors.jsonl'),[entry(job,1),entry(job,2)].join('\n')+'\n',{mode:0o600});
  const rows=await api(lender.app,'/api/lending/log');
  assert.equal(rows.length,2);assert.equal(rows[0].job,job);assert.equal(rows[0].code,'sandbox_not_ready');
  assert.doesNotMatch(JSON.stringify(rows),/SYNTHETIC SECRET|alice/);
  assert.equal((await stat(join(lender.home,'v1','lending-errors.jsonl'))).mode&0o777,0o600);
  assert.deepEqual(await api(owner.app,'/api/lending/log'),[]);
  await api(lender.app,'/api/lending/log',{token:null,status:401});
  assert.equal(JSON.stringify([...f.jobs.values()]).includes('sandbox_not_ready'),false,'the circle server never sees the log');
});

test('the private log module cannot reach the network or a circle',async()=>{
  const source=await readFile(new URL('../lib/v1/lending-log.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/from '\.\/(client|server|store|device)\.mjs'|fetch\(|node:https?|node:net/);
});

test('every failure code has a plain sentence; unknown codes get the generic one; raw error text never appears',()=>{
  for(const code of FAILURE_CODES) {
    const message=messageForCode(code,'run');
    assert.ok(message.length>10&&message.length<=160,code);
  }
  assert.equal(messageForCode('synthetic_unknown_code','run'),GENERIC);
  assert.equal(messageForCode(null),GENERIC);
  assert.equal(messageForCode('__proto__'),GENERIC);
  assert.equal(messageForCode('wall_timeout'),'The job ran past its time limit and was stopped.');
  // A lost lease after the start was authorized holds the job until the stop is confirmed, or fails it once the agent ran.
  assert.doesNotMatch(messageForCode('lease_expired','run'),/handed back/);
});

test('rate limiting before a claim does not say the job was interrupted or handed back',()=>{
  const message=messageForCode('rate_limited','before_claim');
  assert.equal(message,'The circle server is limiting requests from this computer. Faravan will try again.');
  assert.doesNotMatch(message,/interrupted|handed it back/);
});

test('a lease-expiry stop without removal proof does not say the work stopped',()=>{
  // The run may still be going in the guest (a fenced launch). Only a proven stop keeps "stopped working".
  const unproven=messageForCode('lease_expired_unproven','run');
  assert.equal(unproven,'Contact with the server was lost. Faravan could not confirm that the job stopped on this computer. Check Docker Sandboxes.');
  assert.doesNotMatch(unproven,/stopped working/);
  assert.match(messageForCode('lease_expired','run'),/stopped working/);
  assert.ok(FAILURE_CODES.includes('lease_expired_unproven'));
});

test('each entry carries the short error ID, and the full correlation ID when the failure recorded a ref',async t=>{
  const {directory,file}=await fixture(t),job='sha256:'+'c'.repeat(64);
  await writeFile(file,[entry(job,1),entry(job,2,{ref:'ABC234'}),entry(job,3,{ref:'abc234'}),entry(job,4,{ref:'ABC23'})].join('\n')+'\n',{mode:0o600});
  const rows=await readLendingLog(directory);
  for(const row of rows)assert.equal(row.error_id,classify('sandbox_not_ready','prepare',job).error_id);
  assert.match(rows[0].error_id,/^SPK-[A-Z2-7]{4}$/);
  assert.deepEqual(rows.map(r=>r.correlation_id),[null,null,job+'-ABC234',null]);
});

test('agent exit failures have fixed copy without private diagnostic text', () => {
  for (const code of ['agent_exit_nonzero','agent_group_not_ceased','agent_run_failed']) {
    const message = messageForCode(code, 'run');
    assert.match(message, /The agent/);
    assert.doesNotMatch(message, /verdict|receipt|attempt|settled|lease|\x73parekin/i);
  }
});

test('a refusal from a limit window the account stopped reporting or cannot be read has a plain sentence', ()=>{
  assert.equal(messageForCode('lending_window_missing','run'),
    'This account stopped reporting its five-hour limit; lending resumes after one full five-hour window.');
  assert.equal(messageForCode('lending_window_memory_unreadable','run'),
    'Could not read which limits this account reports; lending is paused until the file is readable.');
});
