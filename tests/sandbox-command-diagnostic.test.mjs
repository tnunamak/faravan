import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileSbx,receiptBackend,receiptJob} from './helpers/sandbox-receipt-fixture.mjs';
import {createDiagnosticLog} from '../lib/v1/diagnostic-log.mjs';
import {createTranscriptRedactor,redactTranscriptText} from '../lib/v1/transcript-redaction.mjs';
import {check} from '../lib/v1/ops/schema.mjs';
import {sandboxCommandDiagnosticOf} from '../lib/sandbox-command-diagnostic.mjs';
import {sandboxCommandDiagnostic} from '../lib/sandbox-command-observation.mjs';

const detailsSchema=JSON.parse(await fs.readFile(new URL('../docs/support/lending-error-details.schema.json',import.meta.url),'utf8'));

async function fixture(t,result) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'command-diagnostic-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'lending-errors.jsonl');
 const record=createDiagnosticLog({file,fs,redactor:options=>{const redact=createTranscriptRedactor(options);return value=>redactTranscriptText(value,redact);}});
 const fake=fileSbx(root),backend=receiptBackend(root,fake,{cleanupListingTimeoutMs:20,cleanupListingSleep:async()=>{},onDiagnostic:record,
  runCommand:async(args,options)=>args[0]==='ls'?typeof result==='function'?result(args,options):result:fake.run(args,options)});
 backend.cleanupJournal.status=()=>({compute_cleanup_pending:1});
 return {backend,record,file,root,rows:async()=>{await record.flush();return (await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);}};
}
for(const [stage,result] of [
 ['timeout',{code:1,stdout:'',stderr:'deadline exceeded',timedOut:true,killed:true,signal:'SIGKILL'}],
 ['exit',{code:7,stdout:'',stderr:'daemon locked'}],
 ['stderr nonempty',{code:0,stdout:'[]',stderr:'daemon busy'}],
 ['parse',{code:0,stdout:'not JSON',stderr:''}],
 ['complete',{code:0,stdout:'[]',stderr:'',truncated:true}],
])test('existing recovery row carries bounded command evidence: '+stage,async t=>{
 const f=await fixture(t,result);let hold;
 await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 await f.record({at:new Date().toISOString(),code:'cessation_unverified',phase:'deadline_recovery',message:hold.message,
  details:{stage:hold.error_code,sandbox_command:sandboxCommandDiagnosticOf(hold)}});
 const rows=await f.rows();assert.equal(rows.length,1);
 assert.equal(check(detailsSchema,rows[0].details),null);
 const d=rows[0].details.sandbox_command;
 assert.equal(d.stage,stage);assert.equal(d.subcommand,'ls --json');assert.ok(d.runtime_path);
 assert.equal(d.exit_code,result.timedOut?null:result.code);assert.equal(d.signal,result.signal??null);
 for(const key of ['timedOut','killed','truncated'])assert.equal(d[key],result[key]===true);
 assert.equal(d.daemon_status_passed,null,'an injected transport supplies no daemon-status proof');
 assert.ok(d.duration_ms>=0);assert.ok(Buffer.byteLength(JSON.stringify(rows[0])+'\n')<1024);
});
test('outer listing timeout retains runtime and elapsed time without inventing an exit',async t=>{
 const f=await fixture(t,()=>new Promise(()=>{}));let hold;
 await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 const d=sandboxCommandDiagnosticOf(hold);assert.equal(d.stage,'timeout');assert.equal(d.timedOut,true);
 assert.equal(d.exit_code,null);assert.ok(d.duration_ms>=15);assert.ok(d.runtime_path);
});
test('stderr is scanned before the first-line and size limits, and credential paths stay private',async t=>{
 const token='ghp_'+'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.slice(0,36);
 const f=await fixture(t,{code:1,stdout:'',stderr:'daemon error '+token+'\nsecond line'});let hold;
 await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 await f.record({code:'cessation_unverified',phase:'deadline_recovery',message:hold.message,
  details:{sandbox_command:{...sandboxCommandDiagnosticOf(hold),runtime_path:'/other/credential-sources/auth.json'}}});
 const bytes=await fs.readFile(f.file,'utf8');assert.ok(!bytes.includes(token));assert.ok(!bytes.includes('credential-sources'));
 const d=(await f.rows())[0].details.sandbox_command;assert.ok(d.stderr_first_line.length<=160);assert.match(d.stderr_first_line,/withheld|redacted/);
});
test('failed create writes one command diagnostic through the existing logger',async t=>{
 const f=await fixture(t,{code:0,stdout:'[]',stderr:''}),run=f.backend.runSbx;
 f.backend.cleanupJournal.status=()=>({});
 f.backend.runSbx=async(args,options)=>args[0]==='create'?{code:9,stderr:'create locked',stdout:''}:run(args,options);
 await assert.rejects(f.backend.prepare(receiptJob()));
 const rows=await f.rows();assert.equal(rows.length,1);assert.equal(rows[0].details.sandbox_command.subcommand,'create');
 assert.equal(rows[0].details.sandbox_command.exit_code,9);assert.equal(rows[0].details.sandbox_command.stage,'exit');
});

for(const passed of [false,true])test('daemon-status evidence survives its verification boundary: passed='+passed,async t=>{
 const {ensureSbxDaemon}=await import('../lib/docker-backend.mjs');
 const previous=process.env.FARAVAN_SBX_DAEMON_GATE;delete process.env.FARAVAN_SBX_DAEMON_GATE;
 t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_DAEMON_GATE;else process.env.FARAVAN_SBX_DAEMON_GATE=previous;});
 const f=await fixture(t,async()=>{
  await ensureSbxDaemon({systemd:false,platformName:'darwin',runCommand:async(_binary,args)=>{
   assert.deepEqual(args,['daemon','status']);return {code:passed?0:23,stdout:passed?'Status: running':'',stderr:passed?'':'daemon status locked'};
  }});
  return {code:4,stdout:'',stderr:'listing locked'};
 });
 let hold;await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 const d=sandboxCommandDiagnosticOf(hold);assert.equal(d.daemon_status_passed,passed);
 assert.equal(d.subcommand,passed?'ls --json':'daemon status');assert.equal(d.exit_code,passed?4:23);assert.equal(d.stage,'exit');
});

test('hanging dispatched create emits one timeout row at its deadline, without waiting for transport settlement',async t=>{
 const f=await fixture(t,{code:0,stdout:'[]',stderr:''});f.backend.cleanupJournal.status=()=>({});
 const run=f.backend.runSbx;let release,entered;
 const started=new Promise(resolve=>{entered=resolve;});
 f.backend.runSbx=async(args,options)=>args[0]==='create'?new Promise(resolve=>{release=()=>resolve({code:1,stderr:'cancelled'});entered();}):run(args,options);
 const work=f.backend.prepare(receiptJob()).catch(()=>{});await started;
 f.backend.deadlineTimers.fireAll();
 const rows=await f.rows();assert.equal(rows.length,1);const d=rows[0].details.sandbox_command;
 assert.equal(d.subcommand,'create');assert.equal(d.stage,'timeout');assert.equal(d.timedOut,true);assert.equal(d.exit_code,null);
 release();await work;assert.equal((await f.rows()).length,1,'settlement does not duplicate the deadline diagnostic');
});

test('diagnostic projection bounds multibyte retained rows and scans secret text beyond the cut',async t=>{
 const f=await fixture(t,{code:1,stderr:'locked'});let hold;
 await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 const token='ghp_'+'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.slice(0,36);
 await f.record({at:'界'.repeat(64),code:'界'.repeat(64),phase:'界'.repeat(64),condition:'界'.repeat(64),message:'界'.repeat(500),
  details:{stage:'界'.repeat(64),sandbox_command:{...sandboxCommandDiagnosticOf(hold),runtime_path:'/opt/'+'界'.repeat(100),stderr_first_line:'safe '.repeat(100)+token}}});
 const bytes=await fs.readFile(f.file,'utf8');assert.ok(Buffer.byteLength(bytes)<1024);assert.ok(!bytes.includes(token));
 assert.match((await f.rows())[0].details.sandbox_command.stderr_first_line,/withheld|^$/);
});

for(const stderr of ['PATH=/private/environment/value','error /another/user/.claude.json','error /another/user/.codex/auth.json'])test('command text withholds environment and credential paths: '+stderr.split(' ')[0],async t=>{
 const f=await fixture(t,{code:1,stdout:'',stderr});let hold;
 await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 assert.equal(sandboxCommandDiagnosticOf(hold).stderr_first_line,'[private details withheld]');
});

test('runtime fence rejection is diagnosed without publishing command details in the hold',async t=>{
 const f=await fixture(t,{code:0,stdout:'[]',stderr:''});
 f.backend._cleanupRuntime=()=>{throw Object.assign(Error('runtime changed'),{sbxLaunchRefused:true,code:'claude_account_unavailable'});};
 let hold;await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 const d=sandboxCommandDiagnosticOf(hold);assert.equal(d.stage,'fence');assert.equal(d.exit_code,null);
 assert.equal(d.daemon_status_passed,null);assert.ok(!JSON.stringify(hold).includes('runtime_path'));
});

for(const [stage,fault] of [
 ['timeout',{code:null,killed:true,signal:'SIGKILL'}],
 ['complete',{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}],
 ['exit',{code:17}],
])test('raw child normalization retains diagnostic flags: '+stage,async()=>{
 const {runInNewContext}=await import('node:vm');
 const {transportPrelude,transportGlobals}=await import('./helpers/sbx-transport-fixture.mjs');
 const source=await fs.readFile(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function runSbx('),source.indexOf('// The normal helper intentionally'));
 const runtime=transportGlobals.createSbxRuntime({path:'/fixture/sbx',fence(){}});
 const functions=runInNewContext(transportPrelude(source)+body+'\n({runSbx})',{
  ...transportGlobals,needsSbxDaemon:()=>true,ensureSbxDaemon:async()=>{},sbxBin:()=>'/fixture/sbx',sbxChildEnv:()=>({}),
  recordDaemonLaunch(){},SbxDaemonVerificationError:class extends Error{},
  execFile:()=>Promise.reject(Object.assign(Error('child failed'),{stderr:'child failed',...fault})),
 });
 const result=await functions.runSbx(['ls','--json'],{sbxRuntime:runtime,timeout:10});
 const d=sandboxCommandDiagnosticOf(result);assert.equal(d.stage,stage);
 assert.equal(d.timedOut,stage==='timeout');assert.equal(d.truncated,stage==='complete');
 assert.equal(d.signal,fault.signal??null);assert.equal(d.exit_code,stage==='exit'?17:null);
});

for(const successAttempt of [2,3])test('recovered retry writes one redacted evidence row: attempt '+successAttempt,async t=>{
 let calls=0;
 const token='ghp_'+'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.slice(0,36);
 const f=await fixture(t,()=>++calls===successAttempt?{code:0,stdout:'[]',stderr:''}:
  {code:10+calls,stdout:'',stderr:'failed '+calls+' '+token+' '+ '界'.repeat(500)});
 assert.equal(await f.backend._cleanupListingReady({force:true}),true);
 assert.equal(calls,successAttempt);assert.equal(f.backend.deadlineRecoveryHold(),null);
 const rows=await f.rows();assert.equal(rows.length,1);assert.equal(rows[0].code,'listing_retry_recovered');
 const d=rows[0].details.sandbox_command;
 assert.equal(d.attempts,successAttempt);assert.equal(d.exit_code,10+successAttempt-1);assert.equal(d.stage,'exit');
 assert.ok(Buffer.byteLength(JSON.stringify(rows[0])+'\n')<1024);assert.ok(!JSON.stringify(rows).includes(token));
});
test('exhausted retry writes one hold row with the last command fields and attempts',async t=>{
 let calls=0;const token='ghp_'+'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.slice(0,36);
 const f=await fixture(t,()=>({code:20+(++calls),stdout:'',stderr:'last '+calls+' '+token+' '+ '界'.repeat(500)}));
 let hold;await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 await f.record({code:'cessation_unverified',phase:'deadline_recovery',message:hold.message,
  details:{stage:hold.error_code,sandbox_command:sandboxCommandDiagnosticOf(hold)}});
 const rows=await f.rows();assert.equal(rows.length,1);assert.equal(rows[0].code,'cessation_unverified');assert.equal(calls,3);
 const d=rows[0].details.sandbox_command;assert.equal(d.attempts,3);assert.equal(d.exit_code,23);
 assert.ok(Buffer.byteLength(JSON.stringify(rows[0])+'\n')<1024);assert.ok(!JSON.stringify(rows).includes(token));
});
test('listing retry observations reset daemon-status evidence between attempts',async t=>{
 const {ensureSbxDaemon}=await import('../lib/docker-backend.mjs');
 const previous=process.env.FARAVAN_SBX_DAEMON_GATE;delete process.env.FARAVAN_SBX_DAEMON_GATE;
 t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_DAEMON_GATE;else process.env.FARAVAN_SBX_DAEMON_GATE=previous;});
 let calls=0;const f=await fixture(t,async()=>{
  if(++calls<3)await ensureSbxDaemon({systemd:false,platformName:'darwin',runCommand:async()=>({code:31,stdout:'',stderr:'daemon locked'})});
  return {code:41,stdout:'',stderr:'listing refused'};
 });
 let hold;await assert.rejects(f.backend._cleanupListingReady({force:true}),error=>{hold=error.recovery_hold;return true;});
 const d=sandboxCommandDiagnosticOf(hold);assert.equal(d.subcommand,'ls --json');assert.equal(d.exit_code,41);
 assert.equal(d.daemon_status_passed,null);assert.equal(d.attempts,3);
});

test('private command details schema is closed and bounds diagnostic strings',()=>{
 const schema=detailsSchema.properties.sandbox_command;
 assert.equal(detailsSchema.additionalProperties,false);assert.equal(schema.additionalProperties,false);
 const command=sandboxCommandDiagnostic({code:1,stderr:'daemon unavailable'});
 assert.equal(check(detailsSchema,{sandbox_command:command}),null);
 assert.ok(check(detailsSchema,{sandbox_command:{...command,argv:['private']}}));
 assert.ok(check(detailsSchema,{sandbox_command:command,extra:'private'}));
 for(const key of ['runtime_path','stderr_first_line']) {
  assert.equal(schema.properties[key].maxLength,160);
  assert.ok(check(schema.properties[key],'x'.repeat(161)));
 }
});
