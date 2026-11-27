import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {sandboxRemediationLines} from '../lib/sandbox-remediation.mjs';
import {fileSbx,receiptBackend,writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';

const ENV=['FARAVAN_SBX_HOME','FARAVAN_SCRATCH_ROOT'];
const READY=180000;
const NAMES=['wf-1111111111111111','wf-2222222222222222','wf-3333333333333333'];
const CANARY='ghp_CANARYCANARYCANARY';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'wf-cessation-pass-'));
  const saved=Object.fromEntries(ENV.map(name=>[name,process.env[name]]));
  process.env.FARAVAN_SBX_HOME=join(root,'sbx-home');process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
  await mkdir(process.env.FARAVAN_SBX_HOME,{recursive:true});await mkdir(process.env.FARAVAN_SCRATCH_ROOT,{recursive:true});
  t.after(async()=>{
    for(const name of ENV)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
    await rm(root,{recursive:true,force:true});
  });
  const sbx=fileSbx(join(root,'sbx'));
  const directory=join(root,'profile','v1','sandbox-cleanup');
  const clock={at:Date.UTC(2026,10,7)};
  const storage={available:async()=>true,release:async()=>{}};
  const make=(run=sbx.run)=>receiptBackend(root,{...sbx,run},{now:()=>clock.at,storage});
  // A finished create: the sandbox is listed and the record knows it made it.
  const listed=async(name,{scratchRoot=process.env.FARAVAN_SCRATCH_ROOT}={})=>{
    await sbx.run(['create','--name',name]);
    const id=await writeCreateReceipt(directory,{jobId:'job-'+name,name,ownerScope:sandboxOwnerScope(),home:process.env.FARAVAN_SBX_HOME,scratchRoot});
    const row=JSON.parse(await readFile(join(directory,id+'.json'),'utf8'));
    await mkdir(row.scratch_dir,{recursive:true});
    return {id,row};
  };
  // An app killed between the create dispatch and the settle write.
  const unsettled=async name=>{
    const id=await writeCreateReceipt(directory,{jobId:'job-'+name,name,ownerScope:sandboxOwnerScope(),home:process.env.FARAVAN_SBX_HOME,
      scratchRoot:process.env.FARAVAN_SCRATCH_ROOT,created:false,settled:false});
    const row=JSON.parse(await readFile(join(directory,id+'.json'),'utf8'));
    await mkdir(row.scratch_dir,{recursive:true});
    return {id,row};
  };
  return {root,sbx,directory,clock,make,listed,unsettled};
}
const records=async directory=>(await readdir(directory).catch(()=>[])).filter(name=>name.endsWith('.json'));

test('recovered admission remains available while journal remediation prevents cessation proof',async t=>{
  const f=await fixture(t), backend=f.make();
  backend.recoverSandboxDeadlines=async()=>({rows:[]});
  backend.cleanupJournal.reconcileOwned=async()=>({removed:true,remediation:[{name:NAMES[0],watched:false}]});
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  assert.equal(backend.isOwnedSandboxProofCurrent(proof),false);
  assert.equal(backend.isOwnedSandboxAdmissionCurrent(proof),true);
  assert.deepEqual(proof.cleanup_debt,[{name:NAMES[0],watched:false,home:process.env.FARAVAN_SBX_HOME,status:'failed'}]);
});

test('a record whose scratch is outside the scratch root does not stall the other records',async t=>{
  const f=await fixture(t);
  await f.listed(NAMES[0]);await f.listed(NAMES[1]);
  const outsideRoot=join(f.root,'elsewhere');await mkdir(outsideRoot);
  const odd=await f.listed(NAMES[2],{scratchRoot:outsideRoot});
  await writeFile(join(odd.row.scratch_dir,'keep.txt'),'owner data');
  const proof=await f.make().reconcileOwnedSandboxes();
  assert.equal(proof.removed,true,'the outside-root record does not hold lending');
  assert.deepEqual(f.sbx.read(),[],'every listed sandbox, including the outside-root one, is removed');
  assert.deepEqual(await records(f.directory),[],'every record finished');
  assert.equal(await readFile(join(odd.row.scratch_dir,'keep.txt'),'utf8'),'owner data','the outside directory is left in place');
});

test('an outside-root scratch directory is never deleted when a pending attempt resolves its job',async t=>{
  const f=await fixture(t);
  const outsideRoot=join(f.root,'elsewhere');await mkdir(outsideRoot);
  const odd=await f.listed(NAMES[0],{scratchRoot:outsideRoot});
  await writeFile(join(odd.row.scratch_dir,'keep.txt'),'owner data');
  const backend=f.make();
  const receipt=await backend.reconcilePending({...backend.sandboxOwnership(),attemptId:'attempt-1',attempt:{attempt_id:'attempt-1'},jobId:odd.row.job_id});
  assert.equal(receipt.removed,true);
  assert.equal(existsSync(join(odd.row.scratch_dir,'keep.txt')),true);
});

test('a truly unsafe record is listed with its own reason while the other records still finish',async t=>{
  const f=await fixture(t);
  await f.listed(NAMES[0]);await f.listed(NAMES[1]);
  const bad=await f.listed(NAMES[2]);
  const file=join(f.directory,bad.id+'.json');
  await writeFile(file,JSON.stringify({...bad.row,sandbox_id:'not-a-sandbox'}));
  const backend=f.make();
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  assert.ok(proof.remediation?.some(row=>row.reason==='unsafe_record'),JSON.stringify(proof.remediation));
  assert.equal(f.sbx.read().includes(NAMES[0]),false);assert.equal(f.sbx.read().includes(NAMES[1]),false);
  assert.equal((await records(f.directory)).length,1,'only the unsafe record remains');
  assert.ok(backend.cleanupStatus().remediation.some(row=>row.reason==='unsafe_record'));
  const text=sandboxRemediationLines(proof.remediation).join('\n');
  assert.match(text,/cannot|could not/i);
  assert.doesNotMatch(text,/unsafe_record|journal|keeps checking/i);
});

test('a hold with no record behind it still names a reason',async t=>{
  const f=await fixture(t);
  let lists=0;
  const run=async(args,options)=>{
    if(args[0]==='ls'&&++lists>1)return {code:1,stdout:'',stderr:'down'};
    return f.sbx.run(args,options);
  };
  const proof=await f.make(run).reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  assert.ok(proof.remediation?.length>0,'the owner is told why');
  assert.equal(proof.remediation[0].reason,'inventory_unavailable');
});

// A sandbox that is not listed, not settled: the revocation steps run on every pass.
const readStep=async(directory)=>{
  const [name]=await records(directory);
  const text=await readFile(join(directory,name),'utf8');
  return {text,row:JSON.parse(text)};
};

test('a failing secret listing records the step and an error class, never the secret',async t=>{
  const f=await fixture(t);await f.unsettled(NAMES[0]);
  const run=async(args,options)=>{
    if(args[0]==='secret'&&args[1]==='ls')return {code:1,stdout:'',stderr:'bad '+CANARY};
    return f.sbx.run(args,options);
  };
  const backend=f.make(run);
  await backend.reconcileOwnedSandboxes();await backend.reapCleanup();
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  const entry=proof.remediation.find(row=>row.reason==='credential_revocation_pending');
  assert.ok(entry,JSON.stringify(proof.remediation));
  assert.equal(entry.step,'github_secret');
  assert.equal(entry.error,'listing_failed');
  const {text}=await readStep(f.directory);
  assert.doesNotMatch(text+JSON.stringify(proof),new RegExp(CANARY));
  const label=sandboxRemediationLines(proof.remediation).join('\n');
  assert.match(label,/access was removed/);
  assert.match(label,/That sandbox stays reserved for cleanup/);
  assert.match(label,/unrelated new jobs need their own protection/);
  assert.doesNotMatch(label,/could not prove that this install created it/);
});

test('a failing network policy listing records the network step',async t=>{
  const f=await fixture(t);await f.unsettled(NAMES[0]);
  const run=async(args,options)=>{
    if(args[0]==='policy'&&args[1]==='ls')return {code:1,stdout:'',stderr:CANARY};
    return f.sbx.run(args,options);
  };
  const backend=f.make(run);await backend.reconcileOwnedSandboxes();await backend.reapCleanup();
  const proof=await backend.reconcileOwnedSandboxes();
  const entry=proof.remediation.find(row=>row.reason==='credential_revocation_pending');
  assert.equal(entry?.step,'network_policy');
  assert.equal(entry?.error,'listing_failed');
  assert.doesNotMatch(JSON.stringify(proof),new RegExp(CANARY));
});

// The exact rule shape sbx leaves for a create that never completed.
const provisionedRule=name=>({id:'sbx-rule-1',scope:'sandbox:'+name,applies_to:'sandbox:'+name,resource_type:'network',decision:'allow',
  actions:['net:connect:tcp'],status:'active',origin:'scoped',layer:'local',provenance:{created_via:'provisioned',source:'sandboxes'},editable:false,
  resources:['api.example.test:443']});
function withRules(f,rules,{rmCode=0}={}) {
  const removed=[];
  const run=async(args,options)=>{
    if(args[0]==='policy'&&args[1]==='ls')return {code:0,stdout:JSON.stringify({rules:[
      {id:'g1',scope:'global',applies_to:'global',resource_type:'network',decision:'allow',status:'active',editable:true},...rules]}),stderr:''};
    if(args[0]==='policy'&&args[1]==='rm') {removed.push(args);return {code:rmCode,stdout:'',stderr:''};}
    return f.sbx.run(args,options);
  };
  return {run,removed};
}

test('one non-editable rule that sbx provisioned for the absent sandbox does not hold lending forever',async t=>{
  const f=await fixture(t);await f.unsettled(NAMES[0]);
  const rules=withRules(f,[provisionedRule(NAMES[0])]);
  const backend=f.make(rules.run);await backend.reconcileOwnedSandboxes();await backend.reapCleanup();
  const first=await backend.reconcileOwnedSandboxes();
  assert.equal(first.removed,false,'watch adoption is not cessation');
  assert.equal(first.admission_allowed,true,'unrelated fresh admission needs no absence wait');
  assert.ok(!first.remediation?.some(row=>row.reason==='credential_revocation_pending'),JSON.stringify(first.remediation));
  f.clock.at+=5*READY;
  const proof=await f.make(rules.run).reconcileOwnedSandboxes();
  assert.equal(proof.removed,true,'the kit residue rule resolves the absent permanently fenced row');
  assert.equal(proof.admission_allowed,true,'admission is separate from cessation');
  assert.equal(proof.watching??0,0);
  assert.deepEqual(rules.removed,[],'no rule was removed, least of all the non-editable one or a global one');
  assert.equal((await records(f.directory)).length,0,'the kit residue rule closes the absent fenced row');
});

test('an editable rule that sbx refuses to remove keeps the hold',async t=>{
  const f=await fixture(t);await f.unsettled(NAMES[0]);
  const rules=withRules(f,[{...provisionedRule(NAMES[0]),editable:true}],{rmCode:1});
  f.clock.at+=5*READY;
  const backend=f.make(rules.run);await backend.reconcileOwnedSandboxes();await backend.reapCleanup();
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  const entry=proof.remediation.find(row=>row.reason==='credential_revocation_pending');
  assert.equal(entry?.step,'network_policy');
  assert.equal(entry?.error,'removal_refused');
});

test('a non-editable rule from another source keeps the hold',async t=>{
  const f=await fixture(t);await f.unsettled(NAMES[0]);
  const rules=withRules(f,[{...provisionedRule(NAMES[0]),provenance:{created_via:'user',source:'cli'}}]);
  f.clock.at+=5*READY;
  const backend=f.make(rules.run);await backend.reconcileOwnedSandboxes();await backend.reapCleanup();
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  const entry=proof.remediation.find(row=>row.reason==='credential_revocation_pending');
  assert.equal(entry?.error,'rule_remains');
  assert.deepEqual(rules.removed,[]);
});

// Review fixes: exact owner, exact provenance, complete inventory, plain step text, null rows.
const rewrite=async(directory,id,change)=>{
  const file=join(directory,id+'.json');
  await writeFile(file,JSON.stringify({...JSON.parse(await readFile(file,'utf8')),...change}));
};
const removals=f=>f.sbx.calls().filter(args=>args[0]==='rm');
async function outsideRecord(f,change) {
  const outsideRoot=join(f.root,'elsewhere');await mkdir(outsideRoot);
  const odd=await f.listed(NAMES[0],{scratchRoot:outsideRoot});
  await writeFile(join(odd.row.scratch_dir,'keep.txt'),'owner data');
  await rewrite(f.directory,odd.id,change);
  return odd;
}

test('an outside-root record with an empty owner is never acted on',async t=>{
  const f=await fixture(t);
  const odd=await outsideRecord(f,{owner_scope:''});
  const proof=await f.make().reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  assert.deepEqual(removals(f),[],'no rm is dispatched for a record that names no owner');
  assert.deepEqual(f.sbx.read(),[NAMES[0]]);
  assert.equal(existsSync(join(odd.row.scratch_dir,'keep.txt')),true);
});

test('an outside-root record of a different owner is skipped and left untouched',async t=>{
  const f=await fixture(t);
  const odd=await outsideRecord(f,{owner_scope:'someone-else'});
  const proof=await f.make().reconcileOwnedSandboxes();
  assert.equal(proof.removed,true);
  assert.deepEqual(proof.foreign,[NAMES[0]]);
  assert.deepEqual(removals(f),[]);
  assert.deepEqual(f.sbx.read(),[NAMES[0]]);
  assert.equal((await records(f.directory)).length,1);
  assert.equal(existsSync(join(odd.row.scratch_dir,'keep.txt')),true);
});

for(const [label,change] of Object.entries({
  'source is another value':rule=>({...rule,provenance:{...rule.provenance,source:'cli'}}),
  'source is missing':rule=>({...rule,provenance:{created_via:'provisioned'}}),
  'layer is global':rule=>({...rule,layer:'global'}),
  'layer is missing':({layer,...rule})=>rule,
  'origin is changed':rule=>({...rule,origin:'user'}),
  'origin is missing':({origin,...rule})=>rule,
  'scope names another sandbox':rule=>({...rule,scope:'sandbox:'+NAMES[1]}),
  'creator is the user':rule=>({...rule,provenance:{...rule.provenance,created_via:'user'}}),
  'target names another sandbox':rule=>({...rule,applies_to:'sandbox:'+NAMES[1]}),
})) test(`a non-editable provisioned rule keeps the hold when its ${label}`,async t=>{
  const f=await fixture(t);await f.unsettled(NAMES[0]);
  const rules=withRules(f,[change(provisionedRule(NAMES[0]))]);
  f.clock.at+=5*READY;
  const backend=f.make(rules.run);await backend.reconcileOwnedSandboxes();await backend.reapCleanup();
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);
  assert.ok(proof.remediation.some(row=>row.reason==='credential_revocation_pending'),JSON.stringify(proof.remediation));
  assert.deepEqual(rules.removed,[]);
});

test('a partial sandbox listing keeps the hold even for a provisioned rule',async t=>{
  const f=await fixture(t),saved=await f.unsettled(NAMES[0]);
  const rowFile=join(f.directory,saved.id+'.json'),bytes=await readFile(rowFile);
  const rules=withRules(f,[provisionedRule(NAMES[0])]);
  for(const flaw of [{stderr:'partial inventory'},{truncated:true},{timedOut:true},{killed:true},{errorCode:'EPIPE'}]) {
    const run=async(args,options)=>args[0]==='ls'?{...await rules.run(args,options),...flaw}:rules.run(args,options);
    f.clock.at+=5*READY;
    const backend=f.make(run),proof=await backend.reconcileOwnedSandboxes();
    assert.equal(proof.removed,false,JSON.stringify(flaw));
    // The written availability rule stops before adopting or rewriting rows
    // when inventory is incomplete, and reports a whole-service blocker.
    assert.equal(proof.admission_allowed,false,'unavailable inventory blocks the pass');
    assert.equal(proof.watching??0,0);
    assert.equal(backend.deadlineRecoveryHold().error_code,'sbx_daemon_unavailable');
    assert.deepEqual(await readFile(rowFile),bytes);
    assert.equal(proof.removed,false,'a failed listing never proves compute stopped');
    assert.deepEqual(rules.removed,[],'the provisioned/global rules are not removed');
  }
});

test('the held text tells a secret failure from a network rule failure in plain words',async t=>{
  const secret=sandboxRemediationLines([{reason:'credential_revocation_pending',step:'github_secret',error:'listing_failed'}]).join('\n');
  const network=sandboxRemediationLines([{reason:'credential_revocation_pending',step:'network_policy',error:'listing_failed'}]).join('\n');
  const refused=sandboxRemediationLines([{reason:'credential_revocation_pending',step:'network_policy',error:'removal_refused'}]).join('\n');
  assert.notEqual(secret,network);assert.notEqual(network,refused);
  assert.match(secret,/GitHub/);assert.match(network,/network/);
  for(const text of [secret,network,refused]) {
    assert.doesNotMatch(text,/github_secret|network_policy|listing_failed|removal_refused|rule_remains|value_remains|credential_revocation/);
    assert.doesNotMatch(text,/verdict|receipt|attempt|settled|lease|\x73parekin|—/i);
    assert.match(text,/That sandbox stays reserved for cleanup/);
    assert.match(text,/unrelated new jobs need their own protection/);
  }
});

test('a null record sorted before a valid row does not stop the valid row',async t=>{
  const f=await fixture(t);
  const ok=await f.listed(NAMES[0]);
  await writeFile(join(f.directory,'00000000-0000-0000-0000-000000000000.json'),'null');
  const backend=f.make();
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false,'the null record counts as unsafe');
  assert.deepEqual(f.sbx.read(),[],'the valid row still resolved');
  assert.equal((await records(f.directory)).includes(ok.id+'.json'),false);
  const pending=await backend.reconcilePending({...backend.sandboxOwnership(),attemptId:'a',attempt:{attempt_id:'a'},jobId:ok.row.job_id});
  assert.ok(pending);
});
