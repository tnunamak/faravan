import {mount, teardown, resetPage, installClock, advance, flush, createFakeApi, click, act} from './mounted.test-helper.mjs';
import {h} from 'preact';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Host, HostChoose, HostStatus, hostingObservation, copyHostingDetails} from './host.jsx';
import {hostChooseVM, hostCommand, hostStatusVM, hostReachWord, HOST_METHODS, HOST_FACTS} from './view-models.mjs';
import {hostRestartVM, hostStartProgress, circleHostingVM} from './circles-view.mjs';
import {routeFromHash, navCurrent, ROUTES} from './helpers.mjs';
import {renderFixture, renderedText, assertDomOrder, assertNoBannedWords} from './render.test-helper.mjs';

// H1: choosing how friends reach this computer, and what the app says once the circle is up, changed address or asleep.
const NOW = Date.parse('2026-10-19T10:00:00Z');
const choice = (over = {}) => ({method: 'lan', name: 'Weekend projects', ...over});
const choose = (over = {}) => renderFixture(HostChoose, {choice: choice(over), onChoice() {}});
const running = {configured: true, running: true, name: 'Weekend projects', circle: 'c1', origin: 'https://ana-mbp.tail4c2e.ts.net', reach: {kind:'gozar',audience:'tailnet'}, members: 5, lastReachedAt: '2026-10-19T09:58:00Z', addressChanged: null};
const status = (hosting, over = {}) => renderFixture(HostStatus, {vm: hostStatusVM(hosting, {now: NOW, zone: 'UTC', ...over}), hosting, api: {}, onUpdated() {}, onCopyDetails() {}});

test('keep-awake pending and failed release never claim confirmed sleep preference', () => {
  for(const enabled of [false,true]) for(const [reason,copy] of [
    ['stopping','Releasing the keep-awake request. Release is not confirmed yet.'],
    ['stop_failed','The keep-awake request could not be released. Release is not confirmed.'],
    ['power_unknown','Power status is unknown. No new keep-awake request will start.'],
  ]) {
    const text=renderedText(status({...running,keepAwake:{enabled,active:reason!=='power_unknown',reason}}));
    assert.ok(text.includes(copy),text);
  }
});

test('host setup describes the three audiences and keeps the invitation address explicit', () => {
  const out=choose();
  assertDomOrder(out,['<b>Circle name</b>','How friends reach this computer','<b>Local network only</b>',
    'Traffic on this network is unencrypted.', '<b>Private network</b>', '<b>Public HTTPS</b>',
    'Invitations use one fixed address.', 'This computer runs the circle.', 'Start circle', 'Start from a terminal']);
  assert.equal((out.match(/type="radio"/g)||[]).length,3);
  assert.deepEqual(HOST_METHODS.map(item=>item.id),['lan','private','public']);
  assert.equal(HOST_FACTS.length,3);
});
test('terminal command passes only an audience and quotes the circle name', () => {
  assert.equal(hostCommand({method:'private',name:'Weekend projects'}),"faravan host --tunnel private --circle-name 'Weekend projects'");
  for (const method of ['public','private']) {
    const vm=hostChooseVM({method});
    assert.equal(vm.start,null,'remote publication needs an explicit terminal review');
    assert.equal(vm.command,'faravan host --tunnel '+method);
  }
  assert.doesNotMatch(hostCommand({method:'$(unexpected)'}),/unexpected/);
});
test('hosting starts in the app with the validated request body and keeps the terminal path secondary', () => {
  const html = renderFixture(HostChoose, {choice: choice(), onChoice() {}, onStart() {}});
  assert.match(renderedText(html), /Start circle/);
  assert.match(html, /class="btn btn-primary"/);
  assert.match(html, /<details[^>]*>[\s\S]*<summary[^>]*>Start from a terminal/);
  assert.doesNotMatch(html, /<summary class="linklike"/,'terminal fallback uses the shared chevron disclosure');
  assert.equal(hostChooseVM(choice()).start.tunnel, 'lan');
});

test('restart uses the saved host settings and keeps the terminal path secondary', () => {
  const stopped = {...running,running:false,reach:{kind:'lan'}};
  assert.deepEqual(hostRestartVM(stopped), {tunnel:'lan',name:'Weekend projects'});
  const html = renderFixture(HostStatus, {vm: hostStatusVM(stopped), hosting: stopped, onStart() {}});
  assert.match(renderedText(html), /Start again/);
  assert.match(html, /<details[^>]*>[\s\S]*<summary[^>]*>Start from a terminal/);
});

test('start progress stays immediate, then adds elapsed time after ten seconds', () => {
  assert.equal(hostStartProgress(true, 0), 'Starting the circle…');
  assert.equal(hostStartProgress(true, 9), 'Starting the circle…');
  assert.equal(hostStartProgress(true, 10), 'Starting the circle… 0:10');
  assert.equal(hostStartProgress(true, 70), 'Starting the circle… 1:10');
  assert.equal(hostStartProgress(false, 70), '');
});

test('address control gives facts about the fixed invitation address', () => {
  const html = status(running);
  assert.match(renderedText(html), /About this address/);
  assert.doesNotMatch(renderedText(html), /Change address/);
});

test('circles.host-running: where it runs, the address, how it is reached, the members, when they last reached it, and Invite someone', () => {
  const text = renderedText(status(running));
  assert.match(text, /Runs on this computer Online https:\/\/ana-mbp\.tail4c2e\.ts\.net · Private network · 5 members Members reached it 2 min ago\. Invite someone/);
  assert.match(status(running), /href="#\/circle\/c1"/);
  assert.equal(hostStatusVM({...running, members: 1}, {now: NOW}).line.endsWith('Just you so far'), true);
  assert.equal(hostStatusVM({...running, lastReachedAt: null}, {now: NOW}).reached, '');
  assert.equal(hostStatusVM({...running, members: null}, {now: NOW}).line, 'https://ana-mbp.tail4c2e.ts.net · Private network', 'an unknown member count is left out, not shown as zero');
  assert.deepEqual([{audience:'internet'},{audience:'lan'},{audience:'tailnet'},{}].map(hostReachWord),['Public HTTPS','Local network','Private network','']);
});

test('circles.host-woke: the gap, who it affected, and how many jobs waited; no gap, no banner', () => {
  const woke = hostStatusVM({...running, wake: {from: '2026-10-18T21:10:00Z', to: '2026-10-19T07:02:00Z', waitedJobs: 2}}, {now: NOW, zone: 'UTC'});
  assert.deepEqual([woke.banner.headline, woke.banner.text], ['This computer was asleep from 9:10 PM to 7:02 AM.', 'Nobody in Weekend projects could send or get jobs then. 2 jobs waited.']);
  assert.equal(hostStatusVM({...running, wake: {from: '2026-10-18T21:10:00Z', to: '2026-10-19T07:02:00Z', waitedJobs: 1}}, {zone: 'UTC'}).banner.text.endsWith('1 job waited.'), true);
  assert.equal(hostStatusVM({...running, wake: {from: '2026-10-18T21:10:00Z', to: '2026-10-19T07:02:00Z', waitedJobs: 0}}, {zone: 'UTC'}).banner.text, 'Nobody in Weekend projects could send or get jobs then.');
  assert.equal(hostStatusVM(running, {now: NOW}).banner, null);
  assert.equal(hostStatusVM({...running, wake: {from: 'x', to: 'y'}}, {now: NOW}).banner, null, 'a wake gap without real times is not shown');
});

test('address mismatch shows both addresses and guidance from the current route binding', () => {
  const changed={...running,addressChanged:{expected:'https://saved.example',observed:'https://different.example'},
    route:{binding:{remedy:{instructions:'Review the binding for the saved address.'}}}};
  const out=status(changed),text=renderedText(out);
  assert.match(out,/role="alert"/);
  assert.match(text,/This computer is now reached at a different address/);
  assert.match(text,/Faravan won’t publish the circle at an address members didn’t agree to/);
  assert.match(text,/Review the binding for the saved address/);
  assert.match(text,/Error host_origin_changed · Copy details/);
  assert.deepEqual(JSON.parse(hostStatusVM(changed).details),{code:'host_origin_changed',...changed.addressChanged});
});
test('a host that is configured but not running says so, and how to bring it back; nothing is hosted says "choose"', () => {
  const stopped = hostStatusVM({...running, running: false}, {now: NOW});
  assert.equal(stopped.kind, 'stopped');
  assert.match(renderedText(status({...running, running: false})), /Weekend projects isn’t running on this computer\. Members can’t send or get jobs until it is back\. Jobs already sent wait here\./);
  assert.match(status({...running, running: false}), /faravan host/);
  assert.equal(hostStatusVM({configured: false}).kind, 'choose');
  assert.equal(hostStatusVM(null).kind, 'choose');
  assert.equal(hostStatusVM({configured: false}).title, 'Start a circle on this computer');
});

test('stopped circle banner offers Start again through the existing hosting start path', async () => {
  resetPage();installClock();
  const api=createFakeApi(), requests=[];
  api.request=async(path,options)=>{requests.push({path,options});};
  const app=await mount(h(Host,{api,data:{devices:{}}}));
  const stopped={...running,name:'Faravan demo',running:false,processState:'stopped',reach:{kind:'lan'},origin:'http://10.23.1.2:8787'};
  await api.answer('hosting',stopped);
  const start=app.button('Start again');
  assert.ok(start,'Start again sits on the stopped banner');
  assert.ok(start.closest('.banner')===app.$('.banner'),'recovery is beside the stopped message');
  assert.equal(start.disabled,false);
  await click(start);
  assert.equal(requests.length,1);
  assert.equal(requests[0].path,'ops/hosting.start');
  assert.equal(requests[0].options.method,'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body),hostRestartVM(stopped));
  await api.answer('hosting',{...stopped,running:true});
  await flush();
  assert.ok(!app.button('Start again'),'Start again leaves once hosting runs');
});

test('stopped circle without a start handler gives terminal guidance instead of a here promise', () => {
  const text=renderedText(status({...running,running:false}));
  assert.doesNotMatch(text,/Start it again here/);
  assert.match(text,/To start hosting, open Start from a terminal below\./);
  assert.match(text,/faravan host/);
});

test('the hosting page lives at #/circles/host under Circles, and the words pass the vocabulary check', () => {
  assert.deepEqual(routeFromHash('#/circles/host'), {page: 'host', id: null});
  assert.deepEqual(routeFromHash('#/circles/host/x'), {page: 'not-found', id: null});
  assert.equal(navCurrent('host'), 'circles');
  assert.equal(ROUTES.host, 'Host a circle');
  for (const html of [choose(), choose({method:'public'}), choose({method: 'lan'}), status(running), status({...running, running: false})]) assertNoBannedWords(html.replace(/<code>[^]*?<\/code>/g, ''));
});

test('the app can start a named LAN circle without an external route approval', () => {
  assert.deepEqual(hostChooseVM({method:'lan',name:' Friends '}).start,{tunnel:'lan',name:'Friends'});
});
test('P1-1 failed poll after running retains only qualified last-known status', () => {
  const fresh = hostingObservation({}, running, null, NOW);
  const stale = hostingObservation(fresh, null, new Error('offline'), NOW + 1000);
  const out = renderFixture(HostStatus, {vm: hostStatusVM(running), hosting: running, stale: stale.stale, lastOnlineAt: stale.lastOnlineAt});
  assert.match(renderedText(out), /Hosting status unknown. Last confirmed online/);
  assert.match(renderedText(out), /Last known status: Online/);
  assert.doesNotMatch(renderedText(out), /Invite someone|Stop hosting/);
  assert.equal(hostingObservation(stale, running, null, NOW + 2000).stale, false);
});
test('P2-3 hosting is explicitly not evidence of lending or job availability', () => {
  const text = renderedText(status(running));
  assert.match(text, /This computer runs the circle. Hosting does not mean it is lending/);
  assert.match(text, /Lending and job availability are shown separately on Lend/);
});
test('P2-6 custom address mismatch provides safe restore and status recheck', () => {
  const out = status({...running, reach: {kind: 'url'}, addressChanged: {expected: 'https://saved.example', observed: 'https://other.example'}});
  assert.match(renderedText(out), /Restore the saved invitation address, then check hosting status again/);
  assert.match(renderedText(out), /Check hosting status/);
});
test('P2-7 clipboard success rejection and absence have explicit outcomes', async () => {
  const writes = [];
  assert.deepEqual(await copyHostingDetails('details', {async writeText(value) {writes.push(value);}}), {message: 'Hosting details copied.', fallback: false});
  assert.deepEqual(writes, ['details']);
  for (const clipboard of [null, {}, {async writeText() {throw new Error('denied');}}]) {
    assert.deepEqual(await copyHostingDetails('details', clipboard), {message: 'Couldn’t copy. Select and copy these details.', fallback: true});
  }
});

afterEach(teardown);
test('F1 mounted owner ignores old success after newer failure and old failure after newer success', async () => {
  resetPage();installClock();
  const api=createFakeApi(), app=await mount(h(Host,{api,data:{devices:{}},refresh(){}}));
  const a=api.openReads('hosting')[0];
  await advance(15000);
  const b=api.openReads('hosting')[1];
  b.settle('err',new Error('newer failure'));await flush();
  assert.match(app.text(),/Retry hosting status/);
  a.settle('ok',running);await flush();
  assert.equal(Boolean(app.button('Invite someone')),false);
  assert.match(app.text(),/Retry hosting status/);
  await click(app.button('Retry hosting status'));
  const c=api.openReads('hosting')[0];
  await advance(15000);
  const d=api.openReads('hosting')[1];
  d.settle('ok',running);await flush();
  assert.equal(Boolean(app.button('Invite someone')),true);
  c.settle('err',new Error('old failure'));await flush();
  assert.equal(Boolean(app.button('Invite someone')),true);
  assert.equal(Boolean(app.button('Retry hosting status')),false);
});
test('F1 owner discards old API replies after context replacement', async () => {
  resetPage();installClock();
  const oldApi=createFakeApi(), nextApi=createFakeApi();
  const app=await mount(h(Host,{api:oldApi,data:{devices:{}}}));
  await app.rerender(h(Host,{api:nextApi,data:{devices:{}}}));
  await nextApi.answer('hosting',{...running,running:false});
  await oldApi.answer('hosting',running);
  assert.equal(Boolean(app.button('Invite someone')),false);
  assert.match(app.text(),/isn’t running/);
});
test('F4 stale address mismatch is last-known and retains its actual guide', () => {
  const changed={...running,addressChanged:{expected:'https://saved.example',observed:'https://other.example'},
    route:{binding:{remedy:{instructions:'Review the address your route currently forwards to.'}}}};
  const out=renderFixture(HostStatus,{vm:hostStatusVM(changed),hosting:changed,stale:true});
  const text=renderedText(out);
  assert.match(text,/At the last successful check/);
  assert.match(text,/current address and publishing status are unknown/);
  assert.doesNotMatch(text,/now serves|using the guide above/);
  assert.match(text,/Review the address your route currently forwards to/);
});

// A configured host reached through Start another circle: a create that never confirmed offers Check Circles only when the page can refresh.
const enterCircleName=async(app,name)=>{await act(()=>{const input=app.$('input');input.value=name;input.dispatchEvent(new Event('input',{bubbles:true}));});await flush();};
const submitCircle=async app=>{await act(()=>{app.$('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();};
async function unconfirmedNewCircle(refresh) {
  resetPage();installClock();
  let mutations=0;
  const api=createFakeApi(), app=await mount(h(Host,{api,data:{devices:{}},newCircle:true,refresh,
    mutate:async()=>{mutations++;throw {code:'timeout'};}}));
  await api.answer('hosting',running);
  await enterCircleName(app,'Weekend');await submitCircle(app);
  assert.equal(mutations,1);
  return app;
}
test('Start another circle offers Check Circles through the page refresh, and keeps the fallback text without one', async () => {
  let refreshes=0;
  const withRefresh=await unconfirmedNewCircle(async()=>{refreshes++;});
  assert.notEqual(withRefresh.button('Check Circles'),null);
  assert.doesNotMatch(withRefresh.text(),/Refresh is unavailable here/);
  const before=refreshes;
  await click(withRefresh.button('Check Circles'));
  assert.equal(refreshes,before+1);
  await teardown();
  const withoutRefresh=await unconfirmedNewCircle(undefined);
  assert.equal(withoutRefresh.button('Check Circles'),null);
  assert.match(withoutRefresh.text(),/Refresh is unavailable here/);
  assert.equal(withoutRefresh.button('Open Circles').getAttribute('href'),'#/circles');
});

// A refused Start keeps its reason on screen when the status read after it fails, and when a later read reports not running.
test('a refused Start keeps its reason when the follow-up status read fails and when a later read reports not running', async () => {
  resetPage();installClock();
  const api=createFakeApi();let starts=0;
  api.request=async path=>{
    if(path!=='ops/hosting.start') throw new Error('unexpected request '+path);
    starts++;throw Object.assign(new Error('refused'),{status:409,code:'previous_coordinator_other_install'});
  };
  const app=await mount(h(Host,{api,data:{devices:{}}}));
  await api.answer('hosting',{configured:false,running:false});
  await act(()=>{const input=app.$('input[aria-label="Circle name"]');input.value='Weekend';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await flush();
  await click(app.button('Start circle'));
  assert.equal(starts,1);
  await api.fail('hosting',new Error('offline'));
  await flush();
  const refusal=/Starting hosting was refused\. The recorded hosting process appears to use a different program path\./;
  assert.match(app.text(),refusal);
  assert.match(app.text(),/Current hosting status could not be refreshed\. Retry hosting status before starting again\./);
  await click(app.button('Retry hosting status'));
  await api.answer('hosting',{configured:false,running:false});
  await flush();
  assert.match(app.text(),refusal);
  assert.equal(starts,1,'a refused Start is never retried automatically');
});

test('failed Start stays visible despite running status and later successful polls', async () => {
  resetPage();installClock();
  const api=createFakeApi();
  api.request=async()=>{throw Object.assign(new Error('refused'),{status:409,code:'previous_coordinator_other_install'});};
  const app=await mount(h(Host,{api,data:{devices:{}},newCircle:true}));
  await api.answer('hosting',{configured:false,running:false});
  await enterCircleName(app,'Weekend');
  await click(app.button('Start circle'));
  await api.answer('hosting',running);await flush();
  assert.match(app.text(),/The host process is running, but circle setup did not finish\./);
  assert.match(app.text(),/The recorded hosting process appears to use a different program path\./);
  assert.doesNotMatch(app.text(),/Online|Invite someone|Hosted on this computer/);
  await advance(15000);await api.answer('hosting',running);await flush();
  assert.match(app.text(),/circle setup did not finish/);
  assert.equal(Boolean(app.button('Invite someone')),false);
});

test('configured-only hosting offers hosting setup, while established stopped circles say stopped', async () => {
  resetPage();installClock();
  const api=createFakeApi(), app=await mount(h(Host,{api,data:{devices:{}},newCircle:true}));
  await api.answer('hosting',{configured:true,running:false,circle:null,circles:[]});
  assert.match(app.text(),/Hosting setup was started on this computer, but Faravan has not confirmed a running circle yet\./);
  assert.match(app.text(),/How friends reach this computer/);
  assert.doesNotMatch(app.text(),/Invite people you trust|Start another circle/);
  assert.equal(hostStatusVM({configured:true,running:true,circle:null,circles:[]}).kind,'choose');
  assert.match(renderedText(status({...running,running:false})),/Weekend projects isn’t running on this computer\. Members can’t send or get jobs until it is back\./);
});

// Bug (tester, sandpiper): Start another circle with a stopped old hosted circle showed that circle's status, not the form.
test('Start another circle shows the new-circle form while an earlier hosted circle is stopped, with one note linking to it', async () => {
  resetPage();installClock();
  const created=[];
  const api=createFakeApi(), app=await mount(h(Host,{api,data:{devices:{}},newCircle:true,
    mutate:async(path,body)=>{created.push([path,body]);return {id:'c2'};}}));
  await api.answer('hosting',{...running,name:'Faravan demo',running:false,processState:'stopped',circles:[{id:'c1',name:'Faravan demo'}]});
  assert.equal(app.$('h1').textContent,'Start another circle');
  assert.doesNotMatch(app.text(),/Members can’t send or get jobs until it is back|Start again/);
  assert.match(app.text(),/Faravan demo isn’t running on this computer\. Starting a new circle starts hosting here again, at the same address\./);
  assert.equal(app.$('a[href="#/circles/host"]').textContent,'Open Faravan demo hosting');
  await enterCircleName(app,'Weekend');await submitCircle(app);
  assert.deepEqual(created,[['circles',{name:'Weekend'}]]);
});

test('Start another circle with a running host shows the form and no stopped note', async () => {
  resetPage();installClock();
  const api=createFakeApi(), app=await mount(h(Host,{api,data:{devices:{}},newCircle:true,mutate:async()=>({id:'c2'})}));
  await api.answer('hosting',{...running,circles:[{id:'c1',name:'Weekend projects'}]});
  assert.match(app.text(),/Hosted on this computer at the same address\./);
  assert.doesNotMatch(app.text(),/isn’t running on this computer/);
  assert.equal(app.$('a[href="#/circles/host"]'),null);
});

test('LAN choice and address recovery explain the fixed local address, not a proxy', () => {
  assert.equal(hostChooseVM({method:'lan'}).chosen.needs,"Friends on the same local network.");
  const text=renderedText(status({...running,reach:{kind:'lan'},addressChanged:{expected:'http://10.23.1.20:8080',observed:'http://10.23.1.21:8080'}}));
  assert.ok(text.includes("This circle uses the saved local address http://10.23.1.20:8080. Restore that address on this computer’s local network, then check hosting status again. This app cannot change existing invitations to a different address."));
  assert.doesNotMatch(text,/HTTPS proxy or tunnel/);
});

test('remote restart leads to the saved offer in the terminal', () => {
  for (const audience of ['internet','tailnet'])
    assert.equal(hostRestartVM({...running,running:false,reach:{kind:'gozar',audience}}),null);
});
test('H2 stop copy preserves automatic retention rather than promising indefinite storage', async () => {
  const {hostStopCopy}=await import('./view-models.mjs');
  const {circleHostingVM}=await import('./circles-view.mjs');
  for (const text of [hostStopCopy(running).data,circleHostingVM({id:'c1',origin:running.origin},running).text]) {
    assert.match(text,/Stopping hosting does not delete data here/);
    assert.match(text,/deleted 30 days after each job ends/);
    assert.doesNotMatch(text,/until you delete/);
  }
});
test('H3 remote running paragraph consistently identifies the host', () => {
  const out=renderFixture(HostStatus,{vm:hostStatusVM(running,{viewerSession:{kind:'phone',computer:'Ana’s Mac'}}),hosting:running,computerReference:'Ana’s Mac'});
  assert.match(renderedText(out),/Ana’s Mac runs the circle. Hosting does not mean it is lending/);
  assert.doesNotMatch(renderedText(out),/This computer runs the circle/);
});
test('H5 lost Start remains uncertain through running polls without replaying setup', async () => {
  resetPage();installClock();
  const api=createFakeApi(), requests=[];
  api.request=async(path,options)=>{requests.push({path,options});throw new Error('reply lost');};
  const app=await mount(h(Host,{api,data:{devices:{}}}));
  await api.answer('hosting',{configured:false,running:false});
  await enterCircleName(app,'Weekend');await click(app.button('Start circle'));
  await api.answer('hosting',running);await flush();
  assert.match(app.text(),/Circle setup unconfirmed/);
  assert.doesNotMatch(app.text(),/setup did not finish|Invite someone/);
  await advance(15000);await api.answer('hosting',running);await flush();
  assert.match(app.text(),/Circle setup unconfirmed/);
  await click(app.button('Check hosting status'));
  await api.answer('hosting',running);await flush();
  assert.match(app.text(),/Circle setup unconfirmed/);
  assert.equal(requests.length,1,'status refresh must not repeat the uncertain mutation');
  assert.equal(app.button('Inspect circles').getAttribute('href'),'#/circles');
  assert.equal(app.button('Confirm circle setup'),null);
});

test('H5 lost Start that left no host running keeps the Start form', async () => {
  resetPage();installClock();
  const api=createFakeApi();
  api.request=async()=>{throw new Error('reply lost');};
  const app=await mount(h(Host,{api,data:{devices:{}}}));
  await api.answer('hosting',{configured:false,running:false});
  await enterCircleName(app,'Weekend');await click(app.button('Start circle'));
  await api.answer('hosting',{configured:false,running:false});await flush();
  assert.doesNotMatch(app.text(),/Circle setup unconfirmed/);
  assert.ok(app.button('Start circle'),'the person can still try again');
});

test('followup failed setup offers circle inspection without claiming recovery', () => {
  const out=status(running,{setupError:'Circle setup failed'});
  assert.match(out,/href="#\/circles"[^>]*>Inspect circles/);
  assert.match(renderedText(out),/Check hosting status/);
  assert.doesNotMatch(renderedText(out),/Invite someone|Start again/);
});

test('followup address mismatch keeps stop confirmation and cancellation independent of invitations', async () => {
  resetPage();installClock();
  const changed={...running,addressChanged:{expected:'https://saved.example',observed:'https://other.example'}};
  const requests=[],updates=[];
  const api={request:async(path,options)=>{requests.push({path,options});},get:async()=>({...changed,running:false})};
  const props={vm:hostStatusVM(changed),hosting:changed,api,onUpdated:next=>updates.push(next)};
  const app=await mount(h(HostStatus,props));
  assert.equal(app.button('Invite someone'),null);
  assert.ok(app.button('Stop hosting'));
  await click(app.button('Stop hosting'));
  assert.ok(app.button('Keep hosting'));
  assert.equal(requests.length,0,'opening confirmation does not stop');
  await click(app.button('Keep hosting'));
  assert.equal(requests.length,0,'cancel does not stop');
  assert.equal(app.button('Keep hosting'),null);
  await click(app.button('Stop hosting'));
  await click(app.$('.btn-danger:not([aria-expanded])'));
  assert.equal(requests.length,1);
  assert.equal(requests[0].path,'ops/hosting.stop');
  assert.equal(requests[0].options.headers['faravan-confirm'],'yes');
  assert.equal(updates[0].running,false);
  assert.equal(app.button('Keep hosting'),null);
  await app.rerender(h(HostStatus,{...props,stale:true}));
  assert.equal(app.button('Stop hosting'),null);
  await app.rerender(h(HostStatus,{...props,hosting:{...changed,running:false}}));
  assert.equal(app.button('Stop hosting'),null);
});

test('the fixed invitation address is disclosed before the circle starts', () => {
  assert.match(renderedText(choose({method:'public'})),/Invitations use one fixed address. Keep it when restarting the circle./);
});

// Unknown is not absent: a hosting read that failed is said so, with the reason, never "start a circle" or "isn't running".
const unreadable = {configured: null, unreadable: {what: 'config', reason: 'could not read host config at /h/host.json: Unexpected token'}};
test('hostStatusVM: an unreadable hosting config is its own state and names the reason', () => {
  const vm = hostStatusVM(unreadable, {now: NOW, zone: 'UTC'});
  assert.equal(vm.kind, 'unreadable');
  assert.match(vm.banner.headline, /^Couldn’t read hosting status/);
  assert.match(vm.banner.text, /Unexpected token/);
  assert.equal(vm.banner.tone, 'bad');
});
test('hostStatusVM: an unreadable status file is not "isn’t running"', () => {
  const vm = hostStatusVM({...running, running: null, processState: 'unreadable', statusError: 'could not read coordinator status at /h/status.json: bad'}, {now: NOW, zone: 'UTC'});
  assert.equal(vm.kind, 'unreadable'); assert.match(vm.banner.text, /coordinator status/);
});
test('circles.host-unreadable: the page says it could not read, not that nothing is set up or stopped', () => {
  const text = renderedText(status(unreadable));
  assert.match(text, /Couldn’t read hosting status/); assert.match(text, /Unexpected token/);
  assert.doesNotMatch(text, /Start a circle|isn’t running|Start again/);
});
test('circleHostingVM and hostRestartVM do not treat an unreadable read as absent or offer to restart', () => {
  const circle = {id: 'c1', origin: 'https://x.example', owned: true};
  const vm = circleHostingVM(circle, unreadable);
  assert.equal(vm.canStop, false); assert.match(vm.text, /Couldn’t read hosting status/);
  assert.equal(hostRestartVM(unreadable), null);
});

test('Start another circle with an unreadable host status shows the reason, not the new-circle form', async () => {
  resetPage();installClock();
  const api=createFakeApi(), app=await mount(h(Host,{api,data:{devices:{}},newCircle:true,mutate:async()=>({id:'c2'})}));
  await api.answer('hosting',{...running,circles:[{id:'c1',name:'Weekend projects'}],running:null,processState:'unreadable',statusError:'could not read coordinator status at /h/status.json: bad'});
  assert.equal(Boolean(app.$('input')), false, 'no name field while the host status is unreadable');
  assert.match(app.text(),/Couldn’t read hosting status/);
  assert.match(app.text(),/could not read coordinator status/);
});
