import {resetPage,mount,click,flush,teardown,act} from './mounted.test-helper.mjs';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Accounts} from './accounts.jsx';
import {createAccountClient,guardApi} from './api.mjs';
afterEach(teardown);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const account=(id,label)=>({schemaVersion:1,id,providerId:'synthetic',label,authState:'signed_in',generation:0,expiresAtMs:null,enabled:true,modelOrder:['m']});
function snapshot(accounts=[]) {return {schemaVersion:1,revision:4,accounts,accountOrder:accounts.map(a=>a.id),
  providers:[{id:'synthetic',label:'Fixture provider',signInKind:'api_key',refreshKind:'none',usageKind:'none',
    models:[{id:'m',label:'Fixture model',enabled:true,rank:0,efforts:[{id:'high',label:'High'}],defaultEffort:'high',pareto:null}]}],
  capabilities:{mutations:['enroll','complete','cancel','remove','settings'],settings:['enabled','modelOrder','accountOrder']}};}
function apiFor(data=snapshot()) {
  const calls=[];return {calls,data,get:async function(path,signal){calls.push({method:'get',path,signal});return this.data;},
    post:async function(path,body,signal){calls.push({method:'post',path,body,signal});return {ok:false,error:{code:'update_required'}};}};
}
async function show(api){resetPage();return mount(h(Accounts,{api,viewerSession:{kind:'local'}}));}
test('mounted empty state, accessible labels and keyboard focus; conservative explicit capability arrays',async()=>{
  const v=await show(apiFor());assert.match(v.text(),/No accounts/);
  const select=v.$('select[aria-label="Provider"]');assert.ok(select);select.focus();assert.equal(document.activeElement,select);
  assert.ok(v.$('input[aria-label="Account label"]'));assert.ok(v.button('Add account'));
});
test('same-provider accounts stay separate in saved order, models and efforts visible',async()=>{
  const data=snapshot([account('a','First'),account('b','Second')]);data.accountOrder=['b','a'];
  const v=await show(apiFor(data));assert.deepEqual(v.$$('article h3').map(x=>x.textContent),['Second','First']);
  assert.match(v.text(),/Fixture model/);assert.match(v.text(),/High/);
  assert.ok(v.button('Disable Second'));assert.ok(v.button('Remove First'));
});
test('lender edits provider-defined model, effort and Pareto settings',async()=>{
  const a=account('a','First'), data=snapshot([a]);
  data.capabilities.settings.push('modelPreference','paretoOnly');
  const live=data.providers[0].models[0];
  live.id='provider-live-model';
  live.label='Provider live model';
  live.efforts=[{id:'provider-level',label:'Provider level'}];
  live.defaultEffort='provider-level';
  const api=apiFor(data);
  api.post=async(path,body)=>{
    api.calls.push({path,body});
    if (body.modelPreference) {
      const {modelId,...saved}=body.modelPreference;
      a.modelPreferences={...a.modelPreferences,[modelId]:saved};
    }
    if ('paretoOnly' in body) a.paretoOnly=body.paretoOnly;
    return {ok:true,value:{revision:4}};
  };
  const view=await show(api);
  const checkbox=label=>view.$$('label').find(node=>node.textContent.trim()===label).querySelector('input');
  assert.equal(checkbox('Lend Provider live model').checked,false);
  await click(checkbox('Lend Provider live model'));
  await flush();
  assert.equal(checkbox('Lend Provider live model').checked,true);
  await click(checkbox('Provider level'));
  await flush();
  assert.deepEqual(api.calls.at(-2).body.modelPreference,{modelId:'provider-live-model',enabled:true,effortIds:[]});
  await click(checkbox('Pareto only'));
  await flush();
  assert.equal(checkbox('Pareto only').checked,true);
  assert.ok(api.calls.some(call=>call.body?.paretoOnly===true));
});

test('missing service and unknown capabilities never become successful setup',async()=>{
  const api=apiFor();api.get=async()=>{throw {status:404};};
  const v=await show(api);assert.match(v.text(),/Update this host/);assert.equal(v.button('Add account'),null);
  const b=apiFor();b.data.capabilities={};await v.rerender(h(Accounts,{api:b,viewerSession:{kind:'local'}}));
  assert.equal(v.button('Add account')?.disabled,true);
});
test('repeated add coalesces; completion clears sensitive answer before awaiting result',async()=>{
  const api=apiFor(),pending=deferred(),finish=deferred();
  api.post=async(path,body)=>{api.calls.push({path,body});return path==='accounts'?pending.promise:finish.promise;};
  const v=await show(api);
  await click(v.button('Add account'));await click(v.button('Add account'));assert.equal(api.calls.filter(c=>c.path==='accounts'&&c.body).length,1);
  pending.resolve({ok:true,value:{flowId:'flow/1',state:'waiting',presentation:{kind:'key'}}});await flush();
  const field=v.$('input[type=password]');assert.ok(field);
  await act(()=>{field.value='synthetic-private-answer';field.dispatchEvent(new Event('input',{bubbles:true}));});
  await click(v.button('Complete sign-in'));assert.equal(field.value,'');
  assert.equal(v.text().includes('synthetic-private-answer'),false);
  finish.resolve({ok:true,value:account('a','New')});await flush();
  assert.equal(v.$('input[type=password]'),null);
  assert.equal(api.calls.find(c=>c.path==='accounts/flows/flow%2F1/complete').body.answer,'synthetic-private-answer');
});
test('browser sign-in can submit the code the provider asks the user to paste',async()=>{
  const api=apiFor();
  api.post=async(path,body)=>{
    api.calls.push({path,body});
    return path==='accounts'
      ? {ok:true,value:{flowId:'browser-flow',state:'waiting',presentation:{kind:'browser',url:'https://fixture.invalid/sign-in'}}}
      : {ok:true,value:account('a','Fixture')};
  };
  const view=await show(api);
  await click(view.button('Add account'));
  await flush();
  assert.ok(view.$('a[href="https://fixture.invalid/sign-in"]'));
  const field=view.$('input[aria-label="Code from sign-in"]');
  assert.ok(field);
  await act(()=>{field.value='fixture-code';field.dispatchEvent(new Event('input',{bubbles:true}));});
  await click(view.button('Complete sign-in'));
  assert.equal(api.calls.find(c=>c.path==='accounts/flows/browser-flow/complete').body.answer,'fixture-code');
  assert.equal(field.value,'');
});

test('cancel closes only acknowledged flow and errors are sanitized with one action',async()=>{
  const api=apiFor();api.post=async(path)=>path==='accounts'?{ok:true,value:{flowId:'f',state:'waiting',presentation:{kind:'key'}}}:{ok:true,value:null};
  const v=await show(api);await click(v.button('Add account'));await click(v.button('Cancel sign-in'));
  assert.equal(v.$('input[type=password]'),null);
  api.post=async()=>({ok:false,error:{code:'signin_failed',message:'PRIVATE',nextAction:{label:'PRIVATE'}}});
  await click(v.button('Add account'));assert.equal(v.text().includes('PRIVATE'),false);
  assert.equal(v.$$('div[role=alert] button').length,1);
});
test('revision conflict preserves preference and sends only supported change',async()=>{
  const api=apiFor(snapshot([account('a','One')]));
  api.post=async(path,body)=>{api.calls.push({path,body});return {ok:false,error:{code:'settings_conflict'}};};
  const v=await show(api);await click(v.button('Disable One'));
  const call=api.calls.find(c=>c.body);assert.deepEqual(call.body,{expectedRevision:4,enabled:false});
  assert.ok(v.button('Disable One'));assert.match(v.text(),/changed elsewhere/);
});
test('pending removal retains account and stable operation until durable acknowledgement',async()=>{
  const api=apiFor(snapshot([account('a','One')]));let n=0;
  api.post=async(path,body)=>{api.calls.push({path,body});return ++n===1?{ok:false,error:{code:'account_removal_pending'}}:{ok:true,value:null};};
  const v=await show(api);await click(v.button('Remove One'));assert.match(v.text(),/One/);assert.match(v.text(),/Removal pending/);
  await click(v.button('Check removal One'));
  const posts=api.calls.filter(c=>c.body);assert.equal(posts[0].body.operationId,posts[1].body.operationId);
  assert.equal(v.$$('article').length,0);
});
test('unmount aborts reads and cancels late enrollment flow without rendering private data',async()=>{
  const api=apiFor(),pending=deferred();api.post=async(path,body)=>{api.calls.push({path,body});return path==='accounts'?pending.promise:{ok:true,value:null};};
  const v=await show(api);await click(v.button('Add account'));await v.unmount();
  pending.resolve({ok:true,value:{flowId:'late',state:'waiting',presentation:{kind:'browser',url:'https://fixture.invalid/private'}}});await flush();
  assert.ok(api.calls.some(c=>c.path==='accounts/flows/late/cancel'));
  assert.equal(document.body.textContent.includes('private'),false);
});
test('paired viewer sends no account reads; held guard prevents mutation',async()=>{
  const api=apiFor();resetPage();const v=await mount(h(Accounts,{api,viewerSession:{kind:'paired'}}));
  assert.equal(api.calls.length,0);assert.match(v.text(),/Open this computer/);
  const client=createAccountClient(guardApi(api,()=>true));
  await assert.rejects(()=>client.enroll({providerId:'synthetic',label:'x',operationId:'op'}));
  assert.equal(api.calls.length,0);
});
test('facade encodes opaque IDs and never forwards unsupported settings',async()=>{
  const api=apiFor();const c=createAccountClient(api);
  await c.remove('a/b','stable');assert.equal(api.calls.at(-1).path,'accounts/a%2Fb/remove');
  await assert.rejects(()=>c.settings('a',4,{secret:'no'},snapshot().capabilities));
  assert.equal(api.calls.filter(c=>c.body).length,1);
});
