import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {makeRepo,git} from './helpers/git-guest.mjs';
import {createOpsClient} from '../lib/v1/ops/execute.mjs';

test('one agent command sends to a stub lender and saves a new branch without changing working files',{timeout:180000},async t=>{
  const f=await appFixture(t,{change:{path:'README.md',bytes:'Fixed by the stub lender\n'}});
  const source=createSyntheticPace50Source({start:Date.now(),used:{weekly:0,short:0},kappa:{weekly:1_000_000,short:1_000_000}});
  const {owner,lender,circle}=await f.connect({lendingPace50:{source}});
  await api(lender.app,'/api/agents/codex/run',{method:'POST',body:{model:'gpt-6-luna',effort:null}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false,lendingPolicy:{providerConsent:{codex:true}}}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const handoff=await fetch(owner.app.handoffUrl(),{redirect:'manual'});await handoff.text();
  await api(owner.app,'/api/circles/'+circle.id+'/agent-borrowing',{method:'POST',token:null,
    headers:{cookie:handoff.headers.get('set-cookie').split(';')[0],origin:owner.app.origin},body:{enabled:true}});
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const prompt=join(f.root,'task.md');await writeFile(prompt,'Change README and report the change.');
  // A dirty working file must not enter the default committed-HEAD snapshot.
  await writeFile(join(repo.dir,'README.md'),'Owner working file\n');
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../bin/faravan',import.meta.url)),
    'run','--source',repo.dir,'--prompt-file',prompt,'--circle',circle.id,'--harness','codex','--branch','faravan/agent-test','--timeout','90','--json'],
    {env:{...process.env,FARAVAN_HOME:owner.home,FARAVAN_NO_AUTOSTART:'1'},timeout:120000});
  assert.equal(stdout.trim().split('\n').length,1);
  const result=JSON.parse(stdout);
  assert.ok(result.changed_files.includes('README.md'));
  assert.equal(typeof result.seconds_waited,'number');
  assert.equal(git(repo.dir,'show','faravan/agent-test:README.md'),'Fixed by the stub lender');
  assert.equal(git(repo.dir,'rev-parse','HEAD'),repo.commit);
  assert.equal(await readFile(join(repo.dir,'README.md'),'utf8'),'Owner working file\n');
  assert.equal(lender.backend.calls.find(([kind])=>kind==='source')?.[1],'hello\n');
  assert.equal((await api(owner.app,'/api/jobs/'+result.job_id+'?circle='+encodeURIComponent(circle.id))).local.sentByAgent,true);
  assert.match(await readFile(result.transcript_path,'utf8'),/turn.completed|continuation/);
  await assert.rejects(createOpsClient({home:owner.home,autostart:false}).call('jobs.apply',
    {digest:result.job_id,circle:circle.id,repo:repo.dir,branch:'main'}),error=>error.status===409&&error.apply_code==='branch_exists');
  assert.equal(git(repo.dir,'rev-parse','main'),repo.commit);
});
