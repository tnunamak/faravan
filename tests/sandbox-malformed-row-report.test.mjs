import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {fileSbx,receiptBackend} from './helpers/sandbox-receipt-fixture.mjs';

// A row this version cannot trust names its own target at most. Whatever it carries in its own fields, the recovery report
// stays valid, so one malformed row never holds every other target.
const ENV=['FARAVAN_SBX_HOME','FARAVAN_SCRATCH_ROOT'];
const GOOD='wf-0123456789abcdef',OTHER='wf-fedcba9876543210';
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'wf-malformed-'));
  const saved=Object.fromEntries(ENV.map(name=>[name,process.env[name]]));
  process.env.FARAVAN_SBX_HOME=join(root,'sbx-home');process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
  await mkdir(process.env.FARAVAN_SBX_HOME,{recursive:true});await mkdir(process.env.FARAVAN_SCRATCH_ROOT,{recursive:true});
  t.after(async()=>{
    for(const name of ENV)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
    await rm(root,{recursive:true,force:true});
  });
  const directory=join(root,'profile','v1','sandbox-cleanup');
  await mkdir(directory,{recursive:true,mode:0o700});
  const sbx=fileSbx(join(root,'sbx'));
  const write=async(overrides,id=randomUUID())=>{
    const row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:process.env.FARAVAN_SBX_HOME,job_id:'job-'+id.slice(0,4),sandbox_id:GOOD,
      scratch_dir:join(process.env.FARAVAN_SCRATCH_ROOT,'wf-job-'+GOOD+'-'+randomUUID()),create:'dispatched',compute_created:true,create_settled:true,
      compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned',...overrides};
    await writeFile(join(directory,id+'.json'),JSON.stringify(row));
    return {id,bytes:await readFile(join(directory,id+'.json'))};
  };
  return {root,directory,sbx,write,backend:()=>receiptBackend(root,sbx,{now:()=>Date.UTC(2026,10,7)})};
}
// Every field the backend's report contract accepts.
const contract=row=>row&&typeof row.id==='string'&&row.id.length>0&&
  (row.name===undefined||typeof row.name==='string'&&/^wf-[a-f0-9]{16}$/.test(row.name))&&
  (row.home===undefined||typeof row.home==='string'&&row.home.startsWith('/')&&!/[\0\r\n]/.test(row.home));

const DEADLINE={deadline_at:1000,deadline_clock:{version:1,boot_id:'malformed-test',boot_at:1000}};
const HOME=()=>process.env.FARAVAN_SBX_HOME;
const CASES=[
  ['an unsupported version with a newline in its home',{version:99,sbx_home:'/bad\nhome'},{name:GOOD,home:undefined}],
  ['an unsupported version with a carriage return in its home',{version:99,sbx_home:'/bad\rhome'},{name:GOOD,home:undefined}],
  ['an unsupported version with a NUL in its home',{version:99,sbx_home:'/bad\0home'},{name:GOOD,home:undefined}],
  ['an unsupported version with a non-string name',{version:99,sandbox_id:[GOOD]},{name:undefined,home:HOME}],
  ['an unsupported version with an object name',{version:99,sandbox_id:{value:GOOD}},{name:undefined,home:HOME}],
  ['a current record whose home has a newline',{...DEADLINE,sbx_home:'/bad\nhome'},{name:GOOD,home:undefined}],
  ['a current record whose name is not a string',{...DEADLINE,sandbox_id:[GOOD]},{name:undefined,home:HOME}],
];
for(const [label,overrides,expected] of CASES)
test(`${label} blocks only its own target and never rejects the report`,async t=>{
  const f=await fixture(t);
  const bad=await f.write(overrides);
  const other=await f.write({sandbox_id:OTHER,scratch_dir:join(process.env.FARAVAN_SCRATCH_ROOT,'wf-job-'+OTHER+'-'+randomUUID())});
  const report=await f.backend().recoverSandboxDeadlines();
  assert.equal(report.fatal,undefined);
  for(const row of report.rows)assert.ok(contract(row),JSON.stringify(row));
  const entry=report.rows.find(row=>row.id===bad.id);
  assert.ok(entry,'the malformed row is reported by its cleanup id');
  assert.equal(entry.home,typeof expected.home==='function'?expected.home():expected.home,'an invalid home is omitted, a valid one kept');
  assert.equal(entry.name,expected.name);
  assert.notEqual(entry.status,'resolved');
  assert.deepEqual(await readFile(join(f.directory,bad.id+'.json')),bad.bytes,'the malformed record is left byte for byte');
  assert.equal((await readdir(f.directory)).filter(name=>name.endsWith('.json')).length>=1,true);
  assert.ok(other.id,'the unrelated record is still read');
});
