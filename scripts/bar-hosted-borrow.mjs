// Two fresh profiles load the installed app and its coordinator. Only agent execution is synthetic.
import assert from 'node:assert/strict';
import {fork, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeFixtureHome} from '../tests/helpers/test-home-directory.mjs';
import {until} from './bar-hosted-install.mjs';

async function actor(root,scratch,name) {
  const directory=join(scratch,name),home=join(directory,'home');
  await mkdir(home,{recursive:true});initializeFixtureHome(home);
  const child=fork(new URL('../tests/e2e-browser/v1-harness.mjs',import.meta.url),['--fresh-app',root],{
    execPath:join(root,'runtime/bin/node'),stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,
      HOME:home,FARAVAN_TEST_HOME:home,TMPDIR:directory,
      XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),
      FARAVAN_HOME:join(directory,'app'),FARAVAN_COORDINATOR_HOME:join(directory,'coordinator'),
      CODEX_HOME:join(directory,'codex'),CLAUDE_CONFIG_DIR:join(directory,'claude'),
      FARAVAN_NO_BROWSER:'1',FARAVAN_NO_UPDATE:'1',FARAVAN_TEST_LAN_ADDRESS:'127.0.0.1',
      NODE_OPTIONS:'--import='+new URL('../tests/helpers/lan-interfaces.mjs',import.meta.url).href}});
  let ready,exited=false,nextId=0;const pending=new Map();
  child.on('message',message=>{
    if(message.ready)ready=message.ready;
    else {const waiter=pending.get(message.id);pending.delete(message.id);
      message.error?waiter?.reject(Error(name+' fixture control failed')):waiter?.resolve(message.value);}
  });
  child.on('error',()=>{exited=true;});
  child.on('exit',()=>{exited=true;for(const waiter of pending.values())waiter.reject(Error(name+' exited'));pending.clear();});
  const control=async(command,payload)=>{
    assert.equal(exited,false,name+' process exited');
    let timer;
    try{return await new Promise((resolve,reject)=>{
      const id=++nextId;pending.set(id,{resolve,reject});
      timer=setTimeout(()=>{pending.delete(id);reject(Error(name+' '+command+' timed out'));},30_000);
      child.send({id,command,payload},error=>{if(error){pending.delete(id);reject(error);}});
    });}finally{clearTimeout(timer);}
  };
  const stop=async()=>{
    try{if(!exited)await control('shutdown');}
    finally {
      if(!exited) {
        const ended=once(child,'exit');
        const timer=setTimeout(()=>child.kill('SIGKILL'),10_000);
        try{await ended;}finally{clearTimeout(timer);}
      }
    }
  };
  try {
    await until(()=>{assert.equal(exited,false,name+' startup failed');return ready;},name+' startup');
    assert.equal(ready.runtime.app,join(root,'lib/v1/app.mjs'));
    assert.equal(await realpath(ready.runtime.node),await realpath(join(root,'runtime/bin/node')));
    return {...ready,home,control,stop};
  } catch(error){await stop();throw error;}
}
async function api(peer,path,body) {
  const response=await fetch(peer.origin+path,{method:body===undefined?'GET':'POST',
    headers:{'x-faravan-session-token':peer.token,'faravan-confirm':'yes','content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120_000)});
  // Do not echo response bodies: hosting and invitation responses contain bearer secrets.
  const value=await response.json();
  assert.equal(response.status,200,path+' HTTP status'+(response.ok?'':' ('+String(value.code).replace(/[^a-z_]/g,'')+')'));
  return value;
}
export async function main([root,scratch]) {
  assert.ok(root&&scratch,'Usage: bar-hosted-borrow.mjs INSTALL_ROOT SCRATCH');
  root=resolve(root);scratch=resolve(scratch);await mkdir(scratch,{recursive:true});
  const peers=[];
  try {
    const lender=await actor(root,scratch,'lender');peers.push(lender);
    const borrower=await actor(root,scratch,'borrower');peers.push(borrower);
    assert.notEqual(lender.pid,borrower.pid);assert.notEqual(lender.home,borrower.home);
    const hosted=await api(lender,'/api/ops/hosting.start',{tunnel:'lan',name:'Hosted candidate test'});
    assert.equal(typeof hosted.invite,'string');
    const circle=hosted.circle_id;assert.ok(circle);
    const invitation=await api(borrower,'/api/circles/join-preview',{link:hosted.invite});
    assert.equal(invitation.lanMode,true,'This throwaway circle uses the runner local network');
    await api(borrower,'/api/circles/join',{link:hosted.invite,acknowledgedWarning:true});
    const circlePath='/api/circles/'+encodeURIComponent(circle);
    await api(lender,circlePath+'/approve',{});
    await api(borrower,circlePath+'/check',{});
    assert.ok((await api(borrower,'/api/circles')).some(row=>row.id===circle&&row.membershipProjection?.phase==='approved'));
    const model='gpt-6-luna',effort='medium';
    await api(lender,'/api/agents/codex/run',{model,effort});
    await api(lender,'/api/agents/codex',{useForLending:true});
    await api(lender,'/api/lending/limits',{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false});
    await api(lender,'/api/lending/mode',{circle,mode:'ask'});
    await api(lender,'/api/lending/on',{circle});
    const repo=join(borrower.home,'project');await mkdir(repo);
    const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
    git('init','-q','-b','main');git('config','user.name','Hosted test');git('config','user.email','hosted@example.test');
    git('config','commit.gpgsign','false');
    await writeFile(join(repo,'answer.txt'),'original\n');git('add','answer.txt');git('commit','-qm','Original');
    const before=git('rev-parse','HEAD');
    const sent=await api(borrower,'/api/jobs',{circle,prompt:'Change answer.txt and explain the change.',
      harness:'codex',model,budget_v1:{effort},repo:{path:repo,includeUncommitted:false}});
    const path='/api/jobs/'+encodeURIComponent(sent.jobDigest),query='?circle='+encodeURIComponent(circle);
    const card=await until(async()=>(await api(lender,'/api/approvals')).find(row=>row.jobDigest===sent.jobDigest),'lender approval');
    await api(lender,'/api/approvals/'+encodeURIComponent(card.id)+'/accept',{});
    await until(async()=>(await lender.control('state')).runs===1,'fake provider ran once');
    await lender.control('release');
    await until(async()=>(await api(borrower,path+query)).status==='Finished','result delivered',120_000);
    const state=await lender.control('job-state',{circle,jobDigest:sent.jobDigest});
    assert.deepEqual(state.job.payload.requirements.model.any_of,[model]);
    assert.equal(state.job.payload.budget_v1.effort,effort);
    const input={circle,repo,branch:'hosted-result'};
    const preview=await api(borrower,path+'/apply',{...input,dry_run:true});assert.equal(preview.status,'dry_run');
    const applied=await api(borrower,path+'/apply',{...input,dry_run:false,expect:{preview_token:preview.preview_token}});
    assert.equal(applied.status,'applied');assert.equal(applied.branch,input.branch);
    assert.equal(git('show','hosted-result:answer.txt'),'the deterministic G2 change');
    assert.equal(git('rev-parse','hosted-result^'),before);assert.equal(git('rev-parse','HEAD'),before);
    assert.equal(git('status','--porcelain'),'');assert.equal(await readFile(join(repo,'answer.txt'),'utf8'),'original\n');
    assert.equal((await borrower.control('state')).runs,0);
    console.log('Installed borrower joined by link; lender ran the selected model and effort; returned result applied as a branch.');
  } finally {
    const stopped=await Promise.allSettled(peers.reverse().map(peer=>peer.stop()));
    const failure=stopped.find(result=>result.status==='rejected');
    if(failure)throw failure.reason;
    await rm(scratch,{recursive:true,force:true});
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
