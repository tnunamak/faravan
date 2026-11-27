import {mount, teardown, advance, resetPage, installClock, click, flush, act} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {SignIn, SignInProgress} from './signin.jsx';
import {beginSignIn, readProgress, writeProgress} from './signin.mjs';

afterEach(teardown);

test('a blocked popup leaves a same-tab progress link while startup is pending', async () => {
  resetPage();
  const originalOpen=window.open;
  window.open=()=>{throw new Error('blocked popup');};
  let release,posts=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const api={post:async()=>{posts++;return pending;},get:async()=>({})};
  try {
    const view=await mount(h(SignIn,{api,target:'codex',agentName:'Codex'}));
    await click(view.button('Sign in to Codex'));
    const fallback=view.$('a');
    assert.equal(posts,1);
    assert.match(fallback.textContent,/Continue sign-in in this tab/);
    assert.match(fallback.getAttribute('href'),/^\/#\/signin\//);
    assert.equal(fallback.hasAttribute('target'),false);
    release({flowId:'provider-flow',target:'codex',status:'starting'});
    await flush();
    assert.match(view.$('a').textContent,/Continue sign-in in this tab/);
    assert.equal(view.$('a').hasAttribute('target'),false);
  } finally { window.open=originalOpen; }
});

test('progress page polls server flow state and gets the provider URL without an opener storage write', async () => {
  resetPage();
  installClock();
  const id='01234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage,id,{target:'codex',agentName:'Codex',startedAt:Date.now()});
  let reads=0,redirected='';
  window.location.replace=url=>{redirected=url;};
  const api={get:async path=>{
    assert.equal(path,'signin/'+id);
    reads++;
    return reads===1
      ? {flowId:id,target:'codex',status:'starting',stage:'sandbox_prepare',message:'Preparing sign-in.'}
      : {flowId:id,target:'codex',status:'awaiting_browser',url:'https://login.example.test/device',message:'Finish sign-in.'};
  },post:async()=>({})};
  const view=await mount(h(SignInProgress,{id,api}));
  assert.match(view.text(),/Starting a secure sign-in for Codex/);
  await advance(2000);
  assert.equal(redirected,'https://login.example.test/device');
  assert.equal(reads,2);
});

test('progress page recovers the URL when the initial localStorage write is unavailable', async () => {
  resetPage();installClock();
  const id='11234567-89ab-4def-8123-456789abcdef';
  const setItem=localStorage.setItem;
  localStorage.setItem=()=>{throw new Error('storage unavailable');};
  let redirected='';window.location.replace=url=>{redirected=url;};
  let reads=0;
  const api={get:async()=>++reads===1
    ?{flowId:id,target:'codex',status:'starting',stage:'backend_health'}
    :{flowId:id,target:'codex',status:'awaiting_browser',url:'https://login.example.test/recovered'},post:async()=>({})};
  try {
    const view=await mount(h(SignInProgress,{id,api}));
    assert.match(view.text(),/Starting a secure sign-in for codex/);
    await advance(2000);
    assert.equal(redirected,'https://login.example.test/recovered');
  } finally { localStorage.setItem=setItem; }
});

test('a successful server poll overrides a lost POST response saved as an error', async () => {
  resetPage();installClock();
  const id='21234567-89ab-4def-8123-456789abcdef';
  let redirected='';window.location.replace=url=>{redirected=url;};
  const api={post:async()=>{throw Object.assign(new Error('offline'),{code:'network'});},get:async()=>
    ({flowId:id,target:'codex',status:'awaiting_browser',url:'https://login.example.test/recovered'})};
  await assert.rejects(beginSignIn({api,target:'codex',agentName:'Codex',storage:localStorage,open:()=>null,id,onFlow:()=>{}}));
  assert.equal(readProgress(localStorage,id).errorCode,'network');
  const view=await mount(h(SignInProgress,{id,api}));
  await advance(1);
  assert.equal(redirected,'https://login.example.test/recovered');
  assert.doesNotMatch(view.text(),/Can’t reach your computer/);
});

test('Cancel uses the in-memory server flow when localStorage is unavailable', async () => {
  resetPage();installClock();
  const id='31234567-89ab-4def-8123-456789abcdef';
  const setItem=localStorage.setItem;
  localStorage.setItem=()=>{throw new Error('storage unavailable');};
  const calls=[];
  const api={get:async()=>({flowId:id,target:'codex',status:'starting',stage:'provider_url'}),
    post:async path=>{calls.push(path);return {flowId:id,target:'codex',status:'cancelled'};}};
  try {
    const view=await mount(h(SignInProgress,{id,api}));
    await click(view.button('Cancel sign-in'));
    assert.deepEqual(calls,['signin/'+id+'/cancel']);
    assert.match(view.text(),/Sign-in cancelled/);
  } finally { localStorage.setItem=setItem; }
});

test('an initial missing-flow race recovers when a later poll finds the flow', async () => {
  resetPage();installClock();
  const id='41234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage,id,{target:'codex',agentName:'Codex',startedAt:Date.now()});
  let reads=0;
  const api={get:async()=>{
    reads++;
    if(reads===1)throw {status:404,code:'not_found'};
    return {flowId:id,target:'codex',status:'starting',stage:'provider_url'};
  },post:async()=>({})};
  const view=await mount(h(SignInProgress,{id,api}));
  await advance(2000);
  assert.match(view.text(),/Starting a secure sign-in for Codex/);
  assert.doesNotMatch(view.text(),/no longer available/);
});

test('a missing server flow reaches a bounded recovery state after the initial race grace', async () => {
  resetPage();installClock();
  const id='51234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage,id,{target:'codex',agentName:'Codex',startedAt:Date.now(),
    flow:{flowId:id,target:'codex',status:'awaiting_browser',url:'https://login.example.test/stale'}});
  const api={get:async()=>{throw {status:404,code:'not_found'};},post:async()=>({})};
  let redirected='';window.location.replace=url=>{redirected=url;};
  const view=await mount(h(SignInProgress,{id,api}));
  assert.equal(redirected,'','stale local flow data cannot trigger an auth redirect');
  await advance(8000);
  assert.match(view.text(),/This sign-in is no longer available/);
  assert.match(view.text(),/Return to Lending to start again/);
});

test('an expired app session has explicit recovery copy', async () => {
  resetPage();installClock();
  const id='61234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage,id,{target:'codex',agentName:'Codex',startedAt:Date.now()});
  const api={get:async()=>{throw {status:401,code:'unauthorized'};},post:async()=>({})};
  const view=await mount(h(SignInProgress,{id,api}));
  assert.match(view.text(),/Sign-in session expired/);
  assert.match(view.text(),/Reopen the app to continue/);
});

for (const code of ['signin_redirect_mismatch', 'signin_code_invalid']) test('a refused pasted address keeps its own message through later polls: ' + code, async () => {
  resetPage();
  installClock();
  const originalOpen = window.open;
  window.open = () => ({});
  const flow = {flowId: 'f1', target: 'codex', status: 'awaiting_browser', url: 'https://auth.openai.com/oauth/authorize', redirectEntry: true};
  let submits = 0;
  const api = {
    post: async path => {
      if (!path.endsWith('/code')) return flow;
      submits++;
      throw Object.assign(new Error(code), {code, status: 400});
    },
    get: async () => flow,
  };
  try {
    const view = await mount(h(SignIn, {api, target: 'codex', agentName: 'Codex'}));
    await click(view.button('Sign in to Codex'));
    const input = view.$('input');
    assert.ok(input, 'the paste field is offered on a Codex flow awaiting the browser');
    assert.equal(view.button('Finish sign-in').textContent, 'Finish sign-in');
    await act(() => { input.value = 'http://localhost:1455/auth/callback?code=c&state=s'; input.dispatchEvent(new window.Event('input', {bubbles: true})); });
    await act(() => { view.$('form').dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true})); });
    await flush();
    assert.equal(submits, 1);
    const own = code === 'signin_redirect_mismatch' ? /That address is from a different sign-in\. Start again and paste the new address\./ : /Copy the whole code from the sign-in page and paste it again\./;
    assert.match(view.$('[role="alert"]').textContent, own, 'the problem\'s own copy, not the generic sign-in failure');
    await advance(6000);
    assert.match(view.$('[role="alert"]').textContent, own, 'later polls do not wipe it');
    await act(() => { view.$('form').dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true})); });
    await flush();
    assert.equal(submits, 2, 'submitting again is allowed and replaces it');
  } finally { window.open = originalOpen; }
});
