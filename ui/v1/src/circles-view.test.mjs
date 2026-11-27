import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { circlePerson, circlesListVM, joinOutcomeVM, memberAvailability, deviceUsage, invitationExpiryLabel } from './circles-view.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {homePeopleVM} from './view-models.mjs';
test('circle rows disclose hosting and known member counts without addresses', () => {
  const [row] = circlesListVM([{id:'c',name:'Friends',origin:'http://10.23.1.2:1234',owned:true}], {circles:[{circle:'c',members:[{},{}]}]}, {configured:true,circle:'c',running:true});
  assert.equal(row.meta, 'Hosted on this computer · 2 computers · Online');
  assert.deepEqual(circlesListVM([{id:'c'}]), []);
});
test('member names prefer local names, use real device names, and never identifiers', () => {
  assert.equal(circlePerson({localName:'Raj',device_name:'ThinkPad'}), 'Raj');
  assert.equal(circlePerson({ownerName:'Raj',device_name:'ThinkPad'}, {self:true}), 'Raj');
  assert.equal(circlePerson({device_name:"Raj’s ThinkPad"}), 'Raj’s ThinkPad');
  for (const name of ['Member 2','a'.repeat(64),'sha256:abcd']) assert.equal(circlePerson({device_name:name}), 'Unnamed computer');
  assert.equal(circlePerson({}, {self:true,deviceName:'Work laptop'}), 'Work laptop');
});
test('availability never equates a stale job with being online', () => {
  assert.equal(memberAvailability({}, {}).word, 'No recent report');
  assert.equal(memberAvailability({}, {self:true,home:{lending:{enabled:false}}}).word, 'Online');
  assert.equal(memberAvailability({}, {self:true,home:{intent:{state:'ready'}}}).word, 'Ready to lend');
  assert.equal(memberAvailability({key_id:'raj'}, {now:Date.parse('2026-10-19T12:00Z'),zone:'UTC',jobs:[{current_attempt:{holder:'raj',claimed_at:'2026-10-19T10:00Z'}}]}).word, 'Last job 2 h ago');
});
test('self availability follows the explicit lending projection in the home status envelope', () => {
  const rawReady={lending:{enabled:true,status:'idle'},intent:{on:true,state:'ready'},state:'ready'};
  const dailyLimit=withLendingProjection(rawReady,{intent:'on',intentState:'resting',admission:'blocked',
    admissionReason:'daily_limit',dailyLimitReached:true});
  const malformed={...rawReady,lendingProjection:null};
  const changedObservation=withLendingProjection(rawReady,{intent:'unknown',intentState:null,admission:'unknown',
    execution:'unknown',dailyLimitReached:null});
  changedObservation.lendingProjection.reasonCode='observation_changed';
  const allowedIdle=withLendingProjection(rawReady,{intent:'on',intentState:'ready',admission:'allowed',
    execution:'idle',dailyLimitReached:false});

  assert.deepEqual(memberAvailability({}, {self:true,home:dailyLimit}), {word:'Online',kind:'off'});
  assert.deepEqual(memberAvailability({}, {self:true,home:malformed}), {word:'Online',kind:'off'});
  assert.deepEqual(memberAvailability({}, {self:true,home:changedObservation}), {word:'Online',kind:'off'});
  assert.deepEqual(memberAvailability({}, {self:true,home:allowedIdle}), {word:'Ready to lend',kind:'on'});
  assert.deepEqual(memberAvailability({online:true,ready:true}, {home:dailyLimit}), {word:'Ready to lend',kind:'on'});
});
test('circle availability callers preserve the Home envelope and isolate self projection logic', () => {
  const circles = readFileSync(new URL('./circles.jsx', import.meta.url), 'utf8');
  const source = readFileSync(new URL('./circles-view.mjs', import.meta.url), 'utf8');
  const selfBranch = source.match(/export function memberAvailability\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.equal((circles.match(/memberAvailability\(member,\s*\{[^}]*home:data\.home/g) ?? []).length, 2);
  assert.doesNotMatch(selfBranch, /intent\?\.state|lending\.status|lending\.enabled|lending\.reason/);
});
test('device usage respects singular jobs and unknown usage', () => {
  assert.equal(deviceUsage({usage:{jobs:1,milliseconds:60000},limits:{dailyJobs:1}}), 'Today: 1 job, 1 min · Up to 1 job a day');
  assert.equal(deviceUsage(), 'Usage unavailable');
});

test('invitation expiry uses remaining hours and leaves unknown deadlines blank', () => {
 const now=Date.parse('2026-10-30T12:00:00Z');
 assert.equal(invitationExpiryLabel(now+1,now),'Invitation expires in 1 hour');
 assert.equal(invitationExpiryLabel(now+3600000,now),'Invitation expires in 1 hour');
 assert.equal(invitationExpiryLabel(now+3600001,now),'Invitation expires in 2 hours');
 assert.equal(invitationExpiryLabel(now,now),'Invitation expired');
 assert.equal(invitationExpiryLabel(null,now),'');
 assert.equal(invitationExpiryLabel('unknown',now),'');
});

import { hostContact } from './circles-view.mjs';
test('host contact uses member job traffic after presence resets, excludes self and future observations', () => {
 const now=Date.parse('2026-10-19T12:00Z'), options={now,zone:'UTC'};
 assert.equal(hostContact({selfKey:'self'}, [{current_attempt:{holder:'raj',claimed_at:'2026-10-19T11:58Z'}}], options), 'Members reached it at 11:58 AM.');
 assert.equal(hostContact({selfKey:'self'}, [{current_attempt:{holder:'self',claimed_at:'2026-10-19T11:58Z'}}], options), '');
 assert.equal(hostContact({selfKey:'self',lastReachedAt:'2026-10-19T12:01Z'}, [], options), '');
 assert.equal(hostContact({selfKey:'self'}, [{historyIdentity:{author:'raj'},waitingTiming:{submittedAt:'2026-10-19T11:50Z'}}], options), 'Members reached it at 11:50 AM.');
});
import {deviceLimitsDraft} from './circles-view.mjs';
test('device limits keep zero distinct from no cap and reject malformed or excessive values', () => {
 assert.deepEqual(deviceLimitsDraft({dailyJobs:'0',dailyMinutes:''}).values,{dailyJobs:0,dailyMinutes:null});
 for(const bad of ['-1','1.5','2147484','Infinity','abc'])assert.equal(deviceLimitsDraft({dailyJobs:bad}).valid,false);
});
import {circleHostingVM} from './circles-view.mjs';
test('ownership never offers to stop an unrelated circle hosted on this computer', () => {
 const circle={id:'friends',owned:true,origin:'https://circle.example.com'};
 assert.equal(circleHostingVM(circle,{configured:true,circle:'other'}).canStop,false);
 assert.equal(circleHostingVM(circle,{configured:false}).canStop,false);
 assert.equal(circleHostingVM(circle,{configured:true,circle:'friends'}).canStop,true);
 assert.equal(circleHostingVM({...circle,origin:null},{configured:true,circle:'friends'}).canStop,false);
});
test('a local circle explains its host scope and provider/log exposure', () => {
 assert.equal(circleHostingVM({id:'local',origin:null},{configured:false}).text,
  'This circle is stored on this computer and is not shared through a circle host. Jobs may still send data to AI providers and leave logs.');
});

test('unknown availability has no status dot and ignores future job times', () => {
 const now=Date.parse('2026-10-19T12:00Z');
 assert.deepEqual(memberAvailability({lastSeenAt:'2026-10-18T12:00Z'}, {now}), {word:'No recent report',kind:null});
 // O-H: a member the presence page reports as online (server-set from the status contract's reading) is never "No recent report".
 assert.deepEqual(memberAvailability({key_id:'raj',online:true,ready:true}, {now}), {word:'Ready to lend',kind:'on'});
 assert.deepEqual(memberAvailability({key_id:'raj',online:true,ready:false}, {now}), {word:'Online',kind:'off'});
 assert.deepEqual(memberAvailability({key_id:'raj'}, {now,jobs:[{current_attempt:{holder:'raj',claimed_at:'2026-10-20T12:00Z'}}]}), {word:'No recent report',kind:null});
 assert.equal(deviceUsage({limits:{dailyJobs:0,dailyMinutes:3}}), 'Usage unavailable · Up to 0 jobs a day · Up to 3 min a day');
});

test('private circles stay out of the shared circle list and leave input order intact', () => {
 const circles=[{id:'private',name:'My devices'}, {id:'shared',name:'Friends',origin:'https://example.com'}, {id:'pending',origin:'https://other.example.com',enrollment:{state:'pending'}}];
 const rows=circlesListVM(circles);
 assert.deepEqual(rows.map(row=>row.id), ['shared','pending']);
 assert.equal(rows.some(row => row.id === 'private'), false);
 assert.equal(circles[0].id,'private');
 assert.equal(rows[0].href,'#/circle/shared');
});

import {keepAwakeVM} from './circles-view.mjs';
test('keep awake reports confirmation separately and offers another check after ten seconds', () => {
 assert.deepEqual(keepAwakeVM({enabled:true,active:true}), {text:'On while connected to power',retry:false});
 assert.equal(keepAwakeVM({enabled:false,active:false}).retry,false);
 assert.deepEqual(keepAwakeVM({enabled:true,active:false}, {requestedAt:1000,now:10999}), {text:'Turning on…',retry:false});
 assert.deepEqual(keepAwakeVM({enabled:true,active:false}, {requestedAt:1000,now:11000}), {text:"Couldn't confirm",retry:true});
});
test('host contact uses the computer zone, dated older contact, and roster heartbeat evidence', () => {
 const now=Date.parse('2026-10-19T12:00Z');
 assert.equal(hostContact({lastReachedAt:'2026-10-19T11:58Z'}, [], {now,zone:'America/Chicago'}), 'Members reached it at 6:58 AM.');
 assert.equal(hostContact({lastReachedAt:'2026-10-18T11:58Z'}, [], {now,zone:'UTC'}), 'Members reached it on Oct 18 at 11:58 AM.');
});

test('host keep-awake reports known power and platform reasons without a futile retry', () => {
 assert.deepEqual(keepAwakeVM({enabled:true,active:false,reason:'on_battery'}, {now:20000,requestedAt:0}), {text:'Waiting for power',retry:false});
 assert.deepEqual(keepAwakeVM({enabled:true,active:false,reason:'unsupported'}, {now:20000,requestedAt:0}), {text:'Keep-awake is not supported on this computer.',retry:false});
});
test('a member without an identity cannot inherit holderless job traffic', () => {
 assert.equal(memberAvailability({}, {now:Date.parse('2026-10-19T12:00Z'),jobs:[{current_attempt:{claimed_at:'2026-10-19T11:00Z'}}]}).word, 'No recent report');
});

import {devicesListVM, hostRestartVM, hostStartProgress} from './circles-view.mjs';
test('canonical devices list deduplicates memberships and keeps nicknames circle scoped', () => {
 const vm=devicesListVM({fingerprint:'self',ownerName:'Ari',name:'Laptop',circles:[{circle:'one',members:[{key_id:'self'}, {key_id:'raj',ownerName:'Raj',device_name:'ThinkPad',localName:'Buddy'}]},{circle:'two',members:[{key_id:'raj',device_name:'ThinkPad'}]}]}, [{id:'one',name:'Friends',origin:'https://one.example'},{id:'two',name:'Projects',origin:'https://two.example'}]);
 assert.equal(vm.rows.length,2);assert.equal(vm.rows[0].name,'Ari');assert.equal(vm.rows[0].avatarName,'Ari');assert.equal(vm.rows[0].href,'#/you/profile');
 assert.equal(vm.rows[1].name,'Raj');assert.equal(vm.rows[1].avatarName,'', 'a nickname from one circle does not become a global avatar');assert.equal(vm.rows[1].meta,'ThinkPad · Friends · Projects');assert.equal(vm.rows[1].href,null);
 assert.equal(devicesListVM({name:'Tessa laptop',circles:[]}).rows[0].avatarName,'', 'the device name is never an avatar name');
 assert.deepEqual(devicesListVM(null),{state:'loading',rows:[]});
});
test('restart uses the configured address and progress has elapsed time after ten seconds', () => {
 assert.equal(hostRestartVM({configured:false}),null);
 assert.equal(hostRestartVM({configured:true,name:'Friends',origin:'https://circle.example',reach:{kind:'url'}}),null);
 assert.deepEqual(hostRestartVM({configured:true,origin:'http://local',reach:{kind:'lan'}}),{tunnel:'lan'});
 assert.equal(hostRestartVM({configured:true,origin:'https://circle.example',reach:{kind:'gozar',audience:'internet'}}),null);
 assert.equal(hostStartProgress(false,42),'');assert.equal(hostStartProgress(true,0),'Starting the circle…');assert.equal(hostStartProgress(true,75),'Starting the circle… 1:15');
});

test('shared circle metadata uses signed owner identity and actual enrollment state', () => {
 const circle={id:'c',origin:'https://circle.example',joinInfo:{ownerName:'Ana',approval:'automatic'},enrollment:{state:'pending'}};
 assert.match(circlesListVM([circle])[0].meta,/Hosted by Ana.*Waiting for host/);
 assert.match(circlesListVM([{...circle,enrollment:{state:'expired'}}])[0].meta,/Invitation expired/);
 assert.doesNotMatch(circlesListVM([{...circle,joinInfo:{}}])[0].meta,/Hosted by Ana/);
});

test('explicit membership projection controls list and join outcome over conflicting raw state', () => {
 const approved={schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown'};
 const pending={schemaVersion:2,kind:'membership',phase:'pending',evidence:{enrollmentState:'pending',origin:true},invitationPolicy:'each'};
 const live={id:'c',name:'Friends',origin:'https://c',enrollment:{state:'pending'},joinInfo:{approval:'each'},membershipProjection:approved};
 assert.doesNotMatch(circlesListVM([live])[0].meta,/Waiting/);
 const outcome=joinOutcomeVM({...live,enrollment:{state:'approved'}},[live]);
 assert.equal(outcome.joined,true);
 assert.equal(outcome.message,'You joined the circle “Friends”');
 const waiting={...live,enrollment:{state:'approved'},membershipProjection:pending};
 assert.match(circlesListVM([waiting])[0].meta,/Waiting for approval/);
 assert.match(joinOutcomeVM(waiting,[waiting]).message,/approve this computer/);
});

test('invalid explicit membership projection stays unknown instead of claiming joined', () => {
 const invalid={id:'c',name:'Friends',origin:'https://c',enrollment:{state:'approved'},membershipProjection:{schemaVersion:2,kind:'membership',phase:'pending',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'each'}};
 assert.match(circlesListVM([invalid])[0].meta,/Membership unknown/);
 assert.equal(joinOutcomeVM(invalid,[invalid]).joined,false);
 assert.match(joinOutcomeVM(invalid,[invalid]).message,/not confirmed/);
});

test('a computer that just joined and has not reported reads as joined, not as "No recent report"',()=>{
  const now=Date.parse('2026-10-22T12:00:00Z'),at=ms=>new Date(now-ms).toISOString();
  const word=(member,jobs)=>memberAvailability(member,{now,zone:'UTC',jobs}).word;
  assert.equal(word({key_id:'k',reported:false,joinedAt:at(9000)}),'Joined just now · not lending yet');
  assert.equal(word({key_id:'k',reported:false,joinedAt:at(12*60000)}),'Joined 12 min ago · not lending yet');
  // Not joined recently, reported before, or presence unreadable: nothing is claimed about lending.
  assert.equal(word({key_id:'k',reported:false,joinedAt:at(3*3600000)}),'No recent report');
  assert.equal(word({key_id:'k',reported:true,online:false,joinedAt:at(9000)}),'No recent report');
  assert.equal(word({key_id:'k',joinedAt:at(9000)}),'No recent report');
  assert.equal(word({key_id:'k',reported:false,joinedAt:at(9000)},[{current_attempt:{holder:'k',completed_at:at(5000)}}]),'Last job just now');
});

test('circle availability uses the same recent host activity as Home',()=>{
 const now=Date.parse('2026-10-23T12:31:00Z');
 const host={key_id:'host',online:false,reported:true,joinedAt:'2026-10-23T12:08:00Z'};
 const jobs=[{circle:{id:'friends'},historyIdentity:{author:'host'},receipt:{finished_at:'2026-10-23T12:08:00Z'}}];
 const circle=memberAvailability(host,{now,zone:'UTC',jobs});
 const home=homePeopleVM([host],{ownId:'friend',now,zone:'UTC',jobs,circleId:'friends'})[0];
 assert.equal(circle.word,'Last job 23 min ago');
 assert.equal(home.state,'Last active 23 min ago');
});

test('circle list shows only a known verified person count and preserves the computer line', () => {
  const row=personCount=>circlesListVM([{id:'c',origin:'https://example.test',owned:true,personCount}],{circles:[{circle:'c',members:[{},{},{}]}]})[0];
  assert.equal(row(2).meta,'2 people · 3 computers');
  assert.equal(row(1).meta,'1 person · 3 computers');
  assert.equal(row(0).meta,'0 people · 3 computers');
  for(const unknown of [undefined,null,-1,1.5,'2',NaN]) assert.equal(row(unknown).meta,'3 computers');
});

test('a hosted circle whose host status is unreadable is neither Offline nor stopped', () => {
  const circle = {id:'c',name:'Friends',origin:'http://10.23.1.2:1234',owned:true};
  const members = {circles:[{circle:'c',members:[{},{}]}]};
  const [unknown] = circlesListVM([circle], members, {configured:true,circle:'c',running:null,processState:'unreadable',statusError:'could not read coordinator status'});
  assert.equal(unknown.hostingAction, null);
  assert.doesNotMatch(unknown.meta, /Offline|Hosting is stopped/);
  assert.match(unknown.meta, /Hosting status unknown/);
  const [stopped] = circlesListVM([circle], members, {configured:true,circle:'c',running:false,processState:'stopped'});
  assert.equal(stopped.hostingAction.label, 'Start hosting');
  assert.match(stopped.meta, /Offline · Hosting is stopped/);
});

// Bug: a joined circle whose host stopped answering looked like any other circle in the list.
test('a circle row says when its host was last seen once the host stops answering', () => {
  const joined = {id:'c', name:'Friends', origin:'https://friends.example', joinInfo:{ownerName:'Ana'},
    membershipProjection:{schemaVersion:3,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true,rosterMembershipVerified:true},invitationPolicy:'unknown'}};
  const now = Date.parse('2026-11-04T23:00:00.000Z'), zone = 'America/Chicago';
  const [offline] = circlesListVM([{...joined, host:{reachable:false, lastReachedAt:'2026-11-04T21:12:00.000Z'}}], undefined, undefined, {now, zone});
  assert.equal(offline.meta, 'Hosted by Ana · Host offline · last seen today at 3:12 PM');
  const [unknownSince] = circlesListVM([{...joined, host:{reachable:false, lastReachedAt:null}}], undefined, undefined, {now, zone});
  assert.equal(unknownSince.meta, 'Hosted by Ana · Host offline');
  assert.equal(circlesListVM([{...joined, host:{reachable:null}}], undefined, undefined, {now, zone})[0].meta, 'Hosted by Ana', 'not checked yet is not offline');
});
