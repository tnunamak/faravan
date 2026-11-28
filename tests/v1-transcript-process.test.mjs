import './helpers/no-browser.mjs';
import {freshLink} from './helpers/fresh-link.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {json} from './helpers/v1-journey.mjs';
import {transcriptFeedVM} from '../ui/v1/src/transcript-feed.mjs';
import {TRANSCRIPT_PROCESS_OWNER_ABSENT,transcriptProcessUserActive} from './helpers/v1-transcript-process-presence.mjs';
import {installOnlineShim} from './helpers/browser-online-shim.mjs';

test('separate owner and friend processes show private readable live and signed transcripts through a coordinator',{timeout:120000},async t=>{
 assert.equal(TRANSCRIPT_PROCESS_OWNER_ABSENT,true,'the transcript helper must model the owner as absent');
 assert.equal(await transcriptProcessUserActive(),false,'the active-presence callback must report no owner activity');
 const children=[],snapshots=new Map();
 t.after(async()=>{await Promise.all(children.map(async child=>{if(child.exitCode!==null){assert.equal(child.exitCode,0);return;}const exited=once(child,'exit');child.send('stop');const [code]=await exited;assert.equal(code,0);}));});
 const f=await appFixture(t);
 const base=f.override;
 f.override=async ctx=>{
  const m=/^\/jobs\/([a-f0-9]{64})\/transcript$/.exec(ctx.route);
  if(m){const job_digest='sha256:'+m[1];if(ctx.req.method==='POST'){
    const view={job_digest,attempt:ctx.body.attempt,seq:ctx.body.seq,at:new Date().toISOString().replace(/\.\d+Z$/,'Z'),text:ctx.body.text,truncated:ctx.body.truncated,available:true};snapshots.set(job_digest,view);
    json(ctx.res,{job_digest,attempt:view.attempt,seq:view.seq,at:view.at});return true;}
   json(ctx.res,snapshots.get(job_digest)??{job_digest,attempt:null,seq:0,at:null,text:'',truncated:false,available:false});return true;}
  return base(ctx);
 };
 await f.provisionFromHome('owner');
 async function app(name){
  const home=await f.home(name);
  const child=fork(new URL('./helpers/v1-transcript-process-app.mjs',import.meta.url),[home,f.root,name],{stdio:['ignore','ignore','inherit','ipc'],env:{...await f.env(name),CODEX_HOME:home+'/.codex',CLAUDE_CONFIG_DIR:home+'/.claude',DISPLAY:'',WAYLAND_DISPLAY:''}});
  children.push(child);return (await once(child,'message'))[0];
 }
 const owner=await app('owner'),friend=await app('friend');
 assert.notEqual(owner.pid,friend.pid);assert.notEqual(owner.pid,process.pid);assert.notEqual(friend.pid,process.pid);
 await api(owner,'/api/devices',{method:'POST',body:{name:'cedar',ownerName:'Alex Rivers'}});
 await api(friend,'/api/devices',{method:'POST',body:{name:'birch',ownerName:'Robin Chen'}});
 const circle=await api(owner,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Parser helpers'}});
 const {invite}=await api(owner,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
 await api(friend,'/api/circles/join',{method:'POST',body:{link:invite}});
 const pending=await api(owner,'/api/circles/'+circle.id+'/approvals');
 await api(owner,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
 await api(friend,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
 await api(friend,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
 await api(friend,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
 await api(friend,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(friend,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const {jobDigest}=await api(owner,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Fix empty parser input',harness:'codex'}});
 const started=Date.now();
 await waitFor(async()=>{const approvals=await api(friend,'/api/approvals');if(!approvals.length)return false;await api(friend,'/api/approvals/'+approvals[0].id+'/accept',{method:'POST',body:{}});return true;},'friend request',30000);
 for(const [name,app] of [['owner',owner],['friend',friend]]){
  const transcript=await waitFor(async()=>{const view=await api(app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/transcript?circle='+circle.id);return view.text?.includes('src/parse.js')&&view;},name+' live transcript',10000);
  assert.equal(transcript.live,true,name+' is still live before release');
  const running=await api(app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
  assert.equal(running.state,'claimed');assert.ok(!running.result_digest,'no delivered result before release');
  const feed=transcriptFeedVM(transcript.text,{live:true});
  assert.equal(feed.entries.filter(e=>e.kind==='withheld').length,0);
  assert.equal(feed.entries.find(e=>e.tool==='Read')?.target,'src/parse.js');assert.equal(feed.entries.find(e=>e.tool==='Edit')?.target,'src/parse.js');
  assert.doesNotMatch(transcript.text,/private details withheld|DO_NOT_EXPORT/);
  t.diagnostic(name+' live transcript visible after '+(Date.now()-started)+' ms; app PID '+app.pid+'; coordinator PID '+process.pid);
 }
 assert.ok(Date.now()-started<20000,'both feeds arrive while the run is held');
 if(process.env.TRANSCRIPT_PROCESS_SHOTS){
  const {mkdir,writeFile}=await import('node:fs/promises');
  const {chromium}=await import('playwright');
  installOnlineShim(chromium);
  const dir=process.env.TRANSCRIPT_PROCESS_SHOTS;await mkdir(dir,{recursive:true});
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();const log=[];
  for(const seconds of (process.env.TRANSCRIPT_PROCESS_AT??'10,25,40').split(',').map(Number)){
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,started+seconds*1000-Date.now())));
   for(const [name,app] of [['owner',owner],['friend',friend]]){
    const before=Date.now();const transcript=await api(app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/transcript?circle='+circle.id);
    log.push({name,scheduledSeconds:seconds,actualSeconds:(Date.now()-started)/1000,pid:app.pid,latency:Date.now()-before,rows:transcriptFeedVM(transcript.text).entries.length});
    for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
     await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
     await page.goto((await freshLink(app.origin,app.token))+'#/job/'+encodeURIComponent(jobDigest)+'/'+circle.id);
     await page.locator('.feed-target',{hasText:'src/parse.js'}).first().waitFor({timeout:10000});
     assert.equal(await page.locator('.feed-withheld').count(),0);
     const pageText=await page.locator('body').innerText();
     assert.ok((pageText.match(/No new output for/g)??[]).length<=1,'silence is stated at most once');
     await page.screenshot({path:dir+'/'+name+'-'+seconds+'s-'+size+'-'+theme+'.png',fullPage:true});
     await writeFile(dir+'/'+name+'-'+seconds+'s-'+size+'-'+theme+'.txt',pageText);
    }
   }
  }
  await writeFile(dir+'/latency.json',JSON.stringify(log,null,2));await browser.close();
 }
 children[1].send('release');
 try {
  await waitFor(async()=>{const job=await api(owner,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);return job.state==='result-accepted';},'signed result',45000);
 } catch(error) {
  const job=await api(owner,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
  const status=await api(friend,'/api/status');
  t.diagnostic(JSON.stringify({state:job.state,attempt:job.current_attempt,lending:status.lendingProjection}));
  throw error;
 }
 const uploaded=await api(owner,'/api/jobs/'+encodeURIComponent(jobDigest)+'/transcript?circle='+circle.id);
 assert.match(uploaded.text,/src\/parse\.js/);assert.doesNotMatch(uploaded.text,/private details withheld|DO_NOT_EXPORT/);
});
