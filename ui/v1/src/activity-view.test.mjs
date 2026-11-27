import {installClock,resetPage,mount,createFakeApi,advance,click,forceClick,flush,flushRendersWithoutEffects,teardown,act,window} from './mounted.test-helper.mjs';
import {h,render} from 'preact';
import {Activity} from './circle-activity.jsx';
import test from 'node:test';
import assert from 'node:assert/strict';
import {activityVM,activityTypes,filterActivity,savedActivityState} from './activity-view.mjs';

const now = Date.parse('2026-10-19T16:00:00Z');

test('groups events by local calendar day and uses relative times in the selected zone', () => {
  const view = activityVM([
    {id:'later', type:'job', at:'2026-10-19T15:58:00Z', data:{job_digest:'a', status:'Running'}},
    {id:'prior', type:'lending-action', at:'2026-10-19T04:00:00Z', data:{action:'on'}},
  ], {now, timeZone:'America/Los_Angeles'});
  assert.deepEqual(view.groups.map(group => group.label), ['Today', 'Yesterday']);
  assert.deepEqual(view.groups.map(group => group.events[0].when), ['2 min ago', '12 h ago']);
  assert.equal(view.groups[0].events[0].actor, 'Unknown computer');
});

test('resolves a named roster actor and collapses adjacent repeated events', () => {
  const devices = {circles:[{members:[{key_id:'remote-key', localName:'Sam'}]}]};
  const view = activityVM([
    {type:'enrollment', at:'2026-10-19T15:59:00Z', data:{actor:'remote-key', state:'joined'}},
    {type:'enrollment', at:'2026-10-19T15:58:00Z', count:3, data:{actor:'remote-key', state:'joined'}},
  ], {now, timeZone:'UTC', devices});
  assert.deepEqual(view.groups[0].events, [{title:'Device joined', actor:'Sam', when:'2 min ago', count:2}]);
});

test('does not display an invalid actor name or an unknown remote identity', () => {
  const view = activityVM([
    {type:'member-left', at:'2026-10-19T15:59:00Z', data:{actorName:'sha256:' + 'a'.repeat(64)}},
  ], {now, timeZone:'UTC'});
  assert.equal(view.groups[0].events[0].actor, 'Unknown computer');
});

test('keeps loading distinct from an empty event list', () => {
  assert.equal(activityVM(undefined).state, 'loading');
  assert.equal(activityVM([]).state, 'empty');
});

// A different job or lending state must remain a separate event even when its heading matches.
test('repeat collapsing preserves distinct jobs and state changes', () => {
 const view = activityVM([
  {type:'job',at:'2026-10-19T15:59Z',data:{job_digest:'a',status:'Running'}},
  {type:'job',at:'2026-10-19T15:58Z',data:{job_digest:'b',status:'Running'}},
  {type:'lending-action',at:'2026-10-19T15:57Z',data:{action:'on'}},
  {type:'lending-action',at:'2026-10-19T15:56Z',data:{action:'off'}},
 ],{now,timeZone:'UTC'});
 assert.equal(view.groups[0].events.length,4);
});
test('circle activity does not claim global events belong to that circle', () => {
 const view=activityVM([{type:'agents',at:'2026-10-19T15:59Z',data:{}},{type:'lending-action',at:'2026-10-19T15:58Z',data:{circle:'a',action:'on'}}],{now,circleId:'a'});
 assert.equal(view.groups[0].events.length,1);
});

test('yesterday remains the previous calendar day across the autumn clock change', () => {
 const view=activityVM([{type:'job',at:'2026-10-31T18:00Z',data:{job_digest:'a',status:'Done'}}],{now:Date.parse('2026-11-02T04:30Z'),timeZone:'America/New_York'});
 assert.equal(view.groups[0].label,'Yesterday');
});
test('actor nicknames remain scoped to the event circle', () => {
 const devices={circles:[{circle:'a',members:[{key_id:'member',localName:'Alex at home'}]},{circle:'b',members:[{key_id:'member',localName:'Alex at work'}]}]};
 const view=activityVM([{type:'job',at:'2026-10-19T15:59Z',data:{actor:'member',circle:'b',job_digest:'a',status:'Running'}}],{now,devices});
 assert.equal(view.groups[0].events[0].actor,'Alex at work');
});

const rows = events => activityVM(events, {now}).groups.flatMap(group => group.events);
const event = (type, minute, data, extra = {}) => ({type, at:`2026-10-19T15:${String(minute).padStart(2, '0')}:00Z`, data, ...extra});

test('coalesced lending heartbeat keeps first at, never lastSeen or count', () => {
  const lending = event('lending', 30, {enabled:true,circle:'a',status:'idle',paused:false,current:null},
    {count:1223,lastSeen:'2026-10-19T15:59:59Z'});
  const ticks = Array.from({length:20}, (_, i) => event('lending', 31+i,
    {circle:'a',status:'idle',paused:false,current:null}));
  assert.deepEqual(rows([lending,...ticks]), []);
  assert.deepEqual(rows([lending]), rows([lending,...ticks]));
});

test('first status snapshots and setup, signin, refresh and other noise are empty', () => {
  assert.deepEqual(rows([
    event('lending',10,{circle:'a',status:'paused',paused:true,current:null}),
    event('lending',11,{circle:'a',status:'idle',paused:false,current:null}),
    ...['signin','approval','attention','circles','update','limits','unknown'].map(type => event(type,12,{})),
    event('agents',13,{agents:[{id:'a',useForLending:true}],refreshed:true}),
    event('enrollment',14,{circle:'a',state:'pending'}),
    event('job',15,{job_digest:'a',status:'Waiting'}),
    event('job',16,{job_digest:'a',status:'Queued'}),
    event('job',17,{status:'Running'}),
    {type:'member-left',at:'invalid',data:{}},
    null,
  ]), []);
});

test('successful action records distinguish a timed pause from off despite identical snapshots', () => {
  const data={circle:'a',status:'paused',enabled:false,paused:true,current:null};
  const events=['on','paused','resumed','off'].flatMap((action,index)=>[
    event('lending-action',10+index*2,{circle:'a',action}),
    event('lending',11+index*2,data),
  ]);
  assert.deepEqual(rows(events).map(row=>row.title), ['Lending turned off','Lending resumed','Lending paused','Lending turned on']);
});

test('job identity and definitive statuses prevent tick-driven starts and finishes', () => {
  assert.deepEqual(rows([
    event('lending',10,{circle:'a',status:'running',paused:false,current:'job-a'}),
    event('lending',11,{circle:'a',status:'running',paused:false,current:'job-a'}),
    event('job',12,{circle:'a',job_digest:'job-a',status:'Running',progress:25}),
    event('lending',13,{circle:'a',status:'paused',paused:true,current:null}),
    event('job',14,{circle:'a',job_digest:'job-a',status:'Waiting'}),
    event('job',15,{circle:'a',job_digest:'job-a',status:'Ready to review'}),
    event('job',16,{circle:'a',job_digest:'job-a',status:'Done'}),
    event('job',17,{circle:'a',job_digest:'job-b',status:'Running'}),
    event('job',18,{circle:'a',job_digest:'job-b',status:'Failed'}),
    event('job',19,{circle:'a',job_digest:'job-c',status:'Cancelled'}),
  ]).map(row => [row.title,row.when,row.count]), [
    ['Job finished','41 min ago',1],['Job finished','42 min ago',1],
    ['Job started','43 min ago',1],['Job finished','45 min ago',1],['Job started','50 min ago',1]
  ]);
});

test('agent toggles ignore refreshes and repeated state but retain distinct agents', () => {
  assert.deepEqual(rows([
    event('agents',10,{id:'a',useForLending:true}),
    event('agents',11,{id:'a',useForLending:true}),
    event('agents',12,{agents:[{id:'a',useForLending:false}],refreshed:true}),
    event('agents',13,{id:'b',useForLending:true}),
    event('agents',14,{id:'a',useForLending:false}),
    event('agents',15,{id:'a',useForLending:true}),
  ]).map(row => [row.title,row.when]), [
    ['a turned on for lending','45 min ago'],['a turned off for lending','46 min ago'],
    ['b turned on for lending','47 min ago'],['a turned on for lending','50 min ago']
  ]);
});

test('same titles stay separate across circles and actors, and noise does not break adjacency', () => {
  const view = rows([
    event('enrollment',10,{circle:'a',state:'joined',deviceName:'Sam'}),
    event('signin',11,{}),
    event('enrollment',12,{circle:'a',state:'joined',deviceName:'Sam'}),
    event('enrollment',13,{circle:'b',state:'joined',deviceName:'Sam'}),
    event('enrollment',14,{circle:'b',state:'joined',deviceName:'Pat'}),
    event('member-left',15,{circle:'b',deviceName:'Pat'}),
  ]);
  assert.deepEqual(view.map(row => [row.title,row.actor,row.count]), [
    ['Device left','Pat',1],['Device joined','Pat',1],['Device joined','Sam',1],['Device joined','Sam',2]
  ]);
});

test('state tracking is isolated by circle and raw actor identity', () => {
  const events = [
    event('lending-action',10,{circle:'a',actor:'one',action:'on'}),
    event('lending-action',11,{circle:'b',actor:'one',action:'on'}),
    event('lending-action',12,{circle:'b',actor:'two',action:'on'}),
  ];
  assert.equal(rows(events).length,3);
  assert.equal(activityVM(events,{now,circleId:'a'}).groups[0].events.length,1);
});

test('adjacent member events do not coalesce across local days', () => {
  const data = {circle:'a',state:'joined',deviceName:'Sam'};
  const view = activityVM([
    {type:'enrollment',at:'2026-10-19T06:59:00Z',data},
    {type:'enrollment',at:'2026-10-19T07:01:00Z',data},
  ], {now,timeZone:'America/Los_Angeles'});
  assert.deepEqual(view.groups.map(group => [group.label,group.events[0].count]), [['Today',1],['Yesterday',1]]);
});

test('real Finished status and attempt ids unify lending and borrower events in a circle', () => {
 const events=[
  event('lending',10,{circle:'a',current:'attempt-1',status:'running'}),
  event('job',11,{circle:{id:'a',name:'Friends'},job_digest:'job-1',current_attempt:{attempt_id:'attempt-1',execution_started_at:'2026-10-19T15:10Z'},status:'Starting'}),
  event('lending',12,{circle:'a',current:'attempt-1',status:'finished'}),
  event('job',13,{circle:{id:'a',name:'Friends'},job_digest:'job-1',current_attempt:{attempt_id:'attempt-1'},status:'Finished'}),
 ];
 const view=activityVM(events,{now,circleId:'a'}).groups.flatMap(group=>group.events);
 assert.deepEqual(view.map(row=>row.title),['Job finished','Job started']);
});

test('durable activity: pages merge newest first without duplicates and the retention is stated', async () => {
  const {mergeHistoryPages, historyNote} = await import('./activity-view.mjs');
  const first = {events: [{id: 9}, {id: 7}], nextBefore: 7}, older = [{events: [{id: 7}, {id: 3}], nextBefore: null}];
  assert.deepEqual(mergeHistoryPages(first, older).map(e => e.id), [9, 7, 3]);
  assert.equal(historyNote(null), 'Shows activity since Faravan last started.');
  assert.equal(historyNote({days: 90, durable: true, trimmedBefore: null}), 'This computer keeps activity for 90 days.');
  assert.match(historyNote({days: 90, durable: true, trimmedBefore: '2026-08-01T00:00:00.000Z'}), /Some older activity was removed/);
  assert.match(historyNote({days: 90, durable: false}), /only what happened since Faravan started/);
});

test('circle authority and person changes appear as named security activity',()=>{
 const events=['steward','ownership-propose','ownership-accept','ownership-cancel','person-link','role','person-block','person-unblock','person-remove'].map((action,index)=>({id:index,type:'circle-security',at:'2026-10-20T12:00:00Z',data:{circle:'c',action,actor:'self'}}));
 const view=activityVM(events,{now:Date.parse('2026-10-20T12:01:00Z'),timeZone:'UTC',circleId:'c',devices:{fingerprint:'self'}});
 assert.equal(view.groups.flatMap(group=>group.events).length,9);
 assert.ok(view.groups.flatMap(group=>group.events).some(event=>event.title==='Ownership transfer accepted'));
});

test('finding 1: missing, removed and unmatched actors never become this computer',()=>{
 for(const data of [{},{actor:'remote'},{actor:'removed'}]) {
  const view=activityVM([event('member-left',59,data)],{now,devices:{fingerprint:'self',circles:[]}});
  assert.equal(view.groups[0].events[0].actor,'Unknown computer');
 }
 const view=activityVM([event('member-left',59,{actor:'self'})],{now,devices:{fingerprint:'self'}});
 assert.equal(view.groups[0].events[0].actor,'This computer');
});
test('finding 5: People includes person security actions in request and fallback categories',()=>{
 const actions=['person-block','person-unblock','person-remove','person-link','role'];
 const events=actions.map((action,index)=>event('circle-security',40+index,{circle:'a',action},{id:index}));
 events.push(event('job',55,{circle:'a',job_digest:'job',status:'Running'}));
 assert.ok(activityTypes.people.split(',').includes('circle-security'));
 const filtered=filterActivity(events,'people');
 assert.equal(filtered.length,actions.length);
 assert.equal(activityVM(filtered,{now,circleId:'a'}).groups[0].events.length,actions.length);
 assert.equal(filterActivity(events,'jobs').length,1);
 assert.equal(filterActivity(events,'all').length,events.length);
});
test('finding 6: delayed saved history and failed saved history are not empty-history claims',()=>{
 const pending=savedActivityState({enabled:true},'people');
 assert.equal(pending.pending,true);assert.equal(pending.warning,'');
 const failed=savedActivityState({enabled:true,error:new Error('offline')},'people');
 assert.equal(failed.pending,false);
 assert.equal(failed.warning,"Saved activity couldn't load. Showing activity available since Faravan started.");
 assert.equal(failed.empty,'No people changes in the available history.');
 const fallback=filterActivity([event('member-left',59,{circle:'a'})],'people');
 assert.equal(activityVM(fallback,{now,circleId:'a'}).state,'rows');
 assert.equal(savedActivityState({enabled:true,data:{events:[]}},'people').pending,false);
});

test('findings 5 and 6: Activity binds shared filters, loading, partial warning and retry without replacing older errors',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('./circle-activity.jsx',import.meta.url),'utf8');
 for(const binding of [
  'const types=activityTypes', 'encodeURIComponent(types[filter])', 'filterActivity(data.activity??[],filter)',
  'saved.pending&&<p role="status">Loading saved activity…', 'saved.warning&&<div role="alert">',
  'first.error ? fallback : history ?? fallback', '!saved.pending&&!saved.warning?<p',
  'Retry saved activity', 'onClick={first.reloadAndWait}', "Older activity couldn't load. Try again."
 ])assert.ok(source.includes(binding),binding);
});

const savedHistory = (circle, actor='Saved actor') => ({
  events:[{id:7,type:'enrollment',at:'2026-10-20T14:59:00Z',data:{circle,state:'joined',deviceName:actor}}],
  nextBefore:null,retention:{days:90,durable:true,trimmedBefore:null},
});
const liveActivity = circle => ({devices:{circles:[]},activity:[
  {type:'member-left',at:'2026-10-20T14:58:00Z',data:{circle,deviceName:'Live actor'}},
]});
const historyPath = circle => 'activity/history?circle='+encodeURIComponent(circle);
const historyFailure = () => Object.assign(new Error('history failed'),{status:500,code:'history_failed'});
function assertHistoryWarning(screen) {
  assert.match(screen.$('[role="alert"]')?.textContent??'',/Saved activity couldn't load/);
  assert.match(screen.text(),/Live actor/);
  assert.doesNotMatch(screen.text(),/No activity in the available history|Loading saved activity/);
}
async function failedActivity(api,circle='friends / one') {
  const screen=await mount(h(Activity,{api,circleId:circle,data:liveActivity(circle),revision:0}));
  const path=historyPath(circle);
  assert.equal(api.count(path),1);
  await api.fail(path,historyFailure());
  assertHistoryWarning(screen);
  return {screen,path,circle};
}
async function cleanupActivity(apis) {
  try { await teardown(); }
  finally {
    // A deliberately abort-ignoring transport still belongs to this fixture.
    for(const api of apis)for(const call of api.openReads(()=>true))call.settle('ok',savedHistory('gone'));
    await flush();
  }
}
for(const failAgain of [false,true])test('mounted saved activity retry forces a causal read before throttle: '+failAgain,async()=>{
  installClock();resetPage();
  const api=createFakeApi();
  try {
    const {screen,path}=await failedActivity(api);
    await advance(1000);
    const clickedAt=Date.now(),button=screen.button('Retry saved activity');
    await click(button);
    assert.equal(Date.now(),clickedAt,'retry does not wait out the throttle');
    assert.equal(api.count(path),2,'actual same-path GET starts at failure + 1000ms');
    assert.equal(button.getAttribute('aria-busy'),'true');
    assert.equal(button.getAttribute('aria-disabled'),'true');
    await forceClick(button);await forceClick(button);
    assert.equal(api.count(path),2);
    assert.equal(api.openReads(path).length,1);
    assert.equal(api.peak(path),1);
    assertHistoryWarning(screen);
    if(failAgain) {
      await api.fail(path,historyFailure());
      assertHistoryWarning(screen);
      const retry=screen.button('Retry saved activity');
      assert.equal(retry.hasAttribute('aria-busy'),false);
      assert.equal(retry.hasAttribute('aria-disabled'),false);
      await click(retry);
      assert.equal(Date.now(),clickedAt);
      assert.equal(api.count(path),3,'another failure allows another immediate forced read');
      assert.equal(retry.getAttribute('aria-busy'),'true');
      await api.answer(path,savedHistory('friends / one'));
    } else await api.answer(path,savedHistory('friends / one'));
    assert.match(screen.text(),/Device joined.*Saved actor/);
    assert.doesNotMatch(screen.text(),/Live actor|Saved activity couldn't load/);
    assert.equal(screen.$('[role="alert"]'),null);
    assert.equal(screen.button('Retry saved activity'),null);
    assert.equal(screen.$('[aria-busy="true"]'),null,'successful completion leaves no pending control');
    assert.deepEqual(api.posts,[]);
  } finally {await cleanupActivity([api]);}
});
test('mounted Activity hides committed saved history before the replacement API starts reading',async()=>{
  installClock();resetPage();
  const api=createFakeApi(),other=createFakeApi(),circle='friends / one',path=historyPath(circle);
  const page=client=>h(Activity,{api:client,circleId:circle,data:liveActivity(circle),revision:0});
  try {
    const screen=await mount(page(api));
    await api.answer(path,{...savedHistory(circle,'Old committed actor'),nextBefore:'old-cursor'});
    assert.match(screen.text(),/Old committed actor/);
    assert.ok(screen.button('Show older'));
    await flushRendersWithoutEffects(()=>render(page(other),screen.container));
    assert.equal(other.count(path),0,'replacement reader has not started yet');
    assert.doesNotMatch(screen.text(),/Old committed actor/);
    assert.match(screen.text(),/Live actor/);
    assert.equal(screen.button('Show older'),null);
    await advance(32);
    assert.equal(other.count(path),1);
    await other.answer(path,savedHistory(circle,'Current actor'));
    assert.match(screen.text(),/Current actor/);
  } finally {await cleanupActivity([api,other]);}
});

for(const replacement of ['unmount','api','circle','filter'])
test('mounted saved activity retry ignores late old read after '+replacement,async()=>{
  installClock();resetPage();
  const api=createFakeApi(),other=createFakeApi();
  try {
    const {screen,path,circle}=await failedActivity(api);
    await advance(1000);
    await click(screen.button('Retry saved activity'));
    const old=api.openReads(path)[0];
    assert.ok(old);
    old.ignoreAbort=true;
    // Queue an ordinary revision while the forced read is pending, then retire its owner.
    await screen.rerender(h(Activity,{api,circleId:circle,data:liveActivity(circle),revision:1}));
    let currentApi=api,currentPath=path,currentCircle=circle;
    if(replacement==='unmount')await screen.unmount();
    if(replacement==='api') {
      currentApi=other;
      await screen.rerender(h(Activity,{api:other,circleId:circle,data:liveActivity(circle),revision:1}));
    }
    if(replacement==='circle') {
      currentCircle='friends / two';currentPath=historyPath(currentCircle);
      await screen.rerender(h(Activity,{api,circleId:currentCircle,data:liveActivity(currentCircle),revision:1}));
    }
    if(replacement==='filter') {
      currentPath=path+'&types='+encodeURIComponent(activityTypes.people);
      await act(()=>{const select=screen.$('select');select.value='people';select.dispatchEvent(new window.Event('change',{bubbles:true}));});
      await flush();
    }
    assert.equal(old.signal.aborted,true,'retired owner requests cancellation');
    assert.equal(old.aborted,true);
    old.settle('ok',savedHistory(circle,'Obsolete actor'));
    await flush();
    assert.doesNotMatch(screen.text(),/Obsolete actor/);
    if(replacement!=='unmount') {
      assert.equal(currentApi.count(currentPath),1,'new owner performs its legitimate read');
      await currentApi.answer(currentPath,savedHistory(currentCircle,'Current actor'));
      assert.match(screen.text(),/Current actor/);
      assert.equal(screen.$('[role="alert"]'),null);
    } else assert.equal(screen.container.isConnected,false);
    await advance(6000);
    assert.equal(api.count(path),2,'retired reader cannot start its queued revision');
    assert.doesNotMatch(screen.text(),/Obsolete actor/);
    assert.deepEqual(api.posts,[]);assert.deepEqual(other.posts,[]);
  } finally {await cleanupActivity([api,other]);}
});
