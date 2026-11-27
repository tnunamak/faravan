import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {ConnectionBanner, UpdateToast, PageSkeleton} from './shell-states.jsx';
import {Shell} from './shell.jsx';
import {connectionVM, updateVM, trackFreshness, machineVM} from './view-models.mjs';
import {renderFixture, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';

// U21: the shell's honest states. No browser.
const at = Date.parse('2026-10-19T14:38:00Z');

test('cancelled reads are not stale; a deadline is slow rather than unreachable',()=>{
  assert.equal(connectionVM({connected:true,errors:{jobs:{name:'AbortError'}}}),null);
  const vm=connectionVM({connected:true,errors:{jobs:{code:'read_timeout'}}});
  assert.equal(vm.kind,'error');assert.doesNotMatch(vm.text,/could not connect|Can’t reach/);
});
test('an expected device lock reports an update in progress without a raw refusal code',()=>{
  const vm=connectionVM({connected:true,errors:{jobs:{code:'device_busy',status:409}}});
  assert.equal(vm.kind,'refreshing');assert.match(vm.text,/Wait for the current action/);
  assert.doesNotMatch(vm.text,/409|couldn.t|unreachable/i);
});
test('the sidebar does not present a cached lending state as current while freshness is stale',()=>{
  assert.deepEqual(machineVM({lending:{enabled:true,status:'running'}},{name:'Laptop'},{unavailable:{code:'stale'}}),
    {name:'Laptop',line:'Status needs an update',kind:'off',word:'Unknown'});
});
test('a phone gets one computer-reachability message with no desktop recovery instructions',()=>{
  for(const options of [{online:false},{errors:{home:{code:'network'}}}]){
    const vm=connectionVM({...options,phone:true});
    assert.equal(vm.text,'Can’t reach your computer. Check that it’s awake and on the same network.');
    assert.equal(vm.details,undefined);
  }
});

test('connectionVM: a failed required resource shows stale evidence even while the live stream is up', () => {
  const vm = connectionVM({connected:true, errors:{readiness:new Error('x')}, freshness:{home:'2026-10-19T14:45:00Z', readiness:'2026-10-19T14:38:00Z'}, zone:'UTC'});
  assert.deepEqual([vm.kind, vm.stale, vm.text], ['error', ['readiness'], 'Faravan could not confirm what happened. Check the current state before taking another action.']);
});

test('connectionVM: the time is the failing resource’s own last good read, not the latest of any', () => {
  const vm = connectionVM({connected:true, errors:{agents:1, home:1}, freshness:{home:'2026-10-19T14:50:00Z', agents:'2026-10-19T14:10:00Z', circles:'2026-10-19T14:59:00Z'}, zone:'UTC'});
  assert.equal(vm.asOf, 'Last update 2:50 PM.', 'the time comes from home, the first failing resource that supplies the explanation');
  assert.equal(connectionVM({connected:true, errors:{agents:1}, freshness:{}}).asOf, undefined, 'no time is invented');
});

test('connectionVM: all cached resources report failed reads; a dropped stream alone is "paused"', () => {
  assert.deepEqual(connectionVM({connected:true, errors:{activity:1, devices:1, jobs:1}}).stale, ['devices', 'activity', 'jobs']);
  assert.equal(connectionVM({connected:null}), null);
  const paused = connectionVM({connected:false, errors:{}, freshness:{home:'2026-10-19T14:38:00Z', agents:'2026-10-19T14:20:00Z'}, zone:'UTC'});
  assert.deepEqual([paused.kind, paused.text], ['paused', 'Live updates paused. Check the connection to resume current information.']);
});

test('trackFreshness: only the resource that loaded moves its own timestamp', () => {
  const old = {home:'t1', readiness:'t1'};
  assert.deepEqual(trackFreshness(old, ['home', 'readiness', 'agents'], [true, false, true], 't2'), {home:'t2', readiness:'t1', agents:'t2'});
  assert.deepEqual(old, {home:'t1', readiness:'t1'}, 'the old map is not changed');
});

test('updateVM shows a toast only when the API says an update is ready', () => {
  assert.equal(updateVM({}), null);
  assert.equal(updateVM({update:{ready:false}}), null);
  assert.deepEqual(updateVM({update:{ready:true, version:'1.5.1'}}),
    {icon:'refresh', text:'A new version of Faravan is ready.', action:'Reload', version:'1.5.1'});
});

test('the connection strip is a status with a named action', () => {
  const out = renderFixture(ConnectionBanner, {vm:connectionVM({connected:true, errors:{home:1}, freshness:{home:'2026-10-19T14:38:00Z'}, zone:'UTC'}), onRetry() {}});
  assert.match(withoutMaskMarkers(out), /<div class="offline" role="status">/);
  assert.match(renderedText(out), /Check the current state.*Last update 2:38 PM\. Check current state Copy details/);
  assert.equal(renderFixture(ConnectionBanner, {vm:null}), '');
});

test('the update toast has one button and says what it does', () => {
  const out = renderFixture(UpdateToast, {vm:updateVM({update:{ready:true}})});
  assert.match(withoutMaskMarkers(out), /class="toast-wrap"/);
  assert.match(renderedText(out), /A new version of Faravan is ready\. Reload/);
  assert.equal((out.match(/<button/g) || []).length, 1);
  assert.equal(renderFixture(UpdateToast, {vm:null}), '');
});

test('the skeleton has the shape of a page and a label, and no words of its own', () => {
  const out = renderFixture(PageSkeleton, {label:'Loading Home'});
  assert.match(out, /role="status" aria-label="Loading Home"/);
  assert.ok((withoutMaskMarkers(out).match(/class="skel"/g) || []).length >= 8);
  assert.equal(renderedText(out), '');
});

test('the shell puts the strip after the page head and before the page', () => {
  const out = renderFixture(Shell, {route:{page:'home'}, home:{lending:{enabled:true}}, devices:{name:'Ana’s MacBook'}, approvals:[], circles:[], title:'Home',
    banner:h(ConnectionBanner, {vm:connectionVM({connected:true, errors:{home:1}, freshness:{home:'2026-10-19T14:38:00Z'}, zone:'UTC'})}), children:h('main', null, 'page body')});
  assertDomOrder(withoutMaskMarkers(out), ['<header class="page-head"', 'class="offline"', 'page body']);
  assertNoBannedWords(out);
});

test('connectionVM: the browser being offline says so on any page, without a borrowed age', () => {
  const vm = connectionVM({connected: true, online: false, freshness: {home: '2026-10-19T14:38:00Z', agents: '2026-10-19T14:20:00Z'}, zone: 'UTC'});
  assert.deepEqual([vm.kind, vm.text, vm.action], ['offline', 'Can’t reach your computer. Check that it’s awake and on the same network.', 'Check connection']);
  assert.equal(vm.asOf, undefined, 'no resource failed, so no age is borrowed from the loaded ones');
  assert.equal(connectionVM({online: false}).asOf, undefined, 'no time is invented');
  assert.equal(connectionVM({connected: true, online: true}), null);
  assert.equal(connectionVM({connected: true, online: false, errors: {home: 1}}).kind, 'offline', 'the browser explicitly reports offline');
});


test('server failures use safe catalog prose without blocking state checks; diagnostics contain no raw error text', () => {
  const vm=connectionVM({connected:true, errors:{home:{status:500,code:'internal',message:'SECRET'}},freshness:{}});
  assert.equal(vm.kind, 'error');
  assert.doesNotMatch(vm.text, /500|HTTP|Try again/);
  assert.deepEqual(JSON.parse(vm.details), [{resource:'home',code:'internal'}]);
  assert.doesNotMatch(JSON.stringify(vm), /SECRET|offline|back online/);
  const html=renderFixture(ConnectionBanner,{vm,onRetry(){}});
  assert.match(renderedText(html), /Check current state Copy details/);
  assert.doesNotMatch(html, /disabled/);
  assert.equal(connectionVM({errors:{home:{code:'network',status:500}}}).kind,'error');
  assert.equal(connectionVM({errors:{home:{code:'network'}}}).kind,'stale');
  assert.match(connectionVM({errors:{home:{code:'network'}}}).text,/could not connect|Can’t reach/);
});

test('an update restart announces automatic reconnection without a premature reload control',()=>{
  const vm=updateVM({update:{state:'restarting',version:'1.1.0'}});
  assert.match(vm.text,/This page reconnects by itself/);
  assert.equal(vm.action,null);
  const html=renderFixture(UpdateToast,{vm});
  assert.doesNotMatch(html,/<button/);
});
