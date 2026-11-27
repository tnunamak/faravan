import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {appFixture, api, waitFor} from './helpers/offers-jobs-fixture.mjs';
import {makeRepo} from './helpers/git-guest.mjs';
import * as p from '../lib/protocol/index.mjs';
import {createContributionLog} from '../lib/v1/app.mjs';

test('job changes pass verified signed checks and receipt through without changing snake_case fields', {timeout:30000}, async t => {
  const f=await appFixture(t), {owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt:'Fix the sum',harness:'codex'}});
  const check={cmd:'npm test',exit:0,timed_out:false,parser:'npm',summary:'49 passed',observed_by:'sandbox',changed_test_files:['test/math.test.mjs']};
  const result=await f.complete(jobDigest,'owner');
  const key=createPrivateKey(await readFile(join(await f.home('owner'),'v1','device.pem')));
  const signed=p.signEnvelope('result',{...result.payload,checks:[check]},key);
  Object.assign(f.jobs.get(jobDigest),{result:signed,result_digest:p.digest(signed.payload)});
  const view=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/changes?circle='+circle.id);
  assert.deepEqual(view.checks,[check]); assert.deepEqual(view.receipt,signed.payload.receipt);
  const context={independent:false,agent_mutable_workspace:true,
    note:"Faravan ran npm test after the agent; the agent could change the project's test files and tools."};
  assert.deepEqual(view.check_context,context);
  const receipt=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/receipt?circle='+circle.id);
  assert.deepEqual(receipt.check_context,context);assert.deepEqual(receipt.checks,[check]);
  const altered=p.signEnvelope('result',{...result.payload,checks:[]},key);
  Object.assign(f.jobs.get(jobDigest),{result:altered,result_digest:p.digest(altered.payload)});
  assert.deepEqual((await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/changes?circle='+circle.id)).checks,[]);
});

test('pending transcript is an empty 200; local source path is private and stop timing survives reload', {timeout:30000}, async t => {
  const f=await appFixture(t), {owner,circle}=await f.connect(), repo=await makeRepo();
  t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,repo:{path:repo.dir},prompt:'Fix the sum',harness:'codex'}});
  const path='/api/jobs/'+encodeURIComponent(jobDigest), query='?circle='+circle.id;
  const view=await api(owner.app,path+query);
  assert.equal(view.local.sourcePath,repo.dir); assert.ok(!JSON.stringify(f.jobs.get(jobDigest).job).includes(repo.dir));
  assert.deepEqual(await api(owner.app,path+'/transcript'+query),{text:'',live:false,truncated:false,available:false,unavailable:'lender_version',lastOutputAt:null});
  const cancelled=await api(owner.app,path+'/cancel',{method:'POST',body:{circle:circle.id}});
  const after=await api(owner.app,path+query);
  assert.equal(after.runTiming.stopRequestedAt,cancelled.requested_at);
});


test('actual lender run retains only bounded title and actual agent through local storage and job APIs', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const firstLine='😀'.repeat(125),prompt='\n'+firstLine+'\nPRIVATE second line never retained';
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt,harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  const file=join(lender.home,'v1','contributions.json');
  const log=await waitFor(async()=>{
    try {const log=JSON.parse(await readFile(file,'utf8'));return log.events.some(row=>row.kind==='run')&&log;}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
  },'persisted actual run observation');
  const run=log.events.find(row=>row.kind==='run');
  assert.equal(run.title,'😀'.repeat(120));assert.equal(run.agent,'codex');
  assert.equal(JSON.stringify(log).includes('PRIVATE'),false);
  for(const event of log.events)assert.equal(Object.hasOwn(event,'prompt'),false);
  for(const route of ['/api/jobs','/api/jobs?circle='+circle.id,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id]) {
    const body=await api(lender.app,route),view=Array.isArray(body)?body.find(row=>row.job_digest===jobDigest):body;
    assert.equal(view.title,run.title);assert.equal(view.agent,'codex');
    assert.equal(JSON.stringify(view).includes('PRIVATE'),false);
    assert.equal(Object.hasOwn(view,'prompt'),false);
  }
  const sent=(await api(owner.app,'/api/jobs')).find(row=>row.job_digest===jobDigest);
  assert.equal(Object.hasOwn(sent,'title'),false,'borrower projection does not acquire lender fields');
  assert.equal(Object.hasOwn(sent,'agent'),false,'borrower projection does not acquire lender fields');
});

test('persisted run display facts require matching requester, circle, digest and attempt', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const cases=['valid','absent','author','circle','digest','attempt','borrower','accepted-unstarted'];
  const jobs=[];
  for(const name of cases) {
    const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
      git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt:'Request '+name,harness:'codex'}});
    await f.complete(jobDigest,name==='borrower'?'owner':'lender');
    if(name==='accepted-unstarted') {
      const job=f.jobs.get(jobDigest);
      Object.assign(job,{state:'claimed',attempts_started:0,result:null,result_digest:null});
      Object.assign(job.current_attempt,{state:'active',execution_started_at:null,compute_stopped:false,stopped_at:null});
    }
    jobs.push({name,jobDigest,attempt:f.jobs.get(jobDigest).current_attempt});
  }
  const originalOverride=f.override;
  f.override=async request=>{
    if(request.route.endsWith('/result')) {request.res.writeHead(404);request.res.end();return true;}
    return originalOverride(request);
  };
  await lender.app.close();
  const file=join(lender.home,'v1','contributions.json'),log=createContributionLog(file);
  for(const {name,jobDigest,attempt} of jobs) {
    await log.append({kind:name==='accepted-unstarted'?'accepted':'run',circle:name==='circle'?'different-circle':circle.id,
      keyId:name==='author'?lender.app.device.keyId:owner.app.device.keyId,
      jobDigest:name==='digest'?'sha256:'+'f'.repeat(64):jobDigest,
      attemptId:name==='attempt'?'different-attempt':attempt.attempt_id,at:Date.now(),
      ...(name==='absent'?{}:{title:'😀'.repeat(125),agent:'gemini',prompt:'never persist this'})});
  }
  const stored=await createContributionLog(file).snapshot();
  assert.equal(stored.events[0].title,'😀'.repeat(120));
  assert.equal(JSON.stringify(stored).includes('never persist'),false);
  const restarted=await f.start('lender');
  for(const {name,jobDigest} of jobs) {
    const view=await api(restarted.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
    if(name==='valid') {assert.equal(view.title,'😀'.repeat(120));assert.equal(view.agent,'gemini');}
    else {assert.equal(Object.hasOwn(view,'title'),false,name);assert.equal(Object.hasOwn(view,'agent'),false,name);}
  }
  const listed=await api(restarted.app,'/api/jobs?circle='+circle.id);
  for(const row of listed) {
    const name=jobs.find(job=>job.jobDigest===row.job_digest).name;
    assert.equal(Object.hasOwn(row,'title'),name==='valid',name);
    assert.equal(Object.hasOwn(row,'agent'),name==='valid',name);
  }
});


test('accepted display facts serve running and failed entrypoints without changing run accounting', {timeout:60000}, async t=>{
  const failure=Object.assign(new Error('synthetic entrypoint exit'),{exitCode:1});
  const f=await appFixture(t,{hold:true,runError:failure}),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt:'Show this first line\nPRIVATE remainder',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running held entrypoint');
  const route='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id;
  for(const phase of ['running','failed']) {
    const view=await api(lender.app,route);
    assert.equal(view.title,'Show this first line',phase);assert.equal(view.agent,'codex',phase);
    assert.equal(JSON.stringify(view).includes('PRIVATE'),false);
    const listed=(await api(lender.app,'/api/jobs')).find(row=>row.job_digest===jobDigest);
    assert.equal(listed.title,view.title,phase);assert.equal(listed.agent,view.agent,phase);
    if(phase==='running') {
      assert.equal(view.state,'claimed');
      lender.backend.release();
      await waitFor(()=>f.jobs.get(jobDigest).state==='failed','failed entrypoint');
    }else assert.equal(view.state,'failed');
  }
  const log=JSON.parse(await readFile(join(lender.home,'v1','contributions.json'),'utf8'));
  assert.equal(log.events.filter(row=>row.kind==='run').length,1,'a backend-started entrypoint counts as a run even when it exits unsuccessfully');
  assert.equal(log.events.find(row=>row.kind==='accepted').agent,'codex');
});


test('historical lender agent comes from a cached verified receipt, with missing receipts omitted', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect(),jobs=[];
  for(const label of ['available','unavailable']) {
    const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
      git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt:'Historical '+label+'\nPRIVATE prompt remainder',
      harness:'claude-code',send_anyway:true}});
    await f.complete(jobDigest,'lender',{receipt:{harness:'claude-code-api-key'}});
    jobs.push({label,jobDigest});
  }
  const originalOverride=f.override;
  f.override=async request=>{
    if(request.route==='/jobs/'+jobs[1].jobDigest.slice(7)+'/result') {
      request.res.writeHead(404);request.res.end();return true;
    }
    return originalOverride(request);
  };
  const requests=()=>f.networkTrace.filter(row=>row.device==='lender'&&row.route.endsWith('/result'));
  const list='/api/jobs?circle='+circle.id;
  const first=await api(lender.app,list);
  for(const {label,jobDigest} of jobs) {
    const row=first.find(row=>row.job_digest===jobDigest);
    assert.equal(Object.hasOwn(row,'title'),false,'historical prompt is not fetched for a title');
    if(label==='available')assert.equal(row.agent,'claude-code-api-key','actual receipt selects API key over requested Claude family');
    else assert.equal(Object.hasOwn(row,'agent'),false,'unavailable receipt stays absent');
    assert.equal(JSON.stringify(row).includes('PRIVATE'),false);
  }
  const available=jobs[0].jobDigest;
  const count=()=>requests().filter(row=>row.route.includes(available.slice(7))).length;
  assert.equal(count(),1);
  const global=await api(lender.app,'/api/jobs');
  assert.equal(global.find(row=>row.job_digest===available).agent,'claude-code-api-key');
  const detail=await api(lender.app,'/api/jobs/'+encodeURIComponent(available)+'?circle='+circle.id);
  assert.equal(detail.agent,'claude-code-api-key');assert.equal(count(),1,'repeated list/get reuse verified metadata');
  const ownRequests=()=>f.networkTrace.filter(row=>row.device==='owner'&&row.route.endsWith('/result')).length;
  const before=ownRequests(),sent=await api(owner.app,list);
  assert.equal(sent.every(row=>!Object.hasOwn(row,'agent')),true);assert.equal(ownRequests(),before,'borrower list never hydrates receipts');
  assert.equal(f.networkTrace.some(row=>row.device==='lender'&&row.route.includes('/artifacts/')),false,'receipt hydration downloads no artifacts');
});

test('returned images load through an authenticated bounded endpoint from the signed patch', {timeout:30000},async t=>{
  const {execFileSync}=await import('node:child_process');
  const {writeFile}=await import('node:fs/promises');
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt:'Create an image',harness:'codex'}});
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await writeFile(join(repo.dir,'circle.png'),png);execFileSync('git',['add','circle.png'],{cwd:repo.dir});
  const candidate=execFileSync('git',['diff','--binary','--cached','HEAD'],{cwd:repo.dir});
  await f.complete(jobDigest,'owner',{candidate,candidateMediaType:'text/x-diff',receipt:{candidate_format:'diff',diffstat:{files:1,insertions:0,deletions:0}}});
  const changes=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/changes?circle='+circle.id);
  const url=owner.app.origin+changes.files[0].preview.url;
  assert.equal((await fetch(url)).status,401,'image bytes require the local session');
  const response=await fetch(url,{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.match(response.headers.get('content-security-policy'),/sandbox/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  const bad=await fetch(url.replace('circle.png','..%2Fsecret.png'),{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(bad.status,404,'only paths actually present in the signed patch can be read');
});


test('offers lender claim is approved on borrower and lender pages before execution starts', {timeout:60000}, async t => {
  const {jobStateKey,jobStatusVM} = await import('../ui/v1/src/view-models.mjs');
  const {timelineVM} = await import('../ui/v1/src/job-timeline.mjs');
  const {json,instant} = await import('./helpers/v1-journey.mjs');
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const base=f.override;
  f.override=async ctx=>{
    if(ctx.route.endsWith('/progress')) {json(ctx.res,{job_digest:'sha256:'+ctx.route.split('/')[2],entries:[],next_after:0});return true;}
    if(ctx.route==='/presence') {
      json(ctx.res,{now:instant(),online_seconds:90,persons:[],devices:[
        {device:lender.app.device.keyId,online:true,capabilities:['offers_v1']}
      ]});return true;
    }
    return base(ctx);
  };
  let release;
  const hold=new Promise(resolve=>{release=resolve;});
  const prepare=lender.backend.prepare;
  let preparing=false;
  lender.backend.prepare=async spec=>{
    const handle=await prepare(spec);preparing=true;await hold;return handle;
  };
  try {
    const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
      git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt:'Approved before execution',harness:'codex'}});
    const path='/api/jobs/'+encodeURIComponent(jobDigest),query='?circle='+circle.id;
    assert.equal((await api(owner.app,path+query)).approval,null);
    await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
    await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
    await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
    await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
    const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer review');
    await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
    await waitFor(()=>preparing,'claimed job preparing');
    for (const app of [owner.app,lender.app]) {
      for (const route of [path+query,'/api/jobs'+query,...(app===owner.app?['/api/jobs']:[])]) {
        // A busy display read may return an incomplete observation first. Preparation
        // stays held while every route must expose the approved, unstarted claim.
        const view=await waitFor(async()=>{
          const body=await api(app,route),view=Array.isArray(body)?body.find(row=>row.job_digest===jobDigest):body;
          return view?.approval==='approved'&&view;
        },'approved claim on '+route);
        assert.equal(view.state,'claimed');
        assert.equal(view.current_attempt.execution_started_at,null);
        assert.equal(Object.hasOwn(view.current_attempt,'approved_at'),false);
        assert.equal(view.approval,'approved');
        assert.equal(jobStateKey(view),'approved');
        assert.doesNotMatch(jobStatusVM(view,{role:app===owner.app?'sent':'ran'}).headline,/Waiting for/);
      }
      const timeline=await api(app,path+'/timeline'+query);
      assert.equal(timeline.approval,'approved');
      const approval=timelineVM(timeline,{role:app===owner.app?'sent':'ran'}).rows.find(row=>row.key==='approval');
      assert.equal(approval.detail,'Approved');
      assert.equal(timeline.stages.some(row=>row.key==='running'),false);
    }
  } finally {release();}
});

for (const [name,holder] of [
  ['legacy',{online:true,capabilities:[]}],
  ['unknown capabilities',{online:true}],
  ['offline',{online:false,capabilities:['offers_v1']}],
  ['missing holder',null],
  ['presence unavailable',undefined],
]) {
  const expected=holder===undefined?'no':'pending';
  test('claimed app job projects '+expected+' approval with '+name, {timeout:30000}, async t=>{
    const {json,instant} = await import('./helpers/v1-journey.mjs');
    const {jobStateKey,jobRowVM} = await import('../ui/v1/src/view-models.mjs');
    const f=await appFixture(t),{owner,lender,circle}=await f.connect(),base=f.override;
    f.override=async ctx=>{
      if(ctx.route==='/presence') {
        if(holder===undefined){ctx.res.writeHead(503);ctx.res.end();return true;}
        json(ctx.res,{now:instant(),online_seconds:90,persons:[],devices:holder?[{device:lender.app.device.keyId,...holder}]:[]});return true;
      }
      return base(ctx);
    };
    const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
      git:'https://github.com/example/test.git',commit:'a'.repeat(40),prompt:'Pending approval '+name,harness:'codex',send_anyway:true}});
    await f.complete(jobDigest,'lender');
    const job=f.jobs.get(jobDigest);
    Object.assign(job,{state:'claimed',attempts_started:0,result:null,result_digest:null});
    Object.assign(job.current_attempt,{state:'active',execution_started_at:null,compute_stopped:false,stopped_at:null});
    const view=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
    if(holder===undefined) {
      assert.equal(view.state,'claimed');
      assert.equal(view.current_attempt.execution_started_at,null);
      assert.equal(view.approval,null);
      // Since 0b6622b8 a claimed job that has not started and shows no pending approval reads as waiting.
      assert.equal(view.jobProjection.phase,'waiting');
      assert.equal(view.statusContract.lifecycle,'waiting');
      assert.equal(jobStateKey(view),'waiting');
      assert.equal(jobRowVM(view).headline,'Waiting');
    } else {
      assert.equal(view.approval,'pending',JSON.stringify({state:view.state,projection:view.jobProjection,contract:view.statusContract}));
      assert.equal(jobStateKey(view),'waiting_approval');
    }
  });
}
