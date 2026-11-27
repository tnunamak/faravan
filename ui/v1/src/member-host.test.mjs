import {installClock, advance, flush, teardown, mount, createFakeApi, click} from './mounted.test-helper.mjs';
import {h} from 'preact';
import {projectMembership} from '../../../lib/v1/membership-projection.mjs';
import {membershipProjectionFor} from './membership-projection-view.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {pollMemberHosts, useMemberHost, MemberHostNotices, memberHostObservation, memberHostBanners} from './member-host.jsx';
import {memberHostVM, hostOfflineBanner} from './view-models.mjs';
import {joinStatusView} from './helpers.mjs';
import {renderFixture, renderedText, assertDomOrder, assertNoBannedWords} from './render.test-helper.mjs';

// H3: a member whose host does not answer. The banner, the 4-day warning with the roster's own date, the expired membership,
// and the invitation that ran out before the host came back.
const DAY = 86400000, NOW = Date.parse('2026-10-19T09:00:00Z');
const iso = ms => new Date(ms).toISOString();
const state = (host = {}, over = {}) => ({circle: 'c1', name: 'Weekend projects', hosted: false, networked: true, host: {label: 'Ana’s MacBook', reachable: false, lastReachedAt: iso(NOW - 2 * DAY), rosterValidUntil: iso(NOW + 5 * DAY), ...host}, lenders: [], ...over});
const banners = (s, over = {}) => memberHostVM(s, {now: NOW, zone: 'UTC', ...over});
const html = (items) => renderFixture(MemberHostNotices, {items, link: false});

test('a host that answers, a circle this computer hosts, one with no server, or nothing known yet: no banner at all', () => {
  assert.deepEqual(banners(state({reachable: true})), []);
  assert.deepEqual(banners(state({}, {hosted: true})), []);
  assert.deepEqual(banners(state({}, {networked: false})), []);
  assert.deepEqual(banners(null), []);
  assert.deepEqual(banners(undefined), []);
  assert.deepEqual(banners({}), [], 'a state with no host in it says nothing');
});

test('circles.member-host-offline: unreachable, who hosts it, when it was last reached, and that a draft can be written', () => {
  const [offline, ...rest] = banners(state({lastReachedAt: '2026-10-15T18:10:00Z', rosterValidUntil: iso(NOW + 6 * DAY)}));
  assert.deepEqual(rest, [], 'six days left on the roster is nothing to warn about yet');
  assert.deepEqual([offline.id, offline.tone, offline.headline], ['host-offline', 'wait', 'The circle “Weekend projects” is unreachable']);
  assert.equal(offline.text, 'Can’t reach Ana’s MacBook since Thursday 15 October at 6:10 PM. You can write a job now and send it when the circle is back.');
  assert.equal(hostOfflineBanner(state({lastReachedAt: iso(NOW - DAY + 3600000)}), 'Weekend projects', {now: NOW, zone: 'UTC'}).text.includes('yesterday at'), true);
});

test('from the 4th day offline there is a dated warning, in the roster’s own words and date', () => {
  const [offline, warn, ...rest] = banners(state({lastReachedAt: '2026-10-15T18:10:00Z', rosterValidUntil: '2026-10-21T09:00:00Z'}));
  assert.deepEqual(rest, []);
  assert.deepEqual([warn.id, warn.tone], ['membership-warning', 'need']);
  assert.equal(warn.headline, 'Ana’s MacBook hasn’t been online since Thursday 15 October, 6:10 PM.');
  assert.equal(warn.text, 'If it is still offline on Wednesday 21 October, 9:00 AM, this computer can’t lend to or borrow from Weekend projects until it comes back.');
  assert.equal(offline.id, 'host-offline', 'the unreachable banner comes first');
  // exactly three days left is the 4th day; just over is not
  assert.equal(banners(state({rosterValidUntil: iso(NOW + 3 * DAY)})).length, 2);
  assert.equal(banners(state({rosterValidUntil: iso(NOW + 3 * DAY + 1000)})).length, 1);
  // when nobody knows when it was last online, it still says how long, not "undefined"
  assert.equal(banners(state({lastReachedAt: null, rosterValidUntil: iso(NOW + DAY)}))[1].headline, 'Ana’s MacBook hasn’t been online for days.');
});

test('once the roster has expired the membership waits for the host, and nothing is deleted', () => {
  const [, expired, ...rest] = banners(state({rosterValidUntil: iso(NOW - 1000)}));
  assert.deepEqual(rest, []);
  assert.deepEqual([expired.id, expired.tone, expired.headline, expired.text], ['membership-expired', 'bad', 'Your membership of Weekend projects needs Ana’s MacBook to come back online.', 'Nothing is deleted. It comes back by itself when Ana’s MacBook does.']);
  assert.equal(banners(state({rosterValidUntil: null})).length, 1, 'no known expiry, no dated warning');
  assert.equal(banners(state({rosterValidUntil: 'soon'})).length, 1);
});

test('a host with no name is "the host’s computer", never blank or "undefined"', () => {
  const all = banners(state({label: null, rosterValidUntil: iso(NOW + DAY)}));
  assert.match(all[0].text, /^Can’t reach the host’s computer since/);
  assert.match(all[1].headline, /^The host’s computer hasn’t been online since/);
  assert.doesNotMatch(JSON.stringify(all), /undefined|null|NaN|Invalid/);
});

test('the notices render in order, an alert for an expired membership and a status for the rest, with the vocabulary clean', () => {
  const items = [{circle: {id: 'c1', name: 'Weekend projects'}, banners: banners(state({rosterValidUntil: iso(NOW - 1000)}))}];
  const out = html(items);
  assertDomOrder(out, ['The circle “Weekend projects” is unreachable', 'Your membership of Weekend projects needs Ana’s MacBook to come back online.']);
  assert.match(out, /role="status"/);
  assert.match(out, /role="alert"/);
  assertNoBannedWords(out);
  assert.equal(html([]), '', 'nothing to say renders nothing');
  assert.match(renderFixture(MemberHostNotices, {items, link: true}), /href="#\/circle\/c1"[^>]*>See Weekend projects</);
  assert.doesNotMatch(renderedText(html(items)), /See Weekend projects/);
});

test('an expired invitation states the outcome without inventing why it expired', () => {
  const expired = joinStatusView({name: 'Weekend projects', enrollment: {state: 'expired'}, joinInfo: {ownerName: 'Ana', approval: 'automatic'}});
  assert.deepEqual([expired.waiting, expired.expired, expired.message], [false, true, 'This invitation has expired. Ask Ana for a new one.']);
  assert.equal(joinStatusView({enrollment: {state: 'expired'}, joinInfo: {}}).message, 'This invitation has expired. Ask the person who invited you for a new one.');
  assert.equal(joinStatusView({enrollment: {state: 'pending'}, joinInfo: {ownerName: 'Ana', approval: 'automatic'}}).waiting, true, 'a pending one still waits');
});

test('P1-2 first failure stale reachable evidence and recovery are distinct', () => {
  const failed = memberHostObservation(undefined, null, true, NOW);
  const render = observation => renderedText(html([{circle: {id: 'c1'}, unknown: observation.error, checkedAt: observation.checkedAt, retry() {}, banners: memberHostBanners(observation, {now: NOW})}]));
  assert.match(render(failed), /Can’t check the host right now. Its status is unknown/);
  assert.match(render(failed), /Check all host statuses/);
  const reachable = memberHostObservation(failed, state({reachable: true}), false, NOW + 1);
  const stale = memberHostObservation(reachable, null, true, NOW + 2);
  assert.equal(stale.value, reachable.value);
  assert.match(render(stale), /Last known status checked/);
  assert.match(render(stale), /Its status is unknown/);
  assert.deepEqual(memberHostBanners(memberHostObservation(stale, state({reachable: true}), false, NOW + 3), {now: NOW}), []);
  const oldOffline = memberHostObservation({value: state()}, null, true, NOW);
  assert.match(render(oldOffline), /Last known status. The circle “Weekend projects” is unreachable/);
});

afterEach(teardown);
test('F3 each circle commits independently, times out, and ignores late older answers', async () => {
  installClock();
  const calls=[], seen=[];
  const api={get(path){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});calls.push({path,resolve,reject});return promise;}};
  const stop=pollMemberHosts(api,['c1','c2'],(id,value,error)=>seen.push({id,value,error}));
  try {
    await flush();
    calls[0].reject(new Error('c1 failed'));await flush();
    assert.deepEqual(seen.map(x=>[x.id,x.error]),[['c1',true]],'c2 does not hold c1 result');
    await advance(15000);
    assert.equal(seen.find(x=>x.id==='c2').error,true,'hung c2 becomes unknown');
    await advance(5000);
    assert.equal(calls.length,3,'hung c2 retains its slot');
    const count=seen.length;
    calls[1].resolve({old:true});await flush();
    assert.equal(seen.length,count,'timed-out old result cannot replace fresh observations');
    calls[2].resolve({peer:true});await flush();
    await advance(20000);
    calls[4].resolve({fresh:true});await flush();
    assert.equal(seen.findLast(x=>x.id==='c2').value.fresh,true);
  } finally {stop();for(const call of calls)call.resolve({});await flush();}
});

test('H4 initial unknown host cards name each circle and disclose shared retry scope', () => {
  const items=['Alpha','Beta'].map(name=>({circle:{id:name,name},unknown:true,retry(){},banners:memberHostBanners(memberHostObservation(undefined,null,true,NOW))}));
  const out=html(items);
  for(const name of ['Alpha','Beta']) {
    assert.match(out,new RegExp(name+': '));
    assert.ok(out.includes('aria-label="Check all host statuses; '+name+' status unknown"'));
  }
});

test('ignored abort retains one circle slot while peers refresh and late rejection stays silent', async () => {
  installClock();
  const api=createFakeApi(), seen=[];
  const stop=pollMemberHosts(api,['c1','c2'],(id,value,error)=>seen.push({id,value,error}));
  const one='circles/c1/compose', two='circles/c2/compose';
  let aborts=0;
  try {
    await flush();
    const hung=api.openReads(one)[0];hung.ignoreAbort=true;
    hung.signal.addEventListener('abort',()=>aborts++,{once:true});
    await api.answer(two,{round:0});
    await advance(15000);
    assert.equal(hung.signal.aborted,true);assert.equal(aborts,1);
    assert.deepEqual(seen.filter(x=>x.id==='c1'),[{id:'c1',value:undefined,error:true}]);
    for(let round=1;round<=3;round++){
      await advance(round===1?5000:20000);
      assert.equal(api.count(one),1);
      await api.answer(two,{round});
    }
    assert.equal(api.peak(one),1);
    assert.equal(seen.filter(x=>x.id==='c2').length,4);
    const count=seen.length;
    hung.settle('err',new Error('late ignored-abort rejection'));await flush();
    assert.equal(seen.length,count);assert.equal(aborts,1);
    await advance(20000);
    assert.equal(api.count(one),2);
    await api.answer(one,{fresh:true});
    assert.equal(seen.findLast(x=>x.id==='c1').value.fresh,true);
    const peer=api.openReads(two)[0];let cleanupAborts=0;
    peer.signal.addEventListener('abort',()=>cleanupAborts++,{once:true});
    stop();stop();await flush();
    assert.equal(peer.signal.aborted,true);assert.equal(cleanupAborts,1);
    const reads=api.reads.length, commits=seen.length;
    await advance(40000);
    assert.equal(api.reads.length,reads);assert.equal(seen.length,commits);
  } finally {
    stop();for(const call of api.openReads(()=>true))call.settle('ok',{});
    await flush();
  }
});

test('cooperative cancellation settles transport and allows the next eligible round', async () => {
  installClock();
  const api=createFakeApi(),seen=[];
  const stop=pollMemberHosts(api,['c1'],(id,value,error)=>seen.push({id,value,error}));
  try {
    await flush();const first=api.reads[0];
    await advance(15000);
    assert.equal(first.signal.aborted,true);assert.equal(first.state,'rejected');
    assert.equal(seen.length,1);assert.equal(seen[0].error,true);
    await advance(5000);assert.equal(api.reads.length,2);
    await api.answer('circles/c1/compose',{fresh:true});
    assert.deepEqual(seen.at(-1),{id:'c1',value:{fresh:true},error:false});
  } finally {
    stop();for(const call of api.openReads(()=>true))call.settle('ok',{});
    await flush();
  }
});

test('failed host observation is informational and fresh success restores navigation', () => {
  const circle={id:'c1',name:'Weekend projects'};
  const render=observation=>renderFixture(MemberHostNotices,{link:true,items:[{
    circle,unknown:observation.error,checkedAt:observation.checkedAt,retry(){},
    banners:memberHostBanners(observation,{now:NOW,zone:'UTC'}),
  }]});
  const success=memberHostObservation(undefined,state(),false,NOW);
  assert.match(render(success),/<a\s[^>]*href="#\/circle\/c1"/);
  const failed=memberHostObservation(success,undefined,true,NOW+1);
  const stale=render(failed);
  assert.match(stale,/Last known status/);
  assert.doesNotMatch(stale,/<a\b/i,'no navigation anchors, not no SVG href attributes');
  assert.match(stale,/<use\s[^>]*href=/,'icon references are retained');
  assert.ok(memberHostBanners(failed,{now:NOW}).every(b=>!b.href&&!b.linkLabel));
  const synthetic={...memberHostBanners(failed,{now:NOW})[1],href:'#/old',linkLabel:'Old action'};
  assert.doesNotMatch(renderFixture(MemberHostNotices,{link:true,items:[{circle,unknown:true,banners:[synthetic]}]}),/<a\b/i);
  const fresh=memberHostObservation(failed,state(),false,NOW+2);
  assert.match(render(fresh),/<a\s[^>]*href="#\/circle\/c1"/);
});

test('actual projected roster removal excludes a previously observed approved circle', async () => {
  installClock(NOW);
  const api=createFakeApi();
  const raw={id:'c1',name:'Weekend projects',origin:'https://circle.test',owned:false,
    enrollment:{state:'approved'},rosterMembershipVerified:true};
  const approved={...raw,membershipProjection:projectMembership(raw)};
  const removed={...raw,membershipProjection:projectMembership({...raw,rosterMembershipVerified:false})};
  assert.equal(membershipProjectionFor(approved).phase,'approved');
  assert.equal(membershipProjectionFor(removed).phase,'unknown');
  function Screen({circles}) {return h(MemberHostNotices,{items:useMemberHost(api,circles),link:true});}
  let mounted;
  try {
    mounted=await mount(h(Screen,{circles:[approved]}));
    await api.answer('circles/c1/compose',state());
    assert.equal(mounted.$$('a[href="#/circle/c1"]').length,1);
    await advance(20000);
    const pending=api.openReads('circles/c1/compose')[0];pending.ignoreAbort=true;
    await mounted.rerender(h(Screen,{circles:[removed]}));
    assert.equal(pending.signal.aborted,true);
    assert.equal(mounted.$$('.member-host').length,0);
    pending.settle('ok',state());await flush();
    await advance(40000);
    assert.equal(mounted.$$('.member-host').length,0);
    assert.equal(api.count('circles/c1/compose'),2);
  } finally {
    await mounted?.unmount();
    for(const call of api.openReads(()=>true))call.settle('ok',{});
    await flush();
  }
});

test('mounted host retry and circle churn retain physical flights until real settlement', async () => {
  installClock(NOW);
  const api=createFakeApi(), one='circles/c1/compose', two='circles/c2/compose', three='circles/c3/compose';
  const circle=(id,name)=>{const raw={id,name,origin:'https://circle.test',owned:false,
    enrollment:{state:'approved'},rosterMembershipVerified:true};
    return {...raw,membershipProjection:projectMembership(raw)};};
  const alpha=circle('c1','Alpha'),beta=circle('c2','Beta'),gamma=circle('c3','Gamma');
  function Screen({circles}) {return h(MemberHostNotices,{items:useMemberHost(api,circles),link:true});}
  let mounted;
  try {
    mounted=await mount(h(Screen,{circles:[alpha,beta]}));
    const hung=api.openReads(one)[0];hung.ignoreAbort=true;
    let aborts=0;hung.signal.addEventListener('abort',()=>aborts++,{once:true});
    await api.answer(two,state({reachable:true}));
    await advance(14999);
    assert.equal(hung.signal.aborted,false);
    assert.equal(mounted.button('Check all host statuses'),null);
    await advance(1);
    assert.equal(hung.signal.aborted,true);assert.equal(aborts,1);
    assert.match(mounted.text(),/Alpha: Can’t check the host right now/);
    for(let round=0;round<3;round++){
      const retry=mounted.button('Check all host statuses');assert.ok(retry);
      await click(retry);
      assert.equal(api.count(one),1,'real button never replaces ignored-abort transport');
      assert.equal(api.openReads(one).length,1);
      assert.equal(api.count(two),round+2,'other circle refreshes independently');
      await api.answer(two,state({reachable:true}));
    }
    await mounted.rerender(h(Screen,{circles:[alpha,beta,gamma]}));
    assert.equal(api.count(one),1);assert.equal(api.count(two),4,'adding peer does not restart unchanged peers');
    const retired=api.openReads(three)[0];retired.ignoreAbort=true;
    await mounted.rerender(h(Screen,{circles:[alpha,beta]}));
    assert.equal(retired.signal.aborted,true);
    await mounted.rerender(h(Screen,{circles:[alpha,beta,gamma]}));
    assert.equal(api.count(three),1,'re-add retains retired transport slot');
    await mounted.rerender(h(Screen,{circles:[beta,gamma]}));
    assert.equal(mounted.text().includes('Alpha:'),false);
    await mounted.rerender(h(Screen,{circles:[alpha,beta,gamma]}));
    assert.equal(api.count(one),1,'remove/re-add cannot bypass an unsettled slot');
    assert.equal(api.count(two),4);
    await advance(5000); // original visibility cadence, not a new effect's clock
    assert.equal(api.count(one),1);assert.equal(api.count(three),1);
    assert.equal(api.count(two),5);
    await api.fail(two,new Error('peer temporarily unavailable'));
    const before=mounted.text();
    hung.settle('err',new Error('late retired transport rejection'));
    retired.settle('ok',{...state(),name:'STALE GAMMA'});
    await flush();
    assert.equal(mounted.text(),before,'retired answers cannot publish after re-add');
    const retry=mounted.button('Check all host statuses');assert.ok(retry);
    await click(retry);
    assert.equal(api.count(one),2,'actual settlement permits a legitimate retry');
    assert.equal(api.count(three),2);
    assert.equal(api.count(two),6);
    await api.answer(one,{...state(),name:'Alpha'});
    assert.equal(mounted.$$('a[href="#/circle/c1"]').length,1,'fresh evidence restores navigation');
    await api.answer(two,state({reachable:true}));
    await api.answer(three,state({reachable:true}));
    assert.equal(api.peak(one),1);assert.equal(api.peak(two),1);assert.equal(api.peak(three),1);
    await advance(20000);
    const unmounted=api.openReads(one)[0];unmounted.ignoreAbort=true;
    await mounted.unmount();mounted=null;
    assert.equal(unmounted.signal.aborted,true);
    const count=api.reads.length;
    unmounted.settle('err',new Error('late unmount rejection'));await flush();
    await advance(40000);
    assert.equal(api.reads.length,count);
    assert.equal(api.openReads(()=>true).length,0);
    assert.equal(aborts,1);
  } finally {
    await mounted?.unmount();
    for(const call of api.openReads(()=>true))call.settle('ok',{});
    await flush();
  }
});

test('a replacement API owns a separate poller and cannot receive the old API answer', async () => {
  installClock(NOW);
  const oldApi=createFakeApi(),freshApi=createFakeApi(),path='circles/c1/compose';
  const raw={id:'c1',name:'Alpha',origin:'https://circle.test',owned:false,
    enrollment:{state:'approved'},rosterMembershipVerified:true};
  const circles=[{...raw,membershipProjection:projectMembership(raw)}];
  function Screen({api}) {return h(MemberHostNotices,{items:useMemberHost(api,circles),link:true});}
  let mounted;
  try {
    mounted=await mount(h(Screen,{api:oldApi}));
    const old=oldApi.openReads(path)[0];old.ignoreAbort=true;
    await mounted.rerender(h(Screen,{api:freshApi}));
    assert.equal(old.signal.aborted,true);
    assert.equal(oldApi.count(path),1);assert.equal(freshApi.count(path),1);
    await freshApi.answer(path,state({reachable:true}));
    old.settle('ok',{...state(),name:'STALE OLD API'});await flush();
    assert.equal(mounted.$$('.member-host').length,0);
    await advance(20000);
    assert.equal(oldApi.count(path),1);assert.equal(freshApi.count(path),2);
  } finally {
    await mounted?.unmount();
    for(const api of [oldApi,freshApi])for(const call of api.openReads(()=>true))call.settle('ok',{});
    await flush();
  }
});

test('a replacement API does not display the preceding API’s committed host status', async () => {
  installClock(NOW);
  const oldApi=createFakeApi(),freshApi=createFakeApi(),path='circles/c1/compose';
  const raw={id:'c1',name:'Alpha',origin:'https://circle.test',owned:false,
    enrollment:{state:'approved'},rosterMembershipVerified:true};
  const circles=[{...raw,membershipProjection:projectMembership(raw)}];
  function Screen({api}) {return h(MemberHostNotices,{items:useMemberHost(api,circles),link:true});}
  let mounted;
  try {
    mounted=await mount(h(Screen,{api:oldApi}));
    await oldApi.answer(path,state({label:'Old host'}));
    assert.match(mounted.text(),/Old host/);
    assert.equal(mounted.$$('a[href="#/circle/c1"]').length,1);

    await mounted.rerender(h(Screen,{api:freshApi}));
    assert.equal(freshApi.openReads(path).length,1);
    assert.equal(mounted.$$('.member-host').length,0,'the old banner is gone while the new read is pending');

    await freshApi.fail(path,new Error('new host read failed'));
    assert.match(mounted.text(),/status is unknown/);
    assert.doesNotMatch(mounted.text(),/Old host|Last known status/);
    assert.equal(mounted.$$('a[href="#/circle/c1"]').length,0);

    await click(mounted.button('Check all host statuses'));
    await freshApi.answer(path,state({label:'New host'}));
    assert.match(mounted.text(),/New host/);
    assert.equal(mounted.$$('a[href="#/circle/c1"]').length,1);
  } finally {
    await mounted?.unmount();
    for(const api of [oldApi,freshApi])for(const call of api.openReads(()=>true))call.settle('ok',{});
    await flush();
  }
});

test('member host polling has no subscription without eligible circles',async t=>{
  const api=createFakeApi();
  const added=t.mock.method(document,'addEventListener');
  const removed=t.mock.method(document,'removeEventListener');
  const count=method=>method.mock.calls.filter(call=>call.arguments[0]==='visibilitychange').length;
  const poll=pollMemberHosts(api,[],()=>{});
  try {
    assert.equal(count(added),0,'empty membership owns no visibility subscription');
    poll.reconcile(['c1']);
    await flush();
    assert.equal(count(added),1);
    assert.equal(api.count('circles/c1/compose'),1);
    poll.reconcile([]);
    assert.equal(count(removed),1,'retiring the last eligible circle releases its timer');
    await flush();
    assert.equal(api.openReads(()=>true).length,0);
  } finally {poll();await flush();}
});
