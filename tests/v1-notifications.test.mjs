import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNotificationFeed,notificationSettings,updateNotificationSettings,validJobRoute} from '../lib/v1/notifications.mjs';
import {appFixture,api,boundedFetch} from './helpers/v1-app-fixture.mjs';
const digest='sha256:'+ 'a'.repeat(64),circle='circle-a';
const STATE_BY_STATUS={Waiting:'queued',Starting:'claimed',Running:'claimed',Working:'claimed',Finished:'result-accepted',Failed:'failed',Cancelled:'cancelled',Expired:'expired','Stop requested':'cancelled'};
const own=(status,extra={})=>({job_digest:digest,borrowerCircle:circle,state:STATE_BY_STATUS[status]??status,status,
 ...(status==='Cancelled'?{current_attempt:null}:{}),...extra});
async function feed(t){const dir=await mkdtemp(join(tmpdir(),'faravan-notify-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,feed:await createNotificationFeed(dir)};}

test('cancellation notifications distinguish nothing ran from confirmed stopped execution',async t=>{
 const {adaptLegacyJob}=await import('../lib/v1/state-projection.mjs');
 const at='2026-10-20T00:00:00Z';
 const cases=[
  [{current_attempt:null},'Your job was cancelled','Nothing ran.'],
  [{attempts_started:0,current_attempt:{state:'released',execution_started_at:null,execution_observed_at:null}},'Your job was cancelled','Nothing ran.'],
  [{current_attempt:{state:'released',execution_observed_at:at,compute_stopped:true}},'Your job stopped','Open the job'],
 ];
 for(const [fields,title,body] of cases) for(const projected of [false,true]) {
  const {feed:f}=await feed(t),settings=notificationSettings(),before=f.read().cursor;
  const raw=own('Cancelled',fields);
  const view=projected?{...raw,jobProjection:adaptLegacyJob(raw)}:raw;
  await f.observe(view,settings);await f.observe(view,settings);
  const rows=f.read(before).notifications.filter(row=>row.kind==='stopped');
  assert.equal(rows.length,1);
  assert.equal(rows[0].title,title);
  assert.ok(rows[0].body.startsWith(body));
  assert.equal(rows[0].category,'needs_attention');
 }
});

test('a notification write failure stays pending, reports only a code, and recovers exactly once',async t=>{
 const {dir,feed:f}=await feed(t),settings=notificationSettings();
 await f.observe(own('Waiting'),settings);const after=f.read().cursor;
 const file=join(dir,'notifications.json');await rm(file);await mkdir(file);
 await f.observe(own('Finished'),settings);
 assert.equal(f.status().degraded,true);assert.match(f.status().lastCode,/^E[A-Z]+$/);
 assert.doesNotMatch(JSON.stringify(f.status()),/faravan|\//);
 assert.deepEqual(f.read(after).notifications,[]);
 await f.retry(settings);assert.equal(f.status().degraded,true);
 await rm(file,{recursive:true});await f.retry(settings);
 assert.deepEqual(f.status(),{degraded:false,lastCode:null,dropped:0});
 assert.deepEqual(f.read(after).notifications.map(row=>row.kind),['ready']);
 await f.retry(settings);await f.observe(own('Finished'),settings);
 assert.equal(f.read(after).notifications.length,1);
});

test('a notification write failure queue keeps the newest 100 observations and counts overflow',async t=>{
 const {dir,feed:f}=await feed(t),settings=notificationSettings(),file=join(dir,'notifications.json');
 await mkdir(file);const after=f.read().cursor;
 for(let i=1;i<=150;i++)await f.observe(own('Finished',{job_digest:'sha256:'+String(i).padStart(64,'0')}),settings);
 assert.equal(f.status().degraded,true);assert.match(f.status().lastCode,/^E[A-Z]+$/);assert.equal(f.status().dropped,50);
 await rm(file,{recursive:true});await f.retry(settings);
 assert.deepEqual(f.read(after).notifications.map(row=>decodeURIComponent(row.route.split('/')[2])),Array.from({length:100},(_,i)=>'sha256:'+String(i+51).padStart(64,'0')));
});
test('six notification defaults and atomic validation of independent history/desktop choices',()=>{
 const defaults=notificationSettings();assert.equal(Object.keys(defaults).length,6);
 assert.deepEqual(defaults.circle_activity,{history:true,desktop:false});
 for(const key of ['requests','job_ready','needs_attention','security','lending_attention'])assert.deepEqual(defaults[key],{history:true,desktop:true});
 const changed=updateNotificationSettings(defaults,{job_ready:{desktop:false}});
 assert.deepEqual(changed.job_ready,{history:true,desktop:false});assert.equal(defaults.job_ready.desktop,true);
 for(const invalid of [{unknown:{}},{job_ready:{desktop:'yes'}},{job_ready:{surprise:true}},{job_ready:null}])assert.throws(()=>updateNotificationSettings(defaults,invalid),{code:'invalid_request'});
});
test('borrower transitions are deduplicated, private, cursored and survive restart',async t=>{
 const {dir,feed:f}=await feed(t),settings=notificationSettings();
 await f.observe(own('Waiting'),settings);
 const baseline=f.read().cursor;
 await f.observe({...own('Running'),borrowerCircle:null},settings);
 assert.equal(f.read(baseline).notifications.length,0,'other people never notify');
 await f.observe(own('Starting'),settings);assert.equal(f.read(baseline).notifications.length,0,'claim alone is not started');
 await f.observe(own('Starting',{current_attempt:{attempt_id:'run-1',execution_started_at:'2026-10-20T00:00:00Z',execution_observed_at:null},prompt:'secret',title:'secret task'}),settings);
 assert.equal(f.read(baseline).notifications.length,0,'the durable start-request fence is not a started notification');
 await f.observe(own('Working',{current_attempt:{attempt_id:'run-1',execution_started_at:'2026-10-20T00:00:00Z',execution_observed_at:'2026-10-20T00:00:01Z'},prompt:'secret',title:'secret task'}),settings);
 assert.equal(f.read(baseline).notifications.length,1,'execution start uses the shared Working projection');
 await f.observe(own('Working',{current_attempt:{attempt_id:'run-1',execution_started_at:'2026-10-20T00:00:00Z',execution_observed_at:'2026-10-20T00:00:01Z'}}),settings);
 await f.observe(own('Finished'),settings);
 const result=f.read(baseline);assert.equal(result.notifications.length,2);
 assert.deepEqual(result.notifications.map(n=>n.category),['circle_activity','job_ready']);
 assert.equal(new Set(result.notifications.map(n=>n.id)).size,2);
 assert.equal(result.notifications[1].route,'#/job/'+encodeURIComponent(digest)+'/'+circle);
 assert.doesNotMatch(JSON.stringify(result),/secret/);
 assert.deepEqual(f.read(result.cursor).notifications,[]);
 const restored=await createNotificationFeed(dir);await restored.observe(own('Finished'),settings);
 assert.equal(restored.read(baseline).notifications.length,2);
 assert.equal(restored.read().notifications.length,0,'new clients baseline without replaying history');
});
test('failed, stopped and expired need attention; stop requested never claims cessation',async t=>{
 const {feed:f}=await feed(t),settings=notificationSettings();await f.observe(own('Waiting'),settings);const after=f.read().cursor;
 await f.observe(own('Stop requested'),settings);assert.equal(f.read(after).notifications.length,0);
 for(const [i,status]of ['Failed','Cancelled','Expired'].entries())await f.observe(own(status,{job_digest:'sha256:'+String(i).repeat(64)}),settings);
 assert.deepEqual(f.read(after).notifications.map(n=>n.category),['needs_attention','needs_attention','needs_attention']);
});
test('history choice does not suppress delivery and desktop choice does not suppress history',async t=>{
 const {dir,feed:f}=await feed(t),settings=updateNotificationSettings(notificationSettings(),{job_ready:{history:false},needs_attention:{desktop:false}});
 const after=f.read().cursor;await f.observe(own('Finished'),settings);await f.observe(own('Failed'),settings);
 assert.equal(f.read(after).notifications.length,2);assert.equal(f.read(after).history.length,1);assert.equal(f.read(after).history[0].category,'needs_attention');
 assert.throws(()=>f.read('garbage'),{code:'invalid_request'});
 const stored=await readFile(join(dir,'notifications.json'),'utf8');
 assert.doesNotMatch(stored,/Your job is ready to review/,'history-disabled notification content is not retained on disk');
});
test('app settings use REST and ops, persist and reject invalid writes without partial saves',async t=>{
 const fixture=await appFixture(t),{app}=await fixture.start('settings');
 const initial=await api(app,'/api/notification-settings');assert.deepEqual(initial,notificationSettings());
 await api(app,'/api/ops/notification_settings.set',{method:'POST',body:{job_ready:{desktop:false}}});
 const saved=await api(app,'/api/ops/notification_settings.get',{method:'POST',body:{}});assert.equal(saved.job_ready.desktop,false);
 await api(app,'/api/notification-settings',{method:'POST',body:{requests:{desktop:false},job_ready:{history:'wrong'}},status:400});
 assert.deepEqual(await api(app,'/api/notification-settings'),saved);
 await app.close();
 const restarted=await fixture.start('settings');
 assert.deepEqual(await api(restarted.app,'/api/notification-settings'),saved,'category settings survive app restart');
 const first=await api(restarted.app,'/api/notifications');assert.equal(typeof first.cursor,'string');assert.deepEqual(first.notifications,[]);
 assert.deepEqual((await api(restarted.app,'/api/ops/notifications.list',{method:'POST',body:{after:first.cursor}})).settings,saved);
 await api(restarted.app,'/api/notifications?after=nonsense',{status:400});
});
test('one-time job handoff validates exact app routes and never carries a durable token',async t=>{
 const f=await appFixture(t),{app}=await f.start('job-link');const route='#/job/'+encodeURIComponent(digest)+'/'+circle;
 assert.equal(validJobRoute(route),true);
 const {url}=await api(app,'/api/handoff',{method:'POST',body:{route}});assert.equal(url.includes(app.token),false);
 const response=await boundedFetch(url,{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/'+route);await response.text();
 const replay=await boundedFetch(url,{redirect:'manual'});assert.equal(replay.status,401);await replay.text();
 for(const invalid of ['https://evil.test','//evil.test','#/job/nope',route+'?token=bad',route+'/extra'])await api(app,'/api/handoff',{method:'POST',body:{route:invalid},status:400});
});

test('app feed observes only locally sent jobs from coordinator state, including claimed execution start',async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 const input={circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Secret task content',harness:'codex'};
 const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:input});
 const after=(await api(owner.app,'/api/notifications')).cursor;
 const otherAfter=(await api(lender.app,'/api/notifications')).cursor;
 const raw=f.jobs.get(sent.jobDigest);
 const attempt={attempt_id:'11111111-1111-4111-8111-111111111111',job_digest:sent.jobDigest,generation:1,state:'active',holder:lender.app.device.keyId,
  claimed_at:new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z'),
  lease_expires_at:new Date(Math.floor(Date.now()/1000)*1000+60000).toISOString().replace('.000Z','Z'),
  execution_started_at:new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z'),
  execution_observed_at:new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z'),reason:null,stopped_at:null,compute_stopped:false};
 f.attempts.set(attempt.attempt_id,attempt);
 Object.assign(raw,{state:'claimed',attempts_started:1,current_attempt:attempt});
 let rows;
 const {waitFor}=await import('./helpers/v1-app-fixture.mjs');
 rows=await waitFor(async()=>{const page=await api(owner.app,'/api/notifications?after='+after);return page.notifications.length?page:null;},'borrower start transition');
 assert.equal(rows.notifications[0].kind,'started');assert.equal(rows.notifications[0].category,'circle_activity');
 assert.deepEqual((await api(lender.app,'/api/notifications?after='+otherAfter)).notifications,[]);
 Object.assign(raw,{state:'failed',current_attempt:{...raw.current_attempt,state:'released',compute_stopped:true,stopped_at:new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z')}});
 const last=rows.cursor;
 rows=await waitFor(async()=>{const page=await api(owner.app,'/api/notifications?after='+last);return page.notifications.length?page:null;},'borrower failure transition');
 assert.equal(rows.notifications[0].kind,'failed');assert.doesNotMatch(JSON.stringify(rows),/Secret task content/);
 assert.deepEqual((await api(owner.app,'/api/notifications?after='+rows.cursor)).notifications,[]);
});

test('restored jobs establish a baseline without replaying pre-feature completions',async t=>{
 const {feed:f}=await feed(t),settings=notificationSettings(),after=f.read().cursor;
 await f.observe(own('Finished'),settings,{baseline:true});
 assert.deepEqual(f.read(after).notifications,[]);
 await f.observe(own('Starting',{job_digest:'sha256:'+'b'.repeat(64),current_attempt:{attempt_id:'run-2',execution_started_at:'2026-10-20T00:00:00Z'}}),settings,{baseline:true});
 assert.deepEqual(f.read(after).notifications,[]);
 await f.observe(own('Finished',{job_digest:'sha256:'+'b'.repeat(64)}),settings);
 assert.equal(f.read(after).notifications.length,1,'a running job restored at startup still notifies when ready');
});

test('a job observed waiting before restart retains terminal transitions that happen while closed',async t=>{
 const {dir,feed:f}=await feed(t),settings=notificationSettings();
 await f.observe(own('Waiting'),settings);const after=f.read().cursor;
 const restored=await createNotificationFeed(dir);
 await restored.observe(own('Finished'),settings,{baseline:true});
 assert.equal(restored.read(after).notifications.length,1);
 assert.equal(restored.read(after).notifications[0].kind,'ready');
});

test('a run that completes between polls still records its confirmed execution start once',async t=>{
 const {feed:f}=await feed(t),settings=notificationSettings();await f.observe(own('Waiting'),settings);const after=f.read().cursor;
 const finished=own('Finished',{current_attempt:{attempt_id:'fast-run',execution_started_at:'2026-10-20T00:00:00Z',execution_observed_at:'2026-10-20T00:00:01Z'}});
 await f.observe(finished,settings);await f.observe(finished,settings);
 assert.deepEqual(f.read(after).notifications.map(row=>row.kind),['started','ready']);
});

test('a terminal job with no observed execution does not report a start',async t=>{
 const {feed:f}=await feed(t),settings=notificationSettings();
 await f.observe(own('Waiting'),settings);const after=f.read().cursor;
 await f.observe(own('Finished',{current_attempt:{attempt_id:'unobserved',execution_started_at:'2026-10-20T00:00:00Z',execution_observed_at:null}}),settings);
 assert.deepEqual(f.read(after).notifications.map(row=>row.kind),['ready']);
});

test('settled waits for every queued history write, including ones queued while waiting', async t => {
  const {dir, feed: f} = await feed(t);
  const settings = notificationSettings({});
  f.observe(own('Waiting'), settings);
  const first = f.observe(own('Ready'), settings);
  await f.settled();
  await first;
  f.observe(own('Failed'), settings);
  await f.settled();
  const stored = JSON.parse(await readFile(join(dir, 'notifications.json'), 'utf8'));
  assert.ok(stored.sequence >= 1, 'writes finished before settled resolved');
});

test('active run deduplication survives completed-history eviction and restart',async t=>{
  const {dir,feed:f}=await feed(t),settings=notificationSettings();
  const running=own('Working',{current_attempt:{attempt_id:'active-run',execution_started_at:'2026-10-20T00:00:00Z',execution_observed_at:'2026-10-20T00:00:01Z'}});
  await f.observe(running,settings);
  const file=join(dir,'notifications.json');
  const stored=JSON.parse(await readFile(file,'utf8'));
  for(let i=0;i<4001;i++)stored.observations['completed-'+i]='ready';
  await writeFile(file,JSON.stringify(stored));
  const restored=await createNotificationFeed(dir);const before=restored.read().cursor;
  await restored.observe(own('Waiting',{job_digest:'sha256:'+'f'.repeat(64)}),settings);
  await restored.observe(running,settings);
  assert.equal(restored.read(before).notifications.filter(n=>n.kind==='started').length,0);
  const retained=JSON.parse(await readFile(file,'utf8')).observations;
  assert.equal(Object.values(retained).filter(value=>value==='ready').length,4000,'completed history stays bounded');
  assert.equal(retained[JSON.stringify([circle,digest])],'started:active-run','unresolved execution identity survives');
  assert.equal(retained[JSON.stringify([circle,'sha256:'+'f'.repeat(64)])],'waiting','unresolved waiting jobs survive');
});

test('app records a delayed result after observing a temporary expired failure',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,git:'https://example.test/synthetic.git',commit:'1'.repeat(40),prompt:'Delayed result',harness:'codex'}});
 const after=(await api(owner.app,'/api/notifications')).cursor,raw=f.jobs.get(sent.jobDigest);
 const at=new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z');
 const attempt={attempt_id:'22222222-2222-4222-8222-222222222222',job_digest:sent.jobDigest,generation:1,state:'released',holder:owner.app.device.keyId,
 claimed_at:at,lease_expires_at:at,execution_started_at:at,execution_observed_at:at,reason:'lease_expired',stopped_at:at,compute_stopped:true};
 f.attempts.set(attempt.attempt_id,attempt);
 Object.assign(raw,{state:'failed',attempts_started:1,current_attempt:attempt});
 const {waitFor}=await import('./helpers/v1-app-fixture.mjs');
 const failed=await waitFor(async()=>{const page=await api(owner.app,'/api/notifications?after='+after);return page.notifications.some(n=>n.kind==='failed')?page:null;},'failure notification');
 const failedView=await api(owner.app,'/api/jobs/'+encodeURIComponent(sent.jobDigest)+'?circle='+circle.id);
 assert.equal(failedView.current_attempt.reason,'lease_expired');
 assert.equal(failedView.status,'Failed');
 await f.complete(sent.jobDigest,'owner');
 const p=await import('../lib/protocol/index.mjs'),{createPrivateKey}=await import('node:crypto');
 const key=createPrivateKey(await readFile(join(owner.home,'v1/device.pem')));
 raw.result=p.signEnvelope('result',{...raw.result.payload,attempt_id:attempt.attempt_id},key);
 raw.result_digest=p.digest(raw.result.payload);
 raw.current_attempt={...raw.current_attempt,attempt_id:attempt.attempt_id};
 const acceptedView=await api(owner.app,'/api/jobs/'+encodeURIComponent(sent.jobDigest)+'?circle='+circle.id);
 assert.equal(acceptedView.status,'Finished');
 const ready=await waitFor(async()=>{const page=await api(owner.app,'/api/notifications?after='+failed.cursor);return page.notifications.some(n=>n.kind==='ready')?page:null;},'delayed ready notification',35000);
 assert.equal(ready.notifications.filter(n=>n.kind==='ready').length,1);
});
