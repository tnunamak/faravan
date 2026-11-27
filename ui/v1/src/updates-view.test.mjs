import test, {afterEach} from 'node:test';
import {h} from 'preact';
import {mount,click,forceClick,flush,teardown,installClock,advance} from './mounted.test-helper.mjs';
afterEach(teardown);
import assert from 'node:assert/strict';
import { updatesVM } from './updates-view.mjs';
import { Updates } from './updates.jsx';
import { renderFixture } from './render.test-helper.mjs';
test('updates names package owner and never offers an app restart',()=>{
  const vm=updatesVM({owner:'apt',state:'managed',currentVersion:'1.0.0'});
  assert.match(vm.explanation,/Managed by apt/);assert.equal(vm.canCheck,false);
  const html=renderFixture(Updates,{initial:{owner:'apt',state:'managed',currentVersion:'1.0.0'}});
  assert.match(html,/1.0.0/);assert.doesNotMatch(html,/Restart anyway|Check now/);
});
test('a staged update waits for the named person',()=>{
  const vm=updatesVM({owner:'faravan',state:'staged',candidate:'1.1.0',waitingFor:'Ana'});
  assert.equal(vm.headline,"Updating after Ana’s job");assert.equal(vm.canCheck,true);
});

test('P1-1 failed freshness overrides current and successful retry restores it',async()=>{
  let fails=true,finish;
  const data={owner:'faravan',state:'current',currentVersion:'1.0.0',checkedAt:'2026-10-30T10:00:00Z'};
  assert.equal(updatesVM({...data,error:'failed'}).headline,'Update status unknown');
  const view=await mount(h(Updates,{initial:data,api:{get:async()=>data,post:async()=>{if(fails)throw Error('failed');return new Promise(resolve=>{finish=resolve;});}}}));
  await click(view.button('Check now'));
  assert.equal(view.$('h2').textContent,'Update status unknown');
  assert.match(view.text(),/1.0.0/);
  assert.match(view.text(),/Last checked/);
  assert.match(view.text(),/We couldn’t check for updates/);
  fails=false;await click(view.button('Check now'));
  assert.equal(view.$('h2').textContent,'Update status unknown');
  finish(data);await flush();
  assert.equal(view.$('h2').textContent,'You’re up to date');
});
test('P2-1 unsupported state with candidate is unknown rather than availability assurance',()=>{
  assert.equal(updatesVM({owner:'faravan',state:'unrecognized',candidate:'2.0'}).headline,'Update status unknown');
  assert.equal(updatesVM({owner:'faravan',candidate:'2.0'}).headline,'Update status unknown');
});
test('P2-2 missing metadata does not invent development or Git provenance',()=>{
  assert.equal(updatesVM({}).explanation,'Update management is unknown for this build.');
  assert.match(renderFixture(Updates,{initial:{}}),/Version unavailable/);
  assert.doesNotMatch(renderFixture(Updates,{initial:{}}),/Development build|development checkout|Git/);
  assert.match(updatesVM({owner:'brew'}).explanation,/Homebrew/);
});
test('P2-3 initial failure is unavailable and retries are single flight',async()=>{
  let calls=0,rejectRetry;
  const view=await mount(h(Updates,{api:{get:()=>{calls++;return calls===1?Promise.reject(Error('failed')):calls===3?Promise.resolve({owner:'faravan',state:'current'}):new Promise((resolve,reject)=>{rejectRetry=reject;});}}}));
  await flush();
  assert.equal(view.$('h2').textContent,'Update status unavailable');
  await click(view.button('Try again'));
  const button=view.button('Loading update status…');
  assert.equal(button.disabled,true);
  await forceClick(button);assert.equal(calls,2);
  rejectRetry(Error('failed'));await flush();
  assert.ok(view.button('Try again'));
  assert.equal(view.$('h2').textContent,'Update status unavailable');
  await click(view.button('Try again'));assert.equal(calls,3);
  assert.equal(view.$('h2').textContent,'You’re up to date');
});

const current={owner:'faravan',state:'current',currentVersion:'1'};
test('R1 older mount reads cannot overwrite a newer manual failure',async()=>{
  let old;
  const view=await mount(h(Updates,{initial:current,api:{get:()=>new Promise(resolve=>{old=resolve;}),post:async()=>({...current,error:'failed'})}}));
  await click(view.button('Check now'));
  assert.equal(view.$('h2').textContent,'Update status unknown');
  old(current);await flush();
  assert.equal(view.$('h2').textContent,'Update status unknown');
});
test('R1 newer event survives stale read rejection and check completion',async()=>{
  let rejectRead,finishCheck,confirm,reads=0;
  const api={get:()=>++reads===1?new Promise((resolve,reject)=>{rejectRead=reject;}):new Promise(resolve=>{confirm=resolve;}),post:()=>new Promise(resolve=>{finishCheck=resolve;})};
  const view=await mount(h(Updates,{initial:current,api}));
  await click(view.button('Check now'));
  await view.rerender(h(Updates,{initial:{...current,state:'available',candidate:'2'},api}));
  rejectRead(Error('old'));finishCheck({...current,error:'old'});await flush();
  assert.equal(reads,2,'event requires a confirmation after actual check settlement');
  assert.equal(view.$('h2').textContent,'Update status unknown');
  confirm({...current,state:'available',candidate:'2'});await flush();
  assert.equal(view.$('h2').textContent,'Faravan 2 is available');
  assert.equal(Boolean(view.$('[role="alert"]')),false);
});
test('R5 a newer event clears a prior local failure even for package-managed updates',async()=>{
  let reads=0,confirm;
  const api={get:()=>++reads===1?Promise.reject(Error('failed')):new Promise(resolve=>{confirm=resolve;})};
  const view=await mount(h(Updates,{api}));
  assert.equal(view.$('h2').textContent,'Update status unavailable');
  await view.rerender(h(Updates,{api,initial:{owner:'apt',state:'managed'}}));
  assert.equal(view.$('h2').textContent,'Update status unavailable');
  assert.match(view.$('[role="alert"]').textContent,/could not be read/);
  confirm({owner:'apt',state:'managed'});await flush();
  assert.equal(view.$('h2').textContent,'Updates managed outside Faravan');
  assert.equal(Boolean(view.$('[role="alert"]')),false);
});
test('R2 settled checking status has a read-only recovery action',async()=>{
  let reads=0;
  const api={get:async()=>++reads===1?{...current,state:'checking'}:current};
  const view=await mount(h(Updates,{api}));
  assert.equal(view.button('Checking…').disabled,true);
  await click(view.button('Refresh status'));
  assert.equal(reads,2);assert.equal(view.$('h2').textContent,'You’re up to date');
});
test('R2 timed-out mutation permits status recovery but cannot duplicate the unresolved check',async()=>{
  installClock();let finish,posts=0,reads=0;
  const api={get:async()=>{reads++;return current;},post:()=>{posts++;return new Promise(resolve=>{finish=resolve;});}};
  const view=await mount(h(Updates,{api,initial:current}));
  await click(view.button('Check now'));await advance(15001);
  assert.match(view.text(),/Update status timed out/);
  await forceClick(view.button('Checking…'));assert.equal(posts,1);
  await click(view.button('Refresh status'));assert.equal(reads,2);
  finish({...current,state:'available',candidate:'OLD'});await flush();
  assert.equal(view.$('h2').textContent,'You’re up to date');
});
test('R2 timed-out initial read can retry and ignores its late result',async()=>{
  installClock();let old,reads=0;
  const api={get:()=>++reads===1?new Promise(resolve=>{old=resolve;}):Promise.resolve(current)};
  const view=await mount(h(Updates,{api}));await advance(15001);
  await click(view.button('Try again'));assert.equal(reads,2);
  old({...current,state:'available',candidate:'OLD'});await flush();
  assert.equal(view.$('h2').textContent,'You’re up to date');
});

test('sweep failed freshness labels cached details and reports the failure only once',async()=>{
  const data={...current,notes:['Cached release note'],notesUrl:'https://example.test/notes'};
  const view=await mount(h(Updates,{initial:data,api:{get:async()=>data,post:async()=>{throw Error('offline');}}}));
  await click(view.button('Check now'));
  assert.equal(view.$('h2').textContent,'Update status unknown');
  assert.match(view.text(),/Last known update details and release notes/);
  assert.match(view.text(),/Cached release note/);
  assert.equal((view.text().match(/We couldn’t check for updates/g)||[]).length,1);
  assert.equal(view.$('[role="alert"]').textContent,'We couldn’t check for updates. Your installed version is still running. Try again.');
});
test('mounted Updates shows the fixed legacy exposure action for the installed version',async()=>{
  const message='Review the saved legacy exposure before trying the update again. Your current version keeps running.';
  const blocked={...current,state:'failed',error:message};
  const view=await mount(h(Updates,{initial:blocked,api:{get:async()=>blocked}}));
  assert.equal(view.$('[role="alert"]').textContent,message);
  assert.match(view.text(),new RegExp(blocked.currentVersion.replaceAll('.','[.]')));
});
test('sweep server failure also labels stale details without a second failure explanation',()=>{
  const html=renderFixture(Updates,{initial:{...current,error:'Server check failed'}});
  assert.match(html,/Last known update details and release notes/);
  assert.match(html,/role="alert"[^>]*>Server check failed/);
  assert.doesNotMatch(html,/We couldn’t check for updates/);
});
test('sweep unresolved check remains explained after status refresh and cannot duplicate',async()=>{
  installClock();let posts=0,finish;
  const api={get:async()=>current,post:()=>{posts++;return new Promise(resolve=>{finish=resolve;});}};
  const view=await mount(h(Updates,{initial:current,api}));
  await click(view.button('Check now'));
  assert.equal(view.$('button').parentElement.querySelectorAll('button').length,1,'one progress control during the check');
  await advance(15001);
  assert.match(view.text(),/A check may still be running/);
  assert.doesNotMatch(view.text(),/check stopped|will not be started again/);
  await click(view.button('Refresh status'));
  assert.match(view.$('[role="status"]').textContent,/still unresolved/);
  await forceClick(view.button('Checking…'));assert.equal(posts,1);
  finish(current);await flush();
  assert.equal(view.button('Check now').disabled,false);
  assert.equal(view.$('[role="status"]'),null);
});
test('sweep rollback and candidate-less availability have consistent copy',()=>{
  const rolledBack=updatesVM({...current,state:'rolled_back'});
  assert.match(rolledBack.explanation,/rolled back/);
  assert.doesNotMatch(rolledBack.explanation,/install by themselves/);
  assert.equal(updatesVM({...current,state:'available'}).headline,'An update is available');
  assert.match(updatesVM({owner:'apt',state:'rolled_back'}).explanation,/Managed by apt/);
});

test('followup applied and restarting updates cannot start another check', () => {
  for (const state of ['applied','restarting']) {
    const data={owner:'faravan',state,currentVersion:'1.0.0'};
    const vm=updatesVM(data);
    assert.equal(vm.canCheck,false,state);
    assert.equal(vm.headline,'Faravan is restarting');
    const html=renderFixture(Updates,{initial:data});
    assert.match(html,/Faravan is restarting/);
    assert.doesNotMatch(html,/Check now/);
  }
  assert.equal(updatesVM({owner:'faravan',state:'staged'}).canCheck,true);
});

function ownedUpdatesApi() {
  const reads=[],posts=[];
  const deferred=(list,path)=>{
    const call={path,settled:false};
    const promise=new Promise((resolve,reject)=>{
      call.resolve=value=>{call.settled=true;resolve(value);};
      call.reject=error=>{call.settled=true;reject(error);};
    });
    list.push(call);return promise;
  };
  return {reads,posts,get:path=>deferred(reads,path),post:path=>deferred(posts,path)};
}
const available=candidate=>({...current,state:'available',candidate,notes:['Confirmed '+candidate]});
test('advisory older shell snapshot retains confirmed page data until GET confirms',async()=>{
  const api=ownedUpdatesApi(),seed=available('seed');
  const view=await mount(h(Updates,{api,initial:seed}));
  api.reads[0].resolve(available('S1'));await flush();
  await view.rerender(h(Updates,{api,initial:available('S0')}));
  assert.equal(api.reads.length,2);assert.equal(api.reads[1].path,'updates');
  assert.equal(view.$('h2').textContent,'Faravan S1 is available');
  assert.match(view.text(),/Confirmed S1/);
  api.reads[1].resolve(available('S2'));await flush();
  assert.equal(view.$('h2').textContent,'Faravan S2 is available');
});
test('advisory JSON-equal snapshots do not cancel or duplicate a held read',async()=>{
  const api=ownedUpdatesApi();
  const view=await mount(h(Updates,{api,initial:current}));
  await view.rerender(h(Updates,{api,initial:JSON.parse(JSON.stringify(current))}));
  await view.rerender(h(Updates,{api,initial:{currentVersion:'1',state:'current',owner:'faravan'}}));
  assert.equal(api.reads.length,1);
  api.reads[0].resolve(available('confirmed'));await flush();
  assert.equal(api.reads.length,1);
  assert.equal(view.$('h2').textContent,'Faravan confirmed is available');
});
test('advisory changed hints during held GET coalesce after physical settlement',async()=>{
  const api=ownedUpdatesApi();
  const view=await mount(h(Updates,{api,initial:current}));
  for(const candidate of ['A','B','C'])await view.rerender(h(Updates,{api,initial:available(candidate)}));
  assert.equal(api.reads.length,1);
  api.reads[0].resolve(available('first'));await flush();
  assert.equal(api.reads.length,2);assert.equal(api.reads[0].settled,true);
  assert.equal(view.$('h2').textContent,'Faravan first is available');
  for(const candidate of ['D','E'])await view.rerender(h(Updates,{api,initial:available(candidate)}));
  assert.equal(api.reads.length,2);
  api.reads[1].resolve(available('second'));await flush();
  assert.equal(api.reads.length,3);assert.equal(api.reads[1].settled,true);
  api.reads[2].resolve(available('final'));await flush();
  assert.equal(api.reads.length,3);assert.equal(view.$('h2').textContent,'Faravan final is available');
});
test('advisory POST hints retain ownership and failed confirmation retains cached evidence',async()=>{
  const api=ownedUpdatesApi();
  const view=await mount(h(Updates,{api,initial:current}));
  api.reads[0].resolve(current);await flush();
  await click(view.button('Check now'));
  await view.rerender(h(Updates,{api,initial:available('hint')}));
  assert.equal(api.reads.length,1);assert.equal(api.posts.length,1);
  await forceClick(view.button('Checking…'));assert.equal(api.posts.length,1);
  api.posts[0].reject(Error('offline'));await flush();
  assert.equal(api.reads.length,2);
  assert.match(view.text(),/We couldn’t check for updates/);
  api.reads[1].reject(Error('offline'));await flush();
  assert.equal(view.$('h2').textContent,'Update status unknown');
  assert.match(view.text(),/Last known update details/);
  assert.match(view.text(),/We couldn’t check for updates/);
  await view.rerender(h(Updates,{api,initial:available('hint')}));
  assert.equal(api.reads.length,2,'equal hint must neither retry nor clear failure');
  assert.match(view.text(),/We couldn’t check for updates/);
  await view.rerender(h(Updates,{api,initial:available('hint2')}));
  assert.equal(api.reads.length,3);
  assert.match(view.text(),/We couldn’t check for updates/);
  api.reads[2].resolve(available('confirmed'));await flush();
  assert.equal(view.$('[role="alert"]'),null);
  assert.equal(view.$('h2').textContent,'Faravan confirmed is available');
});
test('advisory timeout cannot release unresolved POST or launch automatic overlapping reads',async()=>{
  installClock();const api=ownedUpdatesApi();
  const view=await mount(h(Updates,{api,initial:current}));
  api.reads[0].resolve(current);await flush();
  await click(view.button('Check now'));
  await view.rerender(h(Updates,{api,initial:available('hint')}));
  await advance(15001);
  assert.match(view.text(),/Update status timed out/);
  assert.match(view.text(),/A check may still be running/);
  assert.equal(api.reads.length,1);
  await forceClick(view.button('Checking…'));assert.equal(api.posts.length,1);
  await click(view.button('Refresh status'));assert.equal(api.reads.length,2);
  api.reads[1].resolve(current);await flush();
  assert.match(view.text(),/still unresolved/);
  api.posts[0].resolve(available('late'));await flush();
  assert.equal(api.reads.length,3);
  assert.equal(view.$('h2').textContent,'You’re up to date');
  api.reads[2].resolve(available('confirmed'));await flush();
  assert.equal(api.posts.length,1);assert.equal(api.reads.length,3);
  assert.equal(view.$('h2').textContent,'Faravan confirmed is available');
});
for(const operation of ['read','check'])test('advisory '+operation+' queued hints die with unmount or API replacement',async()=>{
  for(const replace of [false,true]){
    const api=ownedUpdatesApi(),next=ownedUpdatesApi();
    const view=await mount(h(Updates,{api,initial:current}));
    let held=api.reads[0];
    if(operation==='check'){held.resolve(current);await flush();await click(view.button('Check now'));held=api.posts[0];}
    await view.rerender(h(Updates,{api,initial:available('old hint')}));
    if(replace)await view.rerender(h(Updates,{api:next,initial:available('new seed')}));
    else await view.unmount();
    held.resolve(available('old completion'));await flush();
    assert.equal(api.reads.length,1,'old queued confirmation must not run');
    assert.equal(next.reads.length,replace?1:0);
    if(replace){
      assert.doesNotMatch(view.text(),/old completion|old hint|new seed/,'neither stale completion nor replacement hint is page authority');
      next.reads[0].resolve(available('new confirmed'));await flush();
      assert.equal(view.$('h2').textContent,'Faravan new confirmed is available');
      assert.equal(next.reads.length,1);await view.unmount();
    }
  }
});

test('advisory held GET deadline does not consume queued hint before physical settlement',async()=>{
  installClock();const api=ownedUpdatesApi();
  const view=await mount(h(Updates,{api,initial:current}));
  await view.rerender(h(Updates,{api,initial:available('hint')}));
  await advance(15001);
  assert.equal(api.reads.length,1);
  assert.match(view.text(),/Update status timed out/);
  api.reads[0].resolve(available('late'));await flush();
  assert.equal(api.reads.length,2);
  assert.doesNotMatch(view.text(),/Faravan late is available/);
  assert.match(view.text(),/Update status timed out/);
  api.reads[1].resolve(available('confirmed'));await flush();
  assert.equal(view.$('h2').textContent,'Faravan confirmed is available');
  assert.equal(view.$('[role="alert"]'),null);
});
