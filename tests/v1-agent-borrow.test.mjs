import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, browserApi} from './helpers/v1-app-fixture.mjs';
import {mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {makeRepo} from './helpers/git-guest.mjs';
import {createOpsClient} from '../lib/v1/ops/execute.mjs';

test('bare tokens cannot enable the saved intent; grants stay circle scoped', {timeout:120000}, async t => {
  const f = await appFixture(t);
  const {owner, circle} = await f.connect();
  const app = owner.app;
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const input = {circle:circle.id, prompt:'Say hello', repo:{path:repo.dir}, result:{kind:'message'}};
  const op = (id, body, extra={}) => api(app, '/api/ops/'+id, {method:'POST',body,...extra});
  assert.equal((await op('jobs.submit',input,{status:428})).code,'confirmation_required');
  for (const confirmed of [false,true]) {
    const refused=await api(app,'/api/circles/'+circle.id+'/agent-borrowing',{method:'POST',body:{enabled:true},
      status:403,headers:confirmed?{'faravan-confirm':'yes'}:{}});
    assert.match(refused.message,/Circles/);
  }
  const handoff=await fetch(app.handoffUrl(),{redirect:'manual'});
  const cookie=handoff.headers.get('set-cookie').split(';')[0];
  const browser={token:null,headers:{cookie,origin:app.origin}};
  await api(app,'/api/circles/'+circle.id+'/agent-borrowing',{method:'POST',body:{enabled:true},...browser});
  const permissions=await api(app,'/api/lending');
  assert.equal(permissions.agentBorrowing[circle.id],true);
  const other=await api(app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Other friends'}});
  assert.notEqual(other.id,circle.id);
  assert.equal((await op('jobs.submit',{...input,circle:other.id},{status:428})).code,'confirmation_required');
  assert.equal((await op('jobs.submit',input,{status:428,headers:{origin:app.origin}})).code,'confirmation_required');
  const sent=await op('jobs.submit',{...input,circle:circle.name});
  const job=await api(app,'/api/jobs/'+sent.jobDigest+'?circle='+encodeURIComponent(circle.id));
  assert.equal(job.local.sentByAgent,true);
  assert.equal(job.local.circle,circle.id);
  const client=createOpsClient({home:owner.home,autostart:false,surface:'mcp'});
  const composed=await client.call('jobs.send_and_wait',{...input,prompt:'A second task',timeout_seconds:0});
  assert.ok(composed.jobDigest);
  assert.equal(composed.job.local.sentByAgent,true);
  const refused=await op('jobs.submit',{...input,prompt:'Confirmed send'},{headers:{'faravan-confirm':'yes'}});
  assert.notEqual((await api(app,'/api/jobs/'+refused.jobDigest+'?circle='+encodeURIComponent(circle.id))).local.sentByAgent,true);
  assert.equal((await op('jobs.apply',{digest:refused.jobDigest,circle:circle.id},{status:428})).code,'confirmation_required');
  assert.equal((await op('jobs.cancel',{digest:sent.jobDigest,circle:circle.id},{status:428})).code,'confirmation_required');
  await op('circles.set_agent_borrowing',{circle:circle.id,enabled:false});
  assert.equal((await op('jobs.submit',input,{status:428})).code,'confirmation_required');
  assert.equal((await op('jobs.apply',{digest:sent.jobDigest,circle:circle.id},{status:428})).code,'confirmation_required');
});

async function allow(app,circle) {
  // A same-user token holder can obtain the browser credential. This is saved intent, not human presence.
  const {url}=await api(app,'/api/handoff',{method:'POST',body:{}});
  const handoff=await fetch(url,{redirect:'manual'});await handoff.text();
  const browser={token:null,headers:{cookie:handoff.headers.get('set-cookie').split(';')[0],origin:app.origin}};
  await api(app,'/api/circles/'+circle+'/agent-borrowing',{method:'POST',body:{enabled:true},...browser});
  return browser;
}

test('the fixture sends as a confirmed owner by default; confirm:false is the unconfirmed agent send', {timeout:120000}, async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect(),app=owner.app;
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const input={circle:circle.id,prompt:'Change README',repo:{path:repo.dir}};
  assert.equal((await api(app,'/api/jobs',{method:'POST',body:input,confirm:false,status:428})).code,'confirmation_required');
  const sent=await api(app,'/api/jobs',{method:'POST',body:input});
  assert.notEqual((await api(app,'/api/jobs/'+sent.jobDigest+'?circle='+circle.id)).local.sentByAgent,true,'a confirmed send is not marked as sent by an agent');
  // The web app sends no confirm header and no token; browserApi() is that caller, so tests that model the app use it.
  const viaApp=await (await browserApi(app))('/api/jobs',{method:'POST',body:{...input,prompt:'From the app window'}});
  assert.notEqual((await api(app,'/api/jobs/'+viaApp.jobDigest+'?circle='+circle.id)).local.sentByAgent,true,'the app window is not an agent');
});

test('direct REST and ops share send and apply permission; a local window still sends', {timeout:120000}, async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect(),app=owner.app;
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const input={circle:circle.id,prompt:'Change README',repo:{path:repo.dir}};
  await api(app,'/api/jobs',{method:'POST',body:input,confirm:false,status:428});
  const browser=await allow(app,circle.id);
  const sent=await api(app,'/api/jobs',{method:'POST',body:input,confirm:false});
  assert.equal((await api(app,'/api/jobs/'+sent.jobDigest+'?circle='+circle.id)).local.sentByAgent,true);
  for(const route of ['apply','working-tree']) {
    await api(app,'/api/ops/circles.set_agent_borrowing',{method:'POST',body:{circle:circle.id,enabled:false}});
    await api(app,'/api/jobs/'+sent.jobDigest+'/'+route,{method:'POST',body:{circle:circle.id,dry_run:false},status:428});
    await allow(app,circle.id);
    // Branch apply passes policy and reaches the absent result; working-tree needs explicit confirmation.
    const r=await api(app,'/api/jobs/'+sent.jobDigest+'/'+route,{method:'POST',body:{circle:circle.id,dry_run:false},status:null,raw:true});
    assert.equal(r.status===428,route==='working-tree');await r.text();
    const confirmed=await api(app,'/api/jobs/'+sent.jobDigest+'/'+route,{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:circle.id,dry_run:false},status:null,raw:true});
    assert.notEqual(confirmed.status,428);await confirmed.text();
  }
  await api(app,'/api/ops/circles.set_agent_borrowing',{method:'POST',body:{circle:circle.id,enabled:false}});
  const windowSend=await api(app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Window send',noSource:true,result:{kind:'message'}},...browser});
  assert.ok(windowSend.jobDigest);
});

test('saved permission sends committed Git only and refuses other sources without suggesting confirm', {timeout:120000}, async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect(),app=owner.app;
  await allow(app,circle.id);
  const dir=join(f.root,'private-notes');await mkdir(dir);await writeFile(join(dir,'config.json'),'private');
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  for(const source of [{repo:{path:dir}},{repo:{path:repo.dir,includeUncommitted:true}},{noSource:true},{files:[{path:'notes.txt',base64:'eA=='}]}]) {
    for(const route of ['/api/jobs','/api/ops/jobs.submit']) {
      const refused=await api(app,route,{method:'POST',body:{circle:circle.id,prompt:'x',...source},confirm:false,status:400});
      assert.equal(refused.message,'Commit your changes first, then send again.');
      assert.doesNotMatch(refused.message,/confirm/i);
    }
  }
  assert.equal(f.jobs.size,0);
  // Confirmed plain-folder sends retain their existing behavior.
  assert.ok((await api(app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:circle.id,prompt:'x',repo:{path:dir}}})).jobDigest);
});

test('unconfirmed apply stays in the source repository', {timeout:120000}, async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect(),app=owner.app;
  const a=await makeRepo(),b=await makeRepo();t.after(()=>Promise.all([a,b].map(r=>rm(r.dir,{recursive:true,force:true}))));
  await allow(app,circle.id);
  const sent=await api(app,'/api/ops/jobs.submit',{method:'POST',body:{circle:circle.id,prompt:'x',repo:{path:a.dir}}});
  await api(app,'/api/ops/jobs.apply',{method:'POST',body:{circle:circle.id,digest:sent.jobDigest,repo:b.dir},status:428});
  await api(app,'/api/jobs/'+sent.jobDigest+'/apply',{method:'POST',body:{circle:circle.id,repo:b.dir,dry_run:false},status:428});
});

test('a saved permission change allows an unconfirmed retry with the same key', {timeout:120000}, async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect(),app=owner.app;
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const options={method:'POST',body:{circle:circle.id,prompt:'x',repo:{path:repo.dir}},headers:{'idempotency-key':'agent-retry'}};
  await api(app,'/api/ops/jobs.submit',{...options,status:428});
  await allow(app,circle.id);
  const sent=await api(app,'/api/ops/jobs.submit',options);
  assert.ok(sent.jobDigest);
  assert.equal((await api(app,'/api/ops/jobs.submit',options)).jobDigest,sent.jobDigest);
  assert.equal(f.jobs.size,1);
});

test('leaving and rejoining clears the saved agent permission without changing lender config version', {timeout:120000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle,invite}=await f.connect(),app=lender.app;
  const before=JSON.parse(await readFile(join(lender.home,'v1/app-settings.json'),'utf8')).configVersion;
  await allow(app,circle.id);
  const after=JSON.parse(await readFile(join(lender.home,'v1/app-settings.json'),'utf8')).configVersion;
  await api(app,'/api/circles/'+circle.id+'/leave',{method:'POST',body:{}});
  await api(app,'/api/circles/join',{method:'POST',body:{link:invite}});
  assert.notEqual((await api(app,'/api/lending')).agentBorrowing[circle.id],true);
  assert.equal(after,before);
});

test('direct apply and working-tree require confirmation with permission off', {timeout:120000}, async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect(),app=owner.app;
  const sent=await api(app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:circle.id,prompt:'x',noSource:true,result:{kind:'message'}}});
  for(const route of ['apply','working-tree'])await t.test(route,async()=>{
    await api(app,'/api/jobs/'+sent.jobDigest+'/'+route,{method:'POST',body:{circle:circle.id,dry_run:false},status:428});
    const preview=await api(app,'/api/jobs/'+sent.jobDigest+'/'+route,{method:'POST',body:{circle:circle.id,dry_run:true},status:null,raw:true});
    assert.notEqual(preview.status,428);await preview.text();
  });
});
