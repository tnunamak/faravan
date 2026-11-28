import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-lifecycle-fixture.mjs';
import { createSlots } from '../lib/v1/client.mjs';
import { createSavedReads, markSaved, jobReadKey, jobListKey } from '../lib/v1/saved-reads.mjs';

// Judge r7 O4, O5 and O7 at the app boundary: a finished job read in parallel, then read again with its host down.
const realFetch=globalThis.fetch;
function hostControl(origin) {
  const control={down:false,inFlight:new Map(),peak:new Map()};
  globalThis.fetch=async(url,options={})=>{
    if(!String(url).startsWith(origin))return realFetch(url,options);
    if(control.down)throw new TypeError('fetch failed');
    if(control.gateway)return new Response('<html>Bad gateway</html>',{status:502,headers:{'content-type':'text/html'}});
    const proof=options.headers?.['Faravan-Proof'],device=proof?JSON.parse(Buffer.from(proof,'base64url')).payload.key_id:null;
    const download=(options.method??'GET')==='GET'&&/\/artifacts\//.test(String(url));
    if(!download)return realFetch(url,options);
    control.inFlight.set(device,(control.inFlight.get(device)??0)+1);
    control.peak.set(device,Math.max(control.peak.get(device)??0,control.inFlight.get(device)));
    try {
      // Hold each transfer briefly, as a slow host does, so parallel reads overlap.
      await new Promise(resolve=>setTimeout(resolve,150));
      const response=await realFetch(url,options),body=await response.arrayBuffer();
      return new Response(body,{status:response.status,headers:response.headers});
    } finally {control.inFlight.set(device,control.inFlight.get(device)-1);}
  };
  return control;
}

async function finishedJob(t) {
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  t.after(()=>{globalThis.fetch=realFetch;});
  const control=hostControl(f.origin);
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic offline task',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval card',30000);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(jobDigest).state==='result-accepted','signed result',30000);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  return {f,owner,lender,circle,jobDigest,control,ownerKey:owner.app.device.keyId};
}

test('with the host down, the job list, the job and its result come from the last good copy, marked with when it was saved',{timeout:90000},async t=>{
  const {owner,circle,jobDigest,control}=await finishedJob(t);
  const base='/api/jobs/'+encodeURIComponent(jobDigest),q='?circle='+circle.id;
  const live={list:await api(owner.app,'/api/jobs'),circleList:await api(owner.app,'/api/jobs'+q),job:await api(owner.app,base+q),changes:await api(owner.app,base+'/changes'+q),
    receipt:await api(owner.app,base+'/receipt'+q),thread:await api(owner.app,base+'/thread'+q)};
  assert.equal(live.job.savedAt,undefined,'a live answer is not marked saved');
  control.down=true;
  const list=await api(owner.app,'/api/jobs'),circleList=await api(owner.app,'/api/jobs'+q);
  const job=await api(owner.app,base+q),changes=await api(owner.app,base+'/changes'+q);
  const receipt=await api(owner.app,base+'/receipt'+q),thread=await api(owner.app,base+'/thread'+q);
  for(const [name,value] of Object.entries({list:list[0],circleList:circleList[0],job,changes,receipt,thread}))
    assert.ok(Number.isFinite(Date.parse(value.savedAt)),name+' says when its copy was saved');
  assert.equal(list.length,1);assert.equal(list[0].job_digest,jobDigest);assert.equal(list[0].role,'sent');
  assert.equal(job.job_digest,jobDigest);assert.equal(job.state,live.job.state);
  assert.deepEqual({...changes,savedAt:undefined,savedReason:undefined},{...live.changes,savedAt:undefined,savedReason:undefined});
  // A read that never succeeded still says the host is unreachable.
  const missing=await realFetch(owner.app.origin+base+'/retention'+q,{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(missing.status,409);assert.equal((await missing.json()).code,'network_error');
  control.down=false;
  assert.equal((await api(owner.app,base+q)).savedAt,undefined,'the host answers again: live, unmarked');
});

test('saved reads stay within their byte budget; delete and leave forget what they must, and only that',()=>{
  let clock=0;const saved=createSavedReads({maxBytes:100,maxEntryBytes:60,now:()=>++clock});
  const a=jobReadKey('c1','j1',''),b=jobReadKey('c1','j2',''),c=jobReadKey('c1','j3','');
  saved.remember(a,{text:'x'.repeat(30)});saved.remember(b,{text:'y'.repeat(30)});saved.remember(c,{text:'z'.repeat(30)});
  assert.equal(saved.recall(a),null,'oldest copy dropped past the budget');
  assert.equal(saved.recall(b).value.text,'y'.repeat(30));
  saved.remember(jobReadKey('c1','big',''),{text:'w'.repeat(100)});assert.equal(saved.recall(jobReadKey('c1','big','')),null,'an entry over its cap is not kept');
  const big=createSavedReads();
  for(const [circle,digest] of [['c1','j1'],['c1',null],['c2',null],['c2','j9']])big.remember(digest?jobReadKey(circle,digest,'changes?x'):jobListKey(circle),{n:1});
  big.forgetJob('j1','c1');
  assert.equal(big.recall(jobReadKey('c1','j1','changes?x')),null);assert.equal(big.recall(jobListKey('c1')),null,'its circle list goes too');
  assert.equal(big.recall(jobListKey('c2')),null,'deleting a digest invalidates every saved list');
  assert.ok(big.recall(jobReadKey('c2','j9','changes?x')),'unrelated job copies stay');
  big.remember(jobReadKey('c1','j1','changes?x'),{n:2});assert.equal(big.recall(jobReadKey('c1','j1','changes?x')),null,'a read that finishes after the delete is not saved');
  big.remember(jobListKey('c1'),[{job_digest:'j1'},{job_digest:'j7'}],big.ticket(jobListKey('c1')));
  assert.deepEqual(big.recall(jobListKey('c1')).value,[{job_digest:'j7'}],'a list saved after the delete does not bring the job back');
  big.forgetCircle('c2');assert.equal(big.recall(jobListKey('c2')),null);assert.equal(big.recall(jobReadKey('c2','j9','changes?x')),null);
  assert.deepEqual(markSaved([{a:1},2],'T'),[{a:1,savedAt:'T',savedReason:'unreachable'},2]);
  assert.deepEqual(markSaved({a:1},'T','busy'),{a:1,savedAt:'T',savedReason:'busy'});
});

test('with the host down and nothing saved, the job list keeps its honest error instead of reading as empty',{timeout:90000},async t=>{
  const {owner,control}=await finishedJob(t);
  control.down=true;
  const response=await realFetch(owner.app.origin+'/api/jobs',{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'network_error');
});

test('behind a tunnel that answers 502, saved reads are served and the rest say network_error, never 502',{timeout:90000},async t=>{
  const {owner,circle,jobDigest,control}=await finishedJob(t);
  const base='/api/jobs/'+encodeURIComponent(jobDigest),q='?circle='+circle.id;
  await api(owner.app,base+q);
  control.gateway=true;
  assert.ok((await api(owner.app,base+q)).savedAt,'the saved job is served');
  const missing=await realFetch(owner.app.origin+base+'/retention'+q,{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(missing.status,409);assert.equal((await missing.json()).code,'network_error');
});

test('a gateway or tunnel that says the host is down counts as unreachable; a refusal does not',async()=>{
  const {hostUnreachable}=await import('../lib/v1/saved-reads.mjs');
  for(const status of [502,503,504])assert.equal(hostUnreachable({code:'http_error',status}),true,String(status));
  assert.equal(hostUnreachable({code:'network_error',status:0}),true);
  for(const error of [{code:'forbidden',status:403},{code:'not_found',status:404},{code:'rate_limited',status:429},null])assert.equal(hostUnreachable(error),false);
});

// Judge r8 O5: Jobs listed a delivered result, but opening it cold after the app restarted read "The job didn't load"
// while its host was away. Saved copies are also kept on disk, so a new app process serves them; delete and leave
// remove the files too.
test('O5: saved copies outlive an app restart on disk, and delete and leave remove them there too',async t=>{
  const {mkdtemp,rm,readdir}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  const directory=await mkdtemp(join(process.env.TMPDIR??tmpdir(),'saved-reads-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const job=jobReadKey('c1','j1','?circle=c1'),changes=jobReadKey('c1','j1','changes?circle=c1'),other=jobReadKey('c2','j9','?circle=c2');
  const first=createSavedReads({directory,now:()=>Date.UTC(2026,9,21)});
  first.remember(job,{job_digest:'j1',state:'result-accepted'});first.remember(changes,{files:[{path:'answer.txt'}]});
  first.remember(jobListKey('c1'),[{job_digest:'j1'}]);first.remember(other,{job_digest:'j9'});
  const restarted=createSavedReads({directory});
  assert.deepEqual(restarted.recall(job).value,{job_digest:'j1',state:'result-accepted'},'a new process reads the copy from disk');
  assert.equal(restarted.recall(changes).savedAt,'2026-10-21T00:00:00.000Z','with the time it was saved');
  restarted.forgetJob('j1','c1');
  const again=createSavedReads({directory});
  assert.equal(again.recall(job),null);assert.equal(again.recall(changes),null);assert.equal(again.recall(jobListKey('c1')),null,'its circle list goes too');
  assert.deepEqual(again.recall(other).value,{job_digest:'j9'},'other circles stay');
  again.forgetCircle('c2');
  assert.equal(createSavedReads({directory}).recall(other),null,'leaving a circle removes its files');
  assert.deepEqual((await readdir(directory,{recursive:true})).filter(path=>path.endsWith('.json')),['authority.json'],
    'payload copies are removed; durable invalidation authority stays');
});

test('O5: a result read before an app restart opens cold while its host is down',{timeout:90000},async t=>{
  const {f,owner,circle,jobDigest,control}=await finishedJob(t);
  const base='/api/jobs/'+encodeURIComponent(jobDigest),q='?circle='+circle.id;
  const live={job:await api(owner.app,base+q),changes:await api(owner.app,base+'/changes'+q)};
  await owner.app.close();
  const restarted=(await f.start('owner')).app;
  control.down=true;
  const job=await api(restarted,base+q),changes=await api(restarted,base+'/changes'+q);
  assert.equal(job.job_digest,jobDigest);assert.equal(job.state,live.job.state);
  assert.ok(Number.isFinite(Date.parse(changes.savedAt)),'served from the copy saved before the restart, and says so');
  assert.deepEqual({...changes,savedAt:undefined,savedReason:undefined},{...live.changes,savedAt:undefined,savedReason:undefined});
});

// Dot review P1: a read in flight when a job is deleted or a circle left finishes after the forget; it must not save
// that data again, and a list never keeps a deleted job on disk, where a restart would bring it back.
test('O5: reads in flight during delete or leave never save again, and lists on disk keep no deleted job',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  const directory=await mkdtemp(join(process.env.TMPDIR??tmpdir(),'saved-reads-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const saved=createSavedReads({directory});
  const transcript=jobReadKey('c1','j1','transcript?circle=c1'),list=jobListKey('c1');
  const transcriptTicket=saved.ticket(transcript),listTicket=saved.ticket(list);
  saved.forgetCircle('c1');
  saved.remember(transcript,{text:'private output'},transcriptTicket);
  assert.equal(saved.recall(transcript),null,'a transcript read that started before leaving is not saved');
  assert.equal(createSavedReads({directory}).recall(transcript),null,'nor on disk');
  saved.remember(list,[{job_digest:'j1'}],listTicket);
  assert.equal(saved.recall(list),null,'a list read that started before leaving is not saved');
  saved.remember(list,[{job_digest:'j1'},{job_digest:'j2'}],saved.ticket(list));
  saved.forgetJob('j1','c1');
  saved.remember(list,[{job_digest:'j1'},{job_digest:'j2'}],saved.ticket(list));
  assert.deepEqual(createSavedReads({directory}).recall(list).value,[{job_digest:'j2'}],'after a restart the deleted job is still gone');
});

// Dot review round 2: saved copies are keyed by the circle's own ID, which delete and leave forget. A read that names
// no circle is never saved, so it cannot outlive a leave under a key the leave does not know.
test('O5: a job read that names no circle is not saved, and one that names the circle is',{timeout:90000},async t=>{
  const {owner,circle,jobDigest,control}=await finishedJob(t);
  const base='/api/jobs/'+encodeURIComponent(jobDigest);
  await api(owner.app,base);await api(owner.app,base+'?circle='+circle.id);
  control.down=true;
  const bare=await realFetch(owner.app.origin+base,{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(bare.status,409,'no saved copy for a read without a circle');
  assert.ok(Number.isFinite(Date.parse((await api(owner.app,base+'?circle='+circle.id)).savedAt)),'the read that named its circle is served from its copy');
});

// Dot review round 3: a delete may name no circle (the app finds the job's circle itself). Then the job's copies and
// every circle's lists are removed, so a restart with the host down cannot bring the deleted job back.
test('O5: a delete that names no circle still removes the job’s saved copies everywhere',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  const directory=await mkdtemp(join(process.env.TMPDIR??tmpdir(),'saved-reads-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const saved=createSavedReads({directory}),job=jobReadKey('c1','j1','?circle=c1'),other=jobReadKey('c1','j2','?circle=c1');
  saved.remember(job,{job_digest:'j1'});saved.remember(jobListKey('c1'),[{job_digest:'j1'},{job_digest:'j2'}]);saved.remember(other,{job_digest:'j2'});
  const late=saved.ticket(jobListKey('c1'));
  saved.forgetJob('j1',null);
  saved.remember(jobListKey('c1'),[{job_digest:'j1'}],late);
  const restarted=createSavedReads({directory});
  assert.equal(restarted.recall(job),null);assert.equal(restarted.recall(jobListKey('c1')),null);
  assert.deepEqual(restarted.recall(other).value,{job_digest:'j2'},'other jobs stay');
});

// Judge r9 O-C: with the host down, the saved job list keeps each job's confirmed status, qualified as last known,
// instead of projecting every row as unknown because the host could not be asked again.
test('O-C: saved job rows project their last known status while the host is down',{timeout:90000},async t=>{
  const {owner,jobDigest,control}=await finishedJob(t);
  const live=(await api(owner.app,'/api/jobs')).find(row=>row.job_digest===jobDigest);
  assert.equal(live.jobProjection.phase,'result_accepted');
  control.down=true;
  const saved=(await api(owner.app,'/api/jobs')).find(row=>row.job_digest===jobDigest);
  assert.ok(saved.savedAt,'served from the saved copy');
  assert.equal(saved.jobProjection.phase,'result_accepted','the confirmed status survives the outage');
  assert.equal(saved.jobProjection.observation?.state,'last_known');
});

test('one missing circle cannot hide healthy jobs or replay its saved list',{timeout:90000},async t=>{
  const {f,owner,circle,jobDigest}=await finishedJob(t);
  const missing=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Synthetic removed circle'}});
  const stale=await api(owner.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:missing.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic stale-circle task',harness:'codex'}});
  // Prime actual app caches from successful API reads, not injected cache entries.
  const primed=await api(owner.app,'/api/jobs');
  assert.ok(primed.some(row=>row.job_digest===jobDigest&&row.role==='sent'));
  assert.ok(primed.some(row=>row.job_digest===stale.jobDigest));
  await api(owner.app,'/api/jobs?circle='+missing.id);
  const previousFetch=globalThis.fetch;
  let status=404,missingReads=0;
  globalThis.fetch=async(url,options={})=>{
    const target=new URL(String(url));
    if(target.origin===f.origin&&target.pathname==='/v1/circles/'+missing.id+'/jobs'&&
      (options.method??'GET')==='GET'){
      missingReads++;
      if(status===0)throw new TypeError('fetch failed');
      if(status===410)return Response.json({code:'roster_expired'},{status,headers:{'content-type':'application/problem+json'}});
      return new Response('',{status});
    }
    return previousFetch(url,options);
  };
  t.after(()=>{globalThis.fetch=realFetch;});
  const all=await api(owner.app,'/api/jobs');
  assert.ok(missingReads>0,'the missing circle was actually queried');
  assert.deepEqual(all.map(row=>row.job_digest),[jobDigest]);
  assert.equal(all[0].role,'sent');
  assert.equal(all[0].savedAt,undefined,'healthy circle stays live');
  assert.equal(all[0].jobProjection.phase,'result_accepted');
  status=410;
  const expired=await realFetch(owner.app.origin+'/api/jobs',
    {headers:{'x-faravan-session-token':owner.app.token,'x-faravan-job-history':'1'}});
  assert.equal(expired.status,200);
  const expiredHistory=await expired.json();
  assert.deepEqual(expiredHistory.items.map(row=>row.job_digest),[jobDigest]);
  assert.deepEqual(expiredHistory.circleCoverage.find(row=>row.circleId===missing.id),
    {circleId:missing.id,state:'unavailable',reason:'access'});
  status=404;
  const direct=await realFetch(owner.app.origin+'/api/jobs?circle='+missing.id,
    {headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(direct.status,404,'circle-specific read still refuses');
  // Once404 has invalidated the circle, a later network outage cannot revive it.
  status=0;
  assert.deepEqual((await api(owner.app,'/api/jobs')).map(row=>row.job_digest),[jobDigest]);
  for(status of [401,403]){
    const refused=await realFetch(owner.app.origin+'/api/jobs',
      {headers:{'x-faravan-session-token':owner.app.token}});
    assert.equal(refused.status,status,'authorization failures are not partial-list fallbacks');
  }
  status=404;
  // The healthy host now has no jobs. Its fresh empty list must not turn the
  // missing circle's error into an empty success or revive either cached row.
  f.jobs.delete(jobDigest);
  assert.deepEqual(await api(owner.app,'/api/jobs?circle='+circle.id),[]);
  const empty=await realFetch(owner.app.origin+'/api/jobs',
    {headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(empty.status,404);
  assert.equal((await empty.json()).code,'http_error');
  const jobHistory=()=>realFetch(owner.app.origin+'/api/jobs',
    {headers:{'x-faravan-session-token':owner.app.token,'x-faravan-job-history':'1'}});
  status=0;
  const partial=await jobHistory();
  assert.equal(partial.status,200);
  const {circleCoverage: partialCoverage,...partialBody}=await partial.json();
  assert.deepEqual(partialBody,{items:[],uncheckedCircles:[{id:missing.id,reason:'unreachable'}]});
  assert.deepEqual(partialCoverage.find(row=>row.circleId===missing.id),{circleId:missing.id,state:'unavailable',reason:'unreachable'});
  assert.deepEqual(partialCoverage.find(row=>row.circleId===circle.id),{circleId:circle.id,state:'verified_empty'});
  status=403;
  const {circleCoverage: deniedCoverage,...deniedBody}=await (await jobHistory()).json();
  assert.deepEqual(deniedBody,{items:[],uncheckedCircles:[{id:missing.id,reason:'access'}]});
  assert.deepEqual(deniedCoverage.find(row=>row.circleId===missing.id),{circleId:missing.id,state:'unavailable',reason:'access'});
  status=200;
  globalThis.fetch=previousFetch;
  const recovered=await jobHistory();
  assert.equal(recovered.status,200);
  const history=await recovered.json();
  assert.deepEqual(history.uncheckedCircles,[]);
  assert.deepEqual(history.circleCoverage.find(row=>row.circleId===missing.id),{circleId:missing.id,state:'verified'});
  assert.ok(history.items.some(row=>row.job_digest===stale.jobDigest));
});
