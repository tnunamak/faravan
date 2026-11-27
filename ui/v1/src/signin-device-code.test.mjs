import {mount, teardown, advance, resetPage, installClock, click, flush, act} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {SignIn, SignInProgress} from './signin.jsx';
import {writeProgress} from './signin.mjs';
import {AgentCard} from './lend.jsx';
import {signInView, hasOtherWays, DEVICE_CODE_UNAVAILABLE_COPY, DEVICE_FAILURE_COPY, ACTION_LABELS} from './signin.mjs';

const realPerformance=globalThis.performance;
const fakePerformanceNow=now=>Object.defineProperty(globalThis,'performance',{configurable:true,value:{now}});
afterEach(async()=>{await teardown();Object.defineProperty(globalThis,'performance',{configurable:true,value:realPerformance});});

const device = {flowId: 'f1', target: 'codex', status: 'awaiting_browser', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI'};
const browser = {flowId: 'f2', target: 'codex', status: 'awaiting_browser', url: 'https://auth.openai.com/oauth/authorize?state=s', redirectEntry: true};
const refused = {flowId: 'f1', target: 'codex', status: 'failed', stage: 'provider_url', reasonCode: 'codex_device_code_unavailable'};
const type = (view, input, value) => act(() => { input.value = value; input.dispatchEvent(new window.Event('input', {bubbles: true})); });

test('the device view offers Other ways to sign in; the other views do not', () => {
  assert.equal(signInView(device).otherWays, true);
  assert.equal(signInView(browser).otherWays, undefined, 'the browser view already has its paste field');
  assert.equal(signInView({...device, target: 'docker'}).otherWays, undefined);
  assert.equal(signInView({...device, target: 'github'}).otherWays, undefined);
  assert.equal(signInView({...device, codeEntry: true, target: 'claude'}).otherWays, undefined);
  assert.equal(hasOtherWays({...device, target: 'codex-lending'}), true);
});

test('the settings line appears only when OpenAI refused a device code', () => {
  const view = signInView(refused);
  assert.equal(view.body, DEVICE_CODE_UNAVAILABLE_COPY);
  assert.equal(view.body, 'OpenAI did not allow a device code sign-in. In ChatGPT, open Settings → Security, turn on device code login for Codex, then try again.');
  assert.equal(view.otherWays, true);
  for (const flow of [{...refused, reasonCode: 'completion_failed'}, {...refused, reasonCode: undefined}, {...refused, status: 'timed_out', reasonCode: 'signin_timeout'},
    {...device}]) {
    const other = signInView(flow);
    assert.notEqual(other.body, DEVICE_CODE_UNAVAILABLE_COPY, JSON.stringify(flow));
    if (flow.status !== 'awaiting_browser') assert.equal(other.otherWays, undefined, JSON.stringify(flow));
  }
});

test('a Codex device flow shows the link, the code with a copy action and no paste field', async () => {
  resetPage();
  installClock();
  const originalOpen = window.open;
  window.open = () => ({});
  const api = {post: async () => device, get: async () => device};
  try {
    const view = await mount(h(SignIn, {api, target: 'codex', agentName: 'Codex'}));
    await click(view.button('Sign in to Codex'));
    assert.match(view.text(), /Your code: ABCD-EFGHI/);
    assert.ok(view.button('Copy code'));
    assert.equal(view.$('a[href="https://auth.openai.com/codex/device"]').textContent, 'Open sign-in page');
    assert.equal(view.$('input'), null);
    assert.ok(view.button('Other ways to sign in'));
  } finally { window.open = originalOpen; }
});

test('Other ways to sign in stops the device flow and starts the browser flow with its paste field', async () => {
  resetPage();
  installClock();
  const originalOpen = window.open;
  window.open = () => ({});
  const posts = [];
  const api = {
    post: async (path, body) => { posts.push([path, body]); return path === 'signin/f1/cancel' ? {...device, status: 'cancelled', code: undefined, url: undefined} : body?.method === 'browser' ? browser : device; },
    get: async path => path === 'signin/f2' ? browser : device,
  };
  try {
    const view = await mount(h(SignIn, {api, target: 'codex', agentName: 'Codex'}));
    await click(view.button('Sign in to Codex'));
    await click(view.button('Other ways to sign in'));
    assert.deepEqual(posts.map(([path]) => path), ['signin/codex', 'signin/f1/cancel', 'signin/codex']);
    assert.equal(posts[0][1].method, undefined, 'the first start is the default, a device code');
    assert.equal(posts[2][1].method, 'browser');
    assert.notEqual(posts[2][1].requestId, posts[0][1].requestId, 'a new request');
    const input = view.$('input');
    assert.ok(input, 'the paste field is shown');
    assert.equal(view.button('Other ways to sign in'), null, 'the control is for the device view');
    const finish = view.button('Finish sign-in');
    assert.equal(finish.getAttribute('aria-disabled'), 'true');
    assert.match(view.text(), /Paste the address first/);
    assert.doesNotMatch(view.text(), /This control is unavailable right now/);
    await type(view, input, 'http://localhost:1455/auth/callback?code=c&state=s');
    assert.equal(view.button('Finish sign-in').getAttribute('aria-disabled'), null);
    assert.doesNotMatch(view.text(), /Paste the address first/);
  } finally { window.open = originalOpen; }
});

test('if stopping the device flow fails, no browser flow is started', async () => {
  resetPage();
  installClock();
  const originalOpen = window.open;
  window.open = () => ({});
  const posts = [];
  const api = {post: async (path, body) => { posts.push(path); if (path.endsWith('/cancel')) throw Object.assign(new Error('x'), {code: 'signin_failed'}); return device; }, get: async () => device};
  try {
    const view = await mount(h(SignIn, {api, target: 'codex', agentName: 'Codex'}));
    await click(view.button('Sign in to Codex'));
    await click(view.button('Other ways to sign in'));
    assert.deepEqual(posts, ['signin/codex', 'signin/f1/cancel']);
    assert.ok(view.text().includes('Other ways to sign in'), 'the device flow is still the open one');
  } finally { window.open = originalOpen; }
});

test('after OpenAI refuses a device code the page says what to turn on and offers Other ways', async () => {
  resetPage();
  installClock();
  const originalOpen = window.open;
  window.open = () => ({});
  const posts = [];
  const api = {post: async (path, body) => { posts.push([path, body]); return body?.method === 'browser' ? browser : refused; }, get: async () => refused};
  try {
    const view = await mount(h(SignIn, {api, target: 'codex', agentName: 'Codex'}));
    await click(view.button('Sign in to Codex'));
    assert.match(view.$('[role="alert"]').textContent, /OpenAI did not allow a device code sign-in\. In ChatGPT, open Settings → Security, turn on device code login for Codex, then try again\./);
    await click(view.button('Other ways to sign in'));
    assert.equal(posts.at(-1)[1].method, 'browser');
    assert.ok(view.$('input'));
  } finally { window.open = originalOpen; }
});

test('the typed address survives the Lending row re-check: the sign-in is not remounted', async () => {
  resetPage('#/lend');
  installClock();
  const originalOpen = window.open;
  window.open = () => ({});
  const api = {post: async () => browser, get: async () => browser};
  const agent = {id: 'codex', installed: true, signedIn: false, proxySignedIn: false, lendingSignInSupported: true, useForLending: true, run: {}};
  const card = next => h('section', {id: 'lend-agents'}, h(AgentCard, {key: 'codex', agent: next, api, blocker: null, refresh() {}, mutate: async () => ({})}));
  try {
    const view = await mount(card(agent));
    await click(view.button('Sign in to Codex'));
    const input = view.$('.agent-signin input');
    assert.ok(input);
    await type(view, input, 'http://localhost:1455/auth/callback?code=c&state=s');
    // The row's own re-check: checking turns on, the clock reads 25 s, and fresh agent data arrives.
    await view.rerender(card({...agent, checking: true, checkingSince: Date.now() - 25_000}));
    await advance(25_000);
    await view.rerender(card({...agent, checking: false, checkedAt: Date.now()}));
    const after = view.$('.agent-signin input');
    assert.equal(after, input, 'the same field, not a new one');
    assert.equal(after.value, 'http://localhost:1455/auth/callback?code=c&state=s');
  } finally { window.open = originalOpen; }
});

// C: each device failure has its own plain line, Try again and Other ways; never CLI text.
const CASES = {
  codex_device_code_unavailable: [/^OpenAI did not allow a device code sign-in\./, 'failed'],
  codex_device_code_rate_limited: [/limiting sign-in requests/, 'failed'],
  codex_device_code_service_unavailable: [/OpenAI is unavailable/, 'failed'],
  codex_device_code_exchange_failed: [/approval did not complete/, 'failed'],
  codex_device_code_expired: [/code expired/, 'timed_out'],
};
for (const [reasonCode, [pattern, status]] of Object.entries(CASES))
  test('device failure ' + reasonCode + ' shows its own line, Try again and Other ways', async () => {
    const flow = {flowId: 'f1', target: 'codex', status, reasonCode, message: 'device code request failed with status 429'};
    const view = signInView(flow);
    assert.match(view.body, pattern);
    assert.equal(view.otherWays, true);
    assert.doesNotMatch(view.body, /status \d|device code request failed/);
    resetPage(); installClock();
    const api = {post: async () => flow, get: async () => flow};
    const original = window.open; window.open = () => ({});
    try {
      const mounted = await mount(h(SignIn, {api, target: 'codex', agentName: 'Codex'}));
      await click(mounted.button('Sign in to Codex'));
      assert.match(mounted.$('[role="alert"]').textContent, pattern);
      assert.ok(mounted.button('Other ways to sign in'));
      assert.ok(mounted.button(ACTION_LABELS.retry), 'a retry button');
    } finally { window.open = original; }
  });
test('every device failure code has copy', () => {
  for (const code of Object.keys(CASES)) assert.ok(DEVICE_FAILURE_COPY[code], code);
});

// F: the phone progress view holds the code instead of redirecting.
test('the phone progress view shows the code, Copy code and Open sign-in page, and does not redirect', async () => {
  resetPage(); installClock();
  const id = '21234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage, id, {target: 'codex', agentName: 'Codex', startedAt: Date.now()});
  let redirected = '';
  window.location.replace = url => { redirected = url; };
  const api = {get: async () => ({flowId: id, target: 'codex', status: 'awaiting_browser', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI'}), post: async () => ({})};
  const view = await mount(h(SignInProgress, {id, api}));
  await advance(2000);
  assert.equal(redirected, '', 'no automatic redirect');
  assert.match(view.text(), /ABCD-EFGHI/);
  assert.ok(view.button('Copy code'));
  assert.equal(view.$('a[href="https://auth.openai.com/codex/device"]').textContent, 'Open sign-in page');
});
test('the phone progress view still redirects when the flow has no code', async () => {
  resetPage(); installClock();
  const id = '31234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage, id, {target: 'codex', agentName: 'Codex', startedAt: Date.now()});
  let redirected = '';
  window.location.replace = url => { redirected = url; };
  const api = {get: async () => ({flowId: id, target: 'codex', status: 'awaiting_browser', url: 'https://auth.openai.com/oauth/authorize?state=s'}), post: async () => ({})};
  await mount(h(SignInProgress, {id, api}));
  await advance(2000);
  assert.equal(redirected, 'https://auth.openai.com/oauth/authorize?state=s');
});

// D: the phone page clears the code at its monotonic receipt deadline, with no new server state.
test('the phone progress view stops showing an expired code at the receipt deadline and offers Try again', async () => {
  resetPage(); installClock();
  const origin=Date.now(); fakePerformanceNow(()=>Date.now()-origin);
  const id = '41234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage, id, {target: 'codex', agentName: 'Codex', startedAt: Date.now()});
  window.location.replace = () => {};
  const flow = {flowId: id, target: 'codex', status: 'awaiting_browser', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI', expiresAt: Date.now() + 60_000, expiresInMs: 60_000};
  let reads=0;
  const api = {get: () => ++reads===1?Promise.resolve(flow):new Promise(()=>{}), post: async () => ({})};
  const view = await mount(h(SignInProgress, {id, api}));
  await advance(2000);
  assert.match(view.text(), /ABCD-EFGHI/, 'the code shows before it expires');
  assert.ok(view.button('Copy code'));
  await advance(61_000);
  assert.doesNotMatch(view.text(), /ABCD-EFGHI/);
  assert.equal(view.button('Copy code'), null);
  assert.equal(view.$('a[href="https://auth.openai.com/codex/device"]'), null, 'no Open sign-in page link');
  assert.match(view.text(), /The code expired before it was approved\./);
  assert.ok(view.button(ACTION_LABELS.retry), 'a retry action');
  assert.equal(view.button(ACTION_LABELS.retry).getAttribute('href'), '#/lend');
});
test('a flow without an expiry keeps its code on the phone view', async () => {
  resetPage(); installClock();
  const id = '51234567-89ab-4def-8123-456789abcdef';
  writeProgress(localStorage, id, {target: 'docker', agentName: 'Docker', startedAt: Date.now()});
  window.location.replace = () => {};
  const api = {get: async () => ({flowId: id, target: 'docker', status: 'awaiting_browser', url: 'https://login.docker.com/activate', code: 'WXYZ-1234'}), post: async () => ({})};
  const view = await mount(h(SignInProgress, {id, api}));
  await advance(3_600_000);
  assert.match(view.text(), /WXYZ-1234/);
});

for (const kind of ['inline','standalone']) {
  for (const skew of [-300_000,300_000]) test(kind+' code ignores phone clock skew '+skew+' and clears when polling '+(skew<0?'stalls':'fails'),async()=>{
    resetPage(); const serverTime=Date.UTC(2026,10,13); installClock(serverTime+skew);
    const origin=Date.now(); fakePerformanceNow(()=>Date.now()-origin);
    const flow={...device,expiresAt:serverTime+60_000,expiresInMs:60_000};
    let reads=0;
    const api={post:async()=>flow,get:()=>kind==='standalone'&&++reads===1?Promise.resolve(flow):skew>0?Promise.reject(new Error('offline')):new Promise(()=>{})};
    const original=window.open; window.open=()=>({}); window.location.replace=()=>{};
    try {
      const view=await mount(h(kind==='inline'?SignIn:SignInProgress,{api,target:'codex',agentName:'Codex',id:'skew'}));
      if(kind==='inline') await click(view.button('Sign in to Codex'));
      assert.ok(view.button('Copy code'),'valid despite skew');
      await advance(57_000);
      assert.ok(view.button('Copy code'),'still before deadline');
      await advance(1000);
      assert.ok(!view.button('Copy code'),'cleared at remaining duration minus 2s');
      assert.equal(view.$('a[href="'+device.url+'"]'),null);
      assert.match(view.text(),/code expired/);
    } finally {window.open=original;}
  });
  for (const [status,delay] of [['timed_out',2000],['complete',60_000]])
    test(kind+' server '+status+' wins '+(delay>58_000?'after':'before')+' local deadline',async()=>{
      resetPage(); installClock(); const origin=Date.now(); fakePerformanceNow(()=>Date.now()-origin);
      const flow={...device,expiresInMs:60_000};
      let resolvePoll,reads=0;
      const api={post:async()=>flow,get:()=>kind==='standalone'&&++reads===1?Promise.resolve(flow):new Promise(r=>{resolvePoll=r;})};
      const original=window.open; window.open=()=>({}); window.location.replace=()=>{};
      try {
        const view=await mount(h(kind==='inline'?SignIn:SignInProgress,{api,target:'codex',agentName:'Codex',id:'terminal'}));
        if(kind==='inline') await click(view.button('Sign in to Codex'));
        await advance(delay);
        if(status==='complete') assert.ok(!view.button('Copy code'),'local expiry already hides code');
        resolvePoll({...flow,status,code:undefined,url:undefined,reasonCode:status==='timed_out'?'codex_device_code_expired':undefined});
        await flush();
        assert.ok(!view.button('Copy code'));
        assert.match(view.text(),status==='complete'?/signed in/i:/code expired/);
      } finally {window.open=original;}
    });
}
