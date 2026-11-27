import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requestReviewVM, requestResolutionVM, requestName} from './request-model.mjs';

test('R2 dated confirmed running preserves start evidence without implying current execution',()=>{
 const confirmedAt=Date.parse('2026-10-20T10:01:00Z');
 const vm=requestStartedVM({jobProjection:runningProjection},{confirmedAt,zone:'UTC'});
 assert.match(vm.line,/^Last confirmed running at /);
 assert.match(vm.line,/Started on your computer\./);
 assert.match(vm.line,/Open the job for current status and stop controls\./);
 assert.equal(vm.canStop,true);
 assert.doesNotMatch(requestStartedVM(null,{accepted:true,confirmedAt}).line,/Started on/);
 assert.doesNotMatch(requestStartedVM({jobProjection:runningProjection},{readFailed:true,confirmedAt}).line,/Started on/);
});

test('a persisted decline remains a decline when the request is revisited',()=>{
 const vm=requestResolutionVM({id:'r',activity:[{id:1,type:'approval',data:{id:'r',state:'declined',jobDigest:'job'}}]});
 assert.match(vm.line,/You declined this request/);
 assert.equal(vm.state,'declined');
});
import {adaptLegacyJob} from '../../../lib/v1/state-projection.mjs';
const runningProjection=adaptLegacyJob({state:'running',current_attempt:{execution_started_at:'2026-10-20T10:00:00Z'}});
test('request resolution never borrows an unrelated event', () => {
 const activity=[{id:9,type:'approval',data:{id:'other',state:'expired',jobDigest:'bad'}}];
 assert.equal(requestResolutionVM({id:'r',activity}).href,'#/jobs');
 assert.equal(requestResolutionVM({id:'r',digest:'good',activity}).href,'#/job/good');
 activity.push({id:1,type:'approval',at:'2026-10-20T01:00:00Z',data:{id:'r',state:'accepted',jobDigest:'good',status:'running'}});
 const vm=requestResolutionVM({id:'r',activity,zone:'UTC',job:{jobProjection:runningProjection}});
 assert.equal(vm.href,'#/job/good');
 assert.match(vm.line,/1:00 AM/); assert.match(vm.line,/The job is running/);
});

test('a historical approval status never substitutes for the current projected job',()=>{
 const vm=requestResolutionVM({id:'r',activity:[{id:2,type:'approval',data:{id:'r',state:'accepted',jobDigest:'good',status:'running'}}]});
 assert.doesNotMatch(vm.line,/job is running|starting/);
});
test('names and own identity do not expose identifiers', () => {
 for(const value of ['Member 8','Unnamed device','sha256:aaa','Someone','abcd1234-abcd-1234-abcd-123456789012']) assert.equal(requestName(value),'A circle member');
 assert.equal(requestReviewVM({requester:'self'},{},{fingerprint:'self'}).own,true);
 assert.equal(requestReviewVM({}, {localName:'Pat',requesterName:'Other'}).name,'Pat');
});

import {loadRequest,saveRequest} from './request-model.mjs';
test('answered event retains the matching card digest and fetchable circle even when the terminal event omits it',()=>{
 const vm=requestResolutionVM({id:'r',activity:[{id:1,type:'approval',data:{id:'r',jobDigest:'job',job:{circle:'friends'}}},{id:2,type:'approval',at:'2026-10-20T19:46:00Z',data:{id:'r',state:'accepted'}}],zone:'UTC',job:{jobProjection:runningProjection}});
 assert.equal(vm.digest,'job');assert.equal(vm.circle,'friends');assert.equal(vm.href,'#/job/job/friends');
 assert.equal(vm.heading,'You accepted this request.');
 assert.equal(vm.line,'You accepted this at 7:46 PM. The job is running.');
 assert.equal(vm.action,'Open the job');
});
test('saved request correlation survives a reload without exposing an identifier in copy',()=>{
 const m=new Map(),s={getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)};saveRequest(s,'r',{digest:'job',circle:'friends'});assert.deepEqual(loadRequest(s,'r'),{digest:'job',circle:'friends'});assert.equal(loadRequest(null,'r'),null);
});
test('request history counts only this member in this circle and names its 30-day window',()=>{
 const c={requester:'sam',job:{circle:'friends'}};const vm=requestReviewVM(c,{requesterName:'Sam'},{},{windows:{30:{rows:[{keyId:'sam',circle:'friends',run:2},{keyId:'other',circle:'friends',run:20}]}}});assert.equal(vm.history,'You’ve run 2 of Sam’s jobs in the past 30 days.');
});

test('a creation event never supplies an answer time, and an expired own request has its own copy',()=>{
 const vm=requestResolutionVM({id:'r',activity:[{id:1,type:'approval',at:'2026-10-20T01:00:00Z',data:{id:'r',jobDigest:'job',expiresAt:'2026-10-20T02:00:00Z'}}],zone:'UTC'});
 assert.doesNotMatch(vm.line,/answered at|2:00|1:00/);
 const expired=requestReviewVM({requester:'self',expiresAt:1000},{},{fingerprint:'self'},null,{now:2000,zone:'UTC'});
 assert.equal(expired.heading,'Your request went back to the circle');assert.equal(expired.expiry,'Back for others at 12:00 AM.');
});

import {requestStartedVM} from './request-model.mjs';
test('acceptance does not fabricate a start or stop time before execution confirms it', () => {
 const waiting=requestStartedVM(null,{device:'Laptop',zone:'UTC'});
 assert.match(waiting.line,/^Starting on Laptop/);assert.equal(waiting.canStop,false);assert.doesNotMatch(waiting.line,/stops by/);
 const projected=adaptLegacyJob({state:'claimed',current_attempt:{execution_started_at:'2026-10-20T10:00:00Z'}});
 const running=requestStartedVM({jobProjection:{...projected,evidence:{...projected.evidence,hardStopAt:'2026-10-20T10:20:00Z'}}},{device:'Laptop',zone:'UTC'});
 assert.equal(running.line,'Started on Laptop · stops by 10:20 AM.');assert.equal(running.canStop,true);
});

test('request history distinguishes an empty recorded window from a pending read', () => {
 assert.match(requestReviewVM({}, {requesterName:'Sam'}, {}, {windows:{30:{rows:[]}}}).history,/haven’t run any of Sam/);
 assert.match(requestReviewVM({}, {requesterName:'Sam'}, {}, undefined).history,/haven’t loaded yet/);
});

test('an accepted job that ends before execution never keeps saying Starting', () => {
 for(const state of ['failed','cancelled','expired','result-accepted']) {
  const vm=requestStartedVM({state,...(state==='cancelled'?{current_attempt:null}:{})});assert.equal(vm.terminal,true);assert.equal(vm.canStop,false);assert.doesNotMatch(vm.line,/Starting|Waiting/);
 }
});

test('request start time comes from job projection and its hard stop comes only from projected evidence', () => {
 const projected=adaptLegacyJob({state:'claimed',current_attempt:{execution_started_at:'2026-10-20T10:00:00Z'}});
 const vm=requestStartedVM({jobProjection:{...projected,evidence:{...projected.evidence,hardStopAt:'2026-10-20T10:20:00Z'}},runTiming:{hardStopAt:'2026-10-20T10:50:00Z'}},{device:'Laptop',zone:'UTC'});
 assert.equal(vm.line,'Started on Laptop · stops by 10:20 AM.');
 const noLimit=requestStartedVM({jobProjection:projected,runTiming:{hardStopAt:'2026-10-20T10:20:00Z'}},{device:'Laptop',zone:'UTC'});
 assert.equal(noLimit.line,'Started on Laptop · stop time not confirmed.');
});

test('request status follows every explicit job projection phase and ignores contradictory raw fields',()=>{
 const rows=[
  [{state:'queued'},'waiting','The job is waiting.'],
  [{state:'claimed',approval:'pending'},'approval_pending','Waiting for someone to approve the job.'],
  [{state:'claimed',approval:'approved'},'approved','Approved on your computer. Waiting for the job to start.'],
  [{state:'starting',approval:'approved'},'starting','Starting on Laptop. Waiting for the job to confirm its start.'],
  [{state:'running',current_attempt:{execution_started_at:'2026-10-20T10:00:00Z'}},'running','Started on Laptop · stop time not confirmed.'],
  [{state:'stop-requested'},'stopping','The stop is not confirmed yet. The job may still be working.'],
  [{state:'cancelled',current_attempt:{compute_stopped:true}},'stopped','The job was stopped.'],
  [{state:'failed'},'failed','The job didn’t finish.'],
  [{state:'expired'},'expired','The job expired.'],
  [{state:'result-accepted',result_digest:'sha256:result'},'result_accepted','The result is ready to review.'],
 ];
 for(const [raw,phase,line] of rows){
  const projection=adaptLegacyJob(raw);
  const vm=requestStartedVM({jobProjection:projection,state:'running',current_attempt:{execution_started_at:'2099-01-01T00:00:00Z'}},{device:'Laptop',zone:'UTC'});
  assert.equal(vm.phase,phase);assert.equal(vm.line,line,phase);
 }
});

test('invalid explicit request projection stays unknown and never falls back to raw lifecycle',()=>{
 const vm=requestStartedVM({jobProjection:{schemaVersion:2,kind:'job',phase:'bogus'},state:'running',current_attempt:{execution_started_at:'2026-10-20T10:00:00Z'}});
 assert.equal(vm.phase,'unknown');assert.equal(vm.line,'The job status is not available yet. Refresh the job to check its status.');
 assert.equal(vm.canStop,false);assert.equal(vm.terminal,false);
});

test('request surfaces do not inspect raw job lifecycle or infer status from copy',()=>{
 for(const file of ['./request.jsx','./request-model.mjs']) {
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  assert.doesNotMatch(source,/current_attempt|execution_started_at|jobStateKey|\/\^Starting/);
 }
});

import {requestHeaderVM, requestDeadlineVM, requestDeclinedVM} from './request-model.mjs';
import {requestFactsVM} from './view-models.mjs';
test('deadline counts down in minutes, then seconds, then flips to expired with the exact time and no answer', () => {
 const at=Date.parse('2026-10-20T11:28:00Z');
 const open=requestDeadlineVM({expiresAt:at,now:at-170000,zone:'UTC'});
 assert.equal(open.state,'open');assert.equal(open.countdown,'Answer within 3 min');assert.equal(open.title,'Answer by 11:28 AM');assert.equal(open.urgent,false);
 const last=requestDeadlineVM({expiresAt:at,now:at-42000,zone:'UTC'});
 assert.equal(last.countdown,'Answer within 42 s');assert.equal(last.urgent,true);
 for(const now of [at,at+1,at+180000]){
  const gone=requestDeadlineVM({expiresAt:new Date(at).toISOString(),now,zone:'UTC'});
  assert.equal(gone.state,'expired');assert.equal(gone.line,'This request expired at 11:28 AM. It went back to the circle.');assert.equal(gone.countdown,undefined);
 }
 assert.equal(requestDeadlineVM({expiresAt:undefined,now:at}).state,'unknown');
});

test('legacy review hold ends locally while the signed job remains open to the circle',()=>{
 const at=Date.parse('2026-10-20T11:28:00Z');
 const open=requestDeadlineVM({legacyHold:true,expiresAt:at,now:at-30000,zone:'UTC'});
 assert.equal(open.countdown,'Review window closes in 30 s');
 assert.equal(open.title,'This computer’s review window');
 const ended=requestDeadlineVM({legacyHold:true,expiresAt:at,now:at,zone:'UTC'});
 assert.equal(ended.state,'review-ended');
 assert.equal(ended.line,'This computer’s review window ended at 11:28 AM. The job is back in the circle.');
 const history=requestResolutionVM({id:'review',digest:'job',zone:'UTC',job:{jobProjection:adaptLegacyJob({state:'queued'})},activity:[{id:1,type:'approval',at:'2026-10-20T11:28:00Z',data:{id:'review',jobDigest:'job',state:'review-ended'}}]});
 assert.equal(history.heading,'Review window ended');
 assert.equal(history.line,'This computer’s review window ended at 11:28 AM. The job is back in the circle. The job is waiting.');
});
test('header names the sender and your computer; an own job says so and never borrows a sender', () => {
 const now=Date.parse('2026-10-20T11:31:00Z');
 assert.deepEqual(requestHeaderVM({name:'Sam',device:'sandpiper',circle:'Faravan tomorrow',sentAt:'2026-10-20T11:28:00Z',now}),
  {title:'Sam wants to run a job on your computer (sandpiper)',sub:'Faravan tomorrow · sent 3 min ago'});
 assert.equal(requestHeaderVM({name:'Sam',device:'',now}).title,'Sam wants to run a job on your computer');
 assert.equal(requestHeaderVM({name:'Member 4',device:'sandpiper'}).title,'A circle member wants to run a job on your computer (sandpiper)');
 const own=requestHeaderVM({own:true,name:'You',device:'sandpiper',circle:'Faravan tomorrow',sentAt:now-20000,now});
 assert.deepEqual(own,{title:'Your job is ready to run on your computer',sub:'Faravan tomorrow · sent just now'});
 assert.equal(requestDeclinedVM({name:'Sam'}),'You declined Sam’s request. It went back to the circle.');
 assert.doesNotMatch(requestDeclinedVM({own:true}),/passed on/);
 assert.equal(requestDeclinedVM({name:'Member 3'}),'You declined a circle member’s request. It went back to the circle.');
});
test('own job drops advice meant for other people; facts say "your computer", never "your sandpiper"', () => {
 const card={harness:'claude-code-subscription',network:'internet',runtimeSeconds:1200,job:{requirements:{}}};
 const other=requestFactsVM(card).facts.map(f=>f.text),own=requestFactsVM(card,{own:true}).facts.map(f=>f.text);
 assert.match(other[0],/Native sign-in is only for your own jobs and is never lent\./);
 assert.ok(own.every(t=>!/people you trust|Ask the sender/.test(t)),own.join('|'));
 assert.ok(own.some(t=>/new sandbox on your computer,/.test(t)));
 assert.equal(requestFactsVM(card,{own:true}).heading,'What it can do on your computer');
 assert.ok([...other,...own].every(t=>!/your sandpiper|on this computer/.test(t)));
 assert.match(requestFactsVM({harness:'x',job:{requirements:{}}},{own:true}).facts.find(f=>f.icon==='globe').text,/We can’t tell which websites this job can reach\.$/);
});
test('an expired request answered nowhere says when it expired and where it went', () => {
 const vm=requestResolutionVM({id:'r',activity:[{id:1,type:'approval',data:{id:'r',jobDigest:'job'}},{id:2,type:'approval',at:'2026-10-20T11:28:00Z',data:{id:'r',state:'expired'}}],zone:'UTC'});
 assert.equal(vm.heading,'This request expired');assert.equal(vm.line,'This request expired at 11:28 AM. It went back to the circle.');
});


test('offers show the borrower deadline without a human hold or return-to-circle claim',()=>{
 const now=Date.parse('2026-10-20T12:00:00Z');
 const open=requestDeadlineVM({offer:true,expiresAt:now+3600000,now,zone:'UTC'});
 assert.equal(open.countdown,'Open until 1:00 PM today');
 assert.equal(open.exact,'1:00 PM today');assert.equal(open.title,'The borrower’s deadline');
 assert.doesNotMatch(JSON.stringify(open),/Answer within|Answer by/);
 assert.equal(requestDeadlineVM({offer:true,expiresAt:now,now,zone:'UTC'}).line,'This job expired at 12:00 PM today.');
 assert.match(requestDeclinedVM({offer:true,name:'Sam'}),/You declined this request\. It won’t return on this computer/);
 assert.doesNotMatch(requestDeclinedVM({offer:true,name:'Sam'}),/went back/);
});

test('offer and legacy requests use the same title, including own jobs',()=>{
 for(const own of [false,true]) {
  const input={own,name:'Sam',device:'Tessa’s computer'};
  const expected=own?'Your job is ready to run on your computer':'Sam wants to run a job on your computer (Tessa’s computer)';
  for(const offer of [false,true])assert.equal(requestHeaderVM({...input,offer}).title,expected);
 }
});

test('offer deadline names the calendar day in the viewing zone, including DST and year boundaries',()=>{
 const now=Date.parse('2026-10-20T17:17:00Z');
 for(const [expiresAt,expected] of [
  ['2026-10-20T18:15:00Z','Open until 1:15 PM today'],
  ['2026-10-21T17:15:00Z','Open until tomorrow 12:15 PM'],
  ['2027-01-01T18:15:00Z','Open until Jan 1, 2027 at 12:15 PM'],
 ])assert.equal(requestDeadlineVM({offer:true,expiresAt,now,zone:'America/Chicago'}).countdown,expected);
 assert.equal(requestDeadlineVM({offer:true,expiresAt:'2026-11-02T06:15:00Z',now:Date.parse('2026-11-01T05:30:00Z'),zone:'America/Chicago'}).countdown,'Open until tomorrow 12:15 AM');
 assert.match(requestDeadlineVM({offer:true,expiresAt:now,now,zone:'America/Chicago'}).line,/12:17 PM today/);
});

test('H1 pending, failed read, and dated handoff distinguish acceptance from execution',()=>{
 assert.equal(requestStartedVM(null,{pending:true}).line,'Sending your approval…');
 assert.equal(requestStartedVM(null,{accepted:true,readFailed:true}).line,'We couldn’t confirm the job’s current status. Open the job to check before trying again.');
 const confirmedAt=Date.parse('2026-10-20T10:01:00Z');
 assert.match(requestStartedVM({jobProjection:runningProjection},{confirmedAt,zone:'UTC'}).line,/^Last confirmed running at /);
 for(const raw of [{state:'result-accepted',result_digest:'sha256:result'},{state:'cancelled',current_attempt:{compute_stopped:true}}]){
  const vm=requestStartedVM({jobProjection:adaptLegacyJob(raw)},{confirmedAt,accepted:true});
  assert.equal(vm.terminal,true);assert.doesNotMatch(vm.line,/Last confirmed running|Preparing/);
 }
});

test('H1 source retains dated reload read and stops snapshots on authoritative terminal status',()=>{
 const source=readFileSync(new URL('./request.jsx',import.meta.url),'utf8');
 assert.match(source,/!outcome.pending/);
 assert.match(source,/vm.canStop\|\|vm.terminal/);
 assert.match(source,/setJobReadFailed\(true\)/);
 assert.match(source,/confirmedAt:jobConfirmedAt/);
});

test('H2 known unconfirmed-stop formatter branch cannot fall through to waiting-start copy',()=>{
 const source=readFileSync(new URL('./request-model.mjs',import.meta.url),'utf8');
 assert.match(source,/key==='stop_unconfirmed'\?'Stopping is not confirmed. The job may still be running.'/);
});

test('H4 deferral source includes focus handoff and an enabled Run target',()=>{
 const source=readFileSync(new URL('./request.jsx',import.meta.url),'utf8');
 assert.ok(source.includes('${deadline.state}:${deferred}'));
 assert.match(source,/ref=\{said\} tabIndex="-1" role="status">Still pending/);
 assert.match(source,/runAction.current\?\.querySelector\('button'\)/);
 assert.match(source,/lastDecisionFocus.current && !lastDecisionFocus.current.isConnected/);
});

test('missing request without a matched terminal event reports uncertainty',()=>{
 for(const digest of [undefined,'job']){
  const vm=requestResolutionVM({id:'r',digest,activity:[{id:9,type:'approval',data:{id:'other',state:'accepted'}}]});
  assert.equal(vm.heading,'This request is no longer available here.');
  assert.equal(vm.line,'We couldn’t confirm how this request ended. '+(digest?'Open the job for its latest status.':'Look for it in Jobs.'));
 }
});
test('accepted request without start evidence only acknowledges approval',()=>{
 const jobs=[null,undefined,{jobProjection:{schemaVersion:2,kind:'job',phase:'bogus'}},
  ...[{state:'queued'},{state:'claimed',approval:'pending'},{state:'claimed',approval:'approved'},{state:'starting',approval:'approved'}].map(raw=>({jobProjection:adaptLegacyJob(raw)}))];
 for(const job of jobs){
  const vm=requestStartedVM(job,{accepted:true});
  assert.equal(vm.line,'Your approval was received. Waiting for confirmation that the job has started.');
  assert.equal(vm.canStop,false);assert.equal(vm.transitional,true);
 }
});

test('a request two hours from its deadline asks for an answer within 2 h', () => {
 const at=Date.parse('2026-10-20T11:28:00Z');
 assert.equal(requestDeadlineVM({expiresAt:at,now:at-7200000}).countdown,'Answer within 2 h');
});

test('expired offer resolution explains it cannot be accepted without claiming return to circle',()=>{
 const vm=requestResolutionVM({id:'r',activity:[{id:1,type:'approval',data:{id:'r',state:'expired',offer:true}}]});
 assert.match(vm.line,/Its deadline has passed; this job is no longer available to accept/);
 assert.doesNotMatch(vm.line,/went back to the circle/);
});
