import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fixture, parseOne } from './helpers/v1-journey.mjs';
import { createJobOperations } from '../lib/v1/cli.mjs';
import { HOST_CAPABILITIES } from '../lib/v1/versions.mjs';
import { canonicalize } from '../lib/protocol/index.mjs';
import { openDevice } from '../lib/v1/device.mjs';
import { acquireProcessLockSync, profileWriterLockPath } from '../lib/v1/lock.mjs';

const git='https://example.test/synthetic.git@'+'a'.repeat(40);
async function setup(t,{capabilities=[...HOST_CAPABILITIES]}={}) {
  const f=await fixture(t);
  await f.provisionFromHome('owner');
  const created=await f.cli(['circle','create',f.origin,'--name','Synthetic circle'],'owner');
  assert.equal(created.code,0,created.stderr);
  const circle=[...f.circles.keys()].at(-1);
  f.override=async({res,route})=>{
    if(route!=='/capabilities')return false;
    const body=canonicalize({artifact_head:false,faravan:null,min_member:null,capabilities});
    res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);return true;
  };
  return {f,circle,ops:createJobOperations({home:await f.home()})};
}
const posts=f=>f.requests.filter(r=>r.method==='POST'&&r.route==='/jobs').length;

test('noSource with a message result signs an explicit empty source and uploads no files',async t=>{
  const {f,circle,ops}=await setup(t);
  const sent=await ops.submit({noSource:true,result:{kind:'message'},prompt:'What is a good name for a cat?',circle});
  const payload=f.jobs.get(sent.jobDigest).job.payload;
  assert.deepEqual(payload.source,{kind:'none'});
  assert.deepEqual(payload.result,{kind:'message'});
  assert.deepEqual(payload.requirements.capabilities,['results_v1']);
  const puts=f.requests.filter(r=>r.method==='PUT'&&r.route.startsWith('/artifacts/'));
  assert.equal(puts.length,1,'only the prompt is uploaded');
  const files=await ops.submit({noSource:true,result:{kind:'files'},prompt:'Make a CSV of primes',circle});
  assert.deepEqual(f.jobs.get(files.jobDigest).job.payload.result,{kind:'files'});
});

test('source selection is exclusive: exactly one of noSource, source, git, sourceTar',async t=>{
  const {f,circle,ops}=await setup(t),before=posts(f);
  const folder=join(f.root,'plain-folder');await mkdir(folder);await writeFile(join(folder,'a.txt'),'a\n');
  for(const input of [
    {noSource:true,git,result:{kind:'message'}},
    {noSource:true,source:folder,result:{kind:'message'}},
    {noSource:true,sourceTar:Buffer.from('x'),result:{kind:'message'}},
    {result:{kind:'message'}},
    {noSource:'yes',result:{kind:'message'}},
  ]) await assert.rejects(ops.submit({...input,prompt:'x',circle}),{code:'invalid_request'},JSON.stringify(Object.keys(input)));
  // A prepared source never combines with noSource.
  await assert.rejects(ops.submit({noSource:true,result:{kind:'message'},prompt:'x',circle},{prepareSource:async()=>({source:folder})}),{code:'invalid_request'});
  assert.equal(posts(f),before,'nothing is sent');
});

test('noSource must say what comes back, and result kinds are closed',async t=>{
  const {f,circle,ops}=await setup(t),before=posts(f);
  for(const result of [undefined,{kind:'branch'}])
    await assert.rejects(ops.submit({noSource:true,...(result?{result}:{}),prompt:'x',circle}),{code:'invalid_request'});
  for(const result of [{kind:'report'},{kind:'diff'},'message',{kind:'message',extra:1},null])
    await assert.rejects(ops.submit({git,result,prompt:'x',circle}),{code:'invalid_request'},JSON.stringify(result));
  assert.equal(posts(f),before);
});

test('branch or no result signs the same filtered Git code-change job',async t=>{
  const {f,circle,ops}=await setup(t);
  const legacy=await ops.submit({git,prompt:'Fix it',circle,draftId:'legacy-branch-0001'});
  const branch=await ops.submit({git,prompt:'Fix it',circle,draftId:'legacy-branch-0001',result:{kind:'branch'}});
  assert.equal(branch.jobDigest,legacy.jobDigest,'explicit branch is the same signed request as no result');
  const payload=f.jobs.get(legacy.jobDigest).job.payload;
  assert.equal(Object.hasOwn(payload,'result'),false);
  assert.deepEqual(payload.requirements.capabilities,['filtered_git_v1']);
  const message=await ops.submit({git,prompt:'Fix it',circle,result:{kind:'message'}});
  assert.notEqual(message.jobDigest,legacy.jobDigest);
  assert.deepEqual(f.jobs.get(message.jobDigest).job.payload.result,{kind:'message'});
  await assert.rejects(ops.submit({git,prompt:'Fix it',circle,draftId:'legacy-branch-0001',result:{kind:'files'}}),{code:'draft_changed'});
});

test('get retains signed source kind for legacy and typed jobs',async t=>{
  const {f,circle,ops}=await setup(t);
  const folder=join(f.root,'plain-folder');await mkdir(folder);await writeFile(join(folder,'plain.txt'),'plain\n');
  const cases=[
    ['legacy Git',await ops.submit({git,prompt:'legacy Git',circle}),'git',undefined],
    ['legacy archive',await ops.submit({source:folder,prompt:'legacy archive',circle}),'archive',undefined],
    ['typed Git message',await ops.submit({git,result:{kind:'message'},prompt:'typed Git message',circle}),'git','message'],
    ['typed none message',await ops.submit({noSource:true,result:{kind:'message'},prompt:'typed none message',circle}),'none','message'],
  ];
  for(const [label,submitted,sourceKind,resultKind] of cases){
    const view=await ops.get({digest:submitted.jobDigest,circle});
    assert.equal(view.sourceKind,sourceKind,label+' keeps provenance from the signed source');
    if(resultKind)assert.equal(view.resultKind,resultKind,label+' keeps its typed result');
    else assert.equal(Object.hasOwn(view,'resultKind'),false,label+' remains a legacy code-change job');
  }
  assert.equal(f.jobs.get(cases[0][1].jobDigest).job.payload.source.kind,'git');
  assert.equal(f.jobs.get(cases[1][1].jobDigest).job.payload.source.kind,'archive');
});

test('an older host without results_v1 refuses a typed job before anything is sent',async t=>{
  const {f,circle,ops}=await setup(t,{capabilities:['heartbeat_v1']}),before=posts(f);
  await assert.rejects(ops.submit({noSource:true,result:{kind:'message'},prompt:'x',circle}),{code:'host_too_old'});
  assert.equal(posts(f),before);
  await assert.rejects(ops.submit({git,prompt:'requires filtered source support',circle}),{code:'host_too_old'});
  assert.equal(posts(f),before,'pinned Git also requires its own host capability');
});

test('CLI: --no-source and --result build the same typed job',async t=>{
  const {f,circle}=await setup(t);
  const ok=parseOne(await f.cli(['job','submit','--yes','--no-source','--result','message','--prompt','Explain monads','--circle',circle,'--json']));
  const payload=f.jobs.get(ok.jobDigest).job.payload;
  assert.deepEqual([payload.source,payload.result],[{kind:'none'},{kind:'message'}]);
  const folderFiles=parseOne(await f.cli(['job','submit','--yes','--git',git,'--result','files','--prompt','Plot it','--circle',circle,'--json']));
  assert.deepEqual(f.jobs.get(folderFiles.jobDigest).job.payload.result,{kind:'files'});
  for(const args of [['--no-source','--git',git,'--result','message'],['--no-source'],['--no-source','--result','report']]) {
    const bad=await f.cli(['job','submit','--yes',...args,'--prompt','x','--circle',circle,'--json']);
    assert.equal(bad.code,2,args.join(' ')+': '+bad.stdout);
  }
});

async function tree(f,files) {
  const dir=await mkdtemp(join(f.root,'tree-'));
  for(const [name,text] of Object.entries(files)){await mkdir(join(dir,name,'..'),{recursive:true});await writeFile(join(dir,name),text);}
  return gzipSync(execFileSync('tar',['--format=ustar','--owner=0','--group=0','--numeric-owner','-cf','-',...Object.keys(files)],{cwd:dir}));
}
const transcriptOf=text=>JSON.stringify({type:'result',subtype:'success',is_error:false,result:text})+'\n';

test('readResult returns a message job\'s final message and saves it beside faravan-output/',async t=>{
  const {f,circle,ops}=await setup(t);
  const {jobDigest}=await ops.submit({noSource:true,result:{kind:'message'},prompt:'Name a cat',circle});
  await f.complete(jobDigest,'owner',{output:{kind:'message'},transcript:transcriptOf('# Names\n\n- Miso'),
    candidate:await tree(f,{'faravan-output/names.csv':'Miso\n'}),receipt:{candidate_format:'tree'}});
  const out=join(f.root,'message-out');await mkdir(out);
  const read=await ops.readResult({digest:jobDigest,circle,out});
  assert.equal(read.preview,'# Names\n\n- Miso');
  assert.deepEqual(read.output,{kind:'message'});
  assert.equal(read.message_path,join(out,'message.md'));
  assert.equal(await readFile(join(out,'message.md'),'utf8'),'# Names\n\n- Miso\n');
  assert.equal(await readFile(join(out,'faravan-output/names.csv'),'utf8'),'Miso\n');
});

test('readResult cannot write the profile cache after migration acquires its gate', async t => {
  const {f,circle,ops} = await setup(t);
  const {jobDigest} = await ops.submit({noSource:true,result:{kind:'files'},prompt:'file',circle});
  await f.complete(jobDigest,'owner',{output:{kind:'files'},transcript:transcriptOf('done'),
    candidate:await tree(f,{'faravan-output/result.txt':'result'}),receipt:{candidate_format:'tree'}});
  const home = await f.home(), device = await openDevice({home});
  const client = await device.client(circle);
  let release;
  const guarded = createJobOperations({home, device:{...device, jobReadClient:async () => ({...client,
    fetchTranscript:async (...args) => {
      const bytes = await client.fetchTranscript(...args);
      release = acquireProcessLockSync(profileWriterLockPath(home));
      return bytes;
    },
  })}});
  try {
    await assert.rejects(guarded.readResult({digest:jobDigest,circle}), {code:'lock_busy'});
    await assert.rejects(readdir(join(home,'results')), {code:'ENOENT'});
  } finally { release?.(); }
});

test('readResult refuses an archive that collides with message.md and leaves nothing behind',async t=>{
  const {f,circle,ops}=await setup(t);
  const {jobDigest}=await ops.submit({noSource:true,result:{kind:'message'},prompt:'x',circle});
  await f.complete(jobDigest,'owner',{output:{kind:'message'},transcript:transcriptOf('real answer'),
    candidate:await tree(f,{'message.md':'forged\n'}),receipt:{candidate_format:'tree'}});
  const out=join(f.root,'collide-out');await mkdir(out);
  await assert.rejects(ops.readResult({digest:jobDigest,circle,out}),{code:'path_traversal'});
  assert.deepEqual(await readdir(out),[]);
});

test('readResult keeps legacy code-change results unchanged',async t=>{
  const {f,circle,ops}=await setup(t);
  const {jobDigest}=await ops.submit({git,prompt:'x',circle});
  await f.complete(jobDigest);
  const out=join(f.root,'legacy-out');await mkdir(out);
  const read=await ops.readResult({digest:jobDigest,circle,out});
  assert.equal(Object.hasOwn(read,'output'),false);
  assert.deepEqual(await readdir(out),['summary.txt']);
});

test('typed result extraction rejects hidden root files before writing the answer or any files',async t=>{
 const {f,circle,ops}=await setup(t);
 const {jobDigest}=await ops.submit({noSource:true,result:{kind:'message'},prompt:'x',circle});
 await f.complete(jobDigest,'owner',{output:{kind:'message'},transcript:transcriptOf('real answer'),
   candidate:await tree(f,{'faravan-output/visible.txt':'ok','unexpected.js':'bad'}),receipt:{candidate_format:'tree'}});
 const out=join(f.root,'namespace-out');await mkdir(out);
 await assert.rejects(ops.readResult({digest:jobDigest,circle,out}),{code:'path_traversal'});
 assert.deepEqual(await readdir(out),[]);
});

test('a linked follow-up refuses an older target before uploading any artifacts',async t=>{
 const {f,circle,ops}=await setup(t);
 const {jobDigest}=await ops.submit({circle,prompt:'Parent',noSource:true,result:{kind:'message'}});
 await f.complete(jobDigest,'owner',{output:{kind:'message'},transcript:transcriptOf('Done'),
   candidate:await tree(f,{'faravan-output/answer.txt':'Done'}),receipt:{candidate_format:'tree'}});
 const parentResult=f.jobs.get(jobDigest).result_digest;
 f.override=async({res,route})=>{
   if(route!=='/capabilities')return false;
   const body=canonicalize({artifact_head:false,faravan:null,min_member:null,capabilities:['heartbeat_v1']});
   res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);return true;
 };
 const before=f.requests.filter(r=>r.method==='PUT').length,submitted=posts(f);
 await assert.rejects(ops.submit({circle,prompt:'Continue',followup:{parentJob:jobDigest,parentResult}}),{code:'host_too_old'});
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,before);assert.equal(posts(f),submitted);
});
