import './helpers/no-browser.mjs';
import test from 'node:test';
import {chmod} from 'node:fs/promises';
import {stagedExposure,approveChatgpt} from './helpers/gozar-fixture.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chatgptHosting} from '../lib/coordinator-hosting.mjs';
import {chatgptPage} from '../lib/v1/chatgpt-page.mjs';
import {startChatgptGateway} from '../lib/v1/chatgpt-mcp.mjs';
import {appFixture,api,waitFor,boundedFetch} from './helpers/v1-app-fixture.mjs';

const T=Date.parse('2026-10-20T10:00:00Z'),iso=new Date(T).toISOString();
const consent=(extra={})=>({client:'<script>x</script>',scope:'read act',redirect_uri:'http://127.0.0.1:43210/callback',redirect_host:'127.0.0.1:43210',
  registered_at:T,requested_at:T+1000,is_chatgpt:false,...extra});

test('local review makes peer-supplied hidden formatting visible',()=>{
  for(const hidden of ['\u202e',String.fromCodePoint(0xe0041),'\ufe0f',String.fromCodePoint(0xe0101),'\u200d','\u200c','\ue000','\u034f','\u3164']) {
    const html=chatgptPage({action:{id:randomUUID(),label:'Accept a job',what:'Run a job',status:'waiting',details:{prompt:'Fix it'+hidden}}});
    assert.ok(!html.includes(hidden),'no raw hidden character remains');
    assert.ok(html.includes('\\u{'+hidden.codePointAt(0).toString(16)+'}'));
    assert.match(html,/Hidden formatting characters/);
  }
});

// --- Owner page: consent ---------------------------------------------------------------
test('consent page shows callback host, registration time and a NOT ChatGPT warning for other callbacks', () => {
  const html=chatgptPage({request:'r'.repeat(43),consent:consent()});
  assert.ok(html.includes('127.0.0.1:43210'));
  assert.ok(html.includes('datetime="'+iso+'"'),'registration time is visible');
  assert.match(html,/This is not ChatGPT/i);
  assert.match(html,/supplied by the client/i);assert.match(html,/does not prove/i);
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));assert.ok(!html.includes('<script>x'));
});
test('a real ChatGPT callback gets no warning, and a read request offers no act choice', () => {
  const html=chatgptPage({request:'r'.repeat(43),consent:consent({is_chatgpt:true,redirect_host:'chatgpt.com',scope:'read'})});
  assert.doesNotMatch(html,/This is not ChatGPT/i);
  assert.ok(html.includes('name="scope" value="read"'));assert.ok(!html.includes('value="read act"'));
});
test('consent page is honest about what is read and what a write needs', () => {
  const html=chatgptPage({request:'r'.repeat(43),consent:consent()});
  for(const re of [/your name/i,/names of people in your circles/i,/prompts/i,/other people/i,/job status/i,/changes/i,/saved results/i,
    /folders you allowed/i,/transcripts/i,/only after you approve/i,/invitation previews/i,/membership checks/i,
    /computers are lending, resting or offline/i,/agents and models.*lenders offer/i])assert.match(html,re);
  assert.ok(html.includes('name="scope" value="read"')&&html.includes('Allow read-only'));
  assert.ok(html.includes('name="scope" value="read act"')&&html.includes('Allow read and request actions'));
  assert.match(html,/queued/i);assert.match(html,/Allow on this computer/i);assert.match(html,/in ChatGPT does not count/i);
  assert.match(html,/exact prompt, code and recipients/i);
  assert.ok(!html.includes('Consequential actions still require your confirmation'),'the old false claim is gone');
  assert.ok(html.includes('action="/api/chatgpt/consent"'));
});

test('connection guide lists remote circle invitation, membership, presence and composition reads',async()=>{
  const guide=await readFile(new URL('../docs/connect-chatgpt.md',import.meta.url),'utf8');
  for(const re of [/invitation previews/i,/membership checks/i,/computers are lending, resting or offline/i,/agents and models/i])
    assert.match(guide,re);
});

// --- Owner page: overview ---------------------------------------------------------------
test('overview lists connections with callback host, registration time and an individual revoke', () => {
  const html=chatgptPage({status:{url:'https://x.example/mcp',connected:true,connections:[
    {id:'g1_A',client:'<b>ChatGPT</b>',scope:'read',redirect_host:'chatgpt.com',is_chatgpt:true,registered_at:T,created_at:T},
    {id:'g2_B',client:'Other',scope:'read act',redirect_host:'127.0.0.1:9',is_chatgpt:false,registered_at:T,created_at:T}],audit:[]}});
  assert.ok(html.includes('chatgpt.com')&&html.includes('127.0.0.1:9'));
  assert.ok(html.includes('datetime="'+iso+'"'));
  assert.ok(html.includes('action="/api/chatgpt/connections/g1_A/revoke"'));
  assert.ok(html.includes('action="/api/chatgpt/connections/g2_B/revoke"'));
  assert.ok(html.includes('&lt;b&gt;ChatGPT'));assert.match(html,/not ChatGPT/i);
});
test('overview has a Connect button, pending requests and actions with local Review links, and no auto-redirect', () => {
  const id=randomUUID();
  const html=chatgptPage({status:{connected:false,connections:[],audit:[]},requests:[{id:'req_1',...consent()}],
    actions:[{id,label:'turn <lending> on',what:'<img src=x>',expiresAt:T}]});
  assert.match(html,/<form method="post" action="\/api\/chatgpt\/start">/);
  assert.ok(html.includes('href="/connect/chatgpt?request=req_1"'));
  assert.ok(html.includes('href="/connect/chatgpt?action='+id+'"'));
  assert.ok(html.includes('turn &lt;lending&gt; on')&&!html.includes('<img src=x>'));
  assert.doesNotMatch(html,/http-equiv="refresh"[^>]*url=/i);
});
test('activity is grouped per client with a local clear button', () => {
  const html=chatgptPage({status:{connected:true,connections:[],audit:[
    {at:T,client_id:'c1',client:'ChatGPT',op:'lending.on',outcome:'completed',effect:'<i>Turn on</i>'},
    {at:T,client_id:'c2',client:'Other',op:'status.get',outcome:'completed'}]}});
  assert.ok(html.includes('action="/api/chatgpt/audit/clear"'));
  assert.ok(html.includes('name="client" value="c1"')&&html.includes('name="client" value="c2"'));
  assert.ok(html.includes('&lt;i&gt;Turn on'));
});

// --- Owner page: one remote action ------------------------------------------------------
test('action page shows the exact effect and escaped details, with Allow and Decline', () => {
  const id=randomUUID();
  const html=chatgptPage({action:{id,label:'send a <job>',what:'Send "fix" to Friends',details:{prompt:'<script>alert(1)</script>',recipients:['Ana']},status:'waiting',expiresAt:T}});
  assert.ok(html.includes('Allow ChatGPT to send a &lt;job&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')&&!html.includes('<script>alert'));
  assert.ok(html.includes('Ana'));
  assert.ok(html.includes('action="/api/chatgpt/actions/'+id+'/approve"'));
  assert.ok(html.includes('action="/api/chatgpt/actions/'+id+'/decline"'));
});
test('action page shows each source file on its own, escaped, with hidden-character and omitted notes', () => {
  const id=randomUUID();
  const html=chatgptPage({action:{id,label:'send a job',what:'Send',status:'waiting',details:{code:{type:'files',repo:{original_path:'/home/a/<app>'},
    files:[{path:'a<b>.js',text:'let x="</pre><script>";',sha256:'ab12',bytes:22,hidden_characters:true,text_omitted:false},
      {path:'img.png',sha256:'cd34',bytes:9000,hidden_characters:false,text_omitted:true}]}}}});
  assert.ok(html.includes('/home/a/&lt;app&gt;'));
  assert.ok(html.includes('<code>a&lt;b&gt;.js</code>')&&html.includes('&lt;/pre&gt;&lt;script&gt;'));
  assert.ok(!html.includes('</pre><script>'));
  assert.match(html,/hidden or invisible characters/);assert.match(html,/Text not shown/);
  assert.ok(html.includes('ab12')&&html.includes('cd34'));
  assert.ok(html.includes('/approve"'),'waiting actions can be allowed');
});
test('consent title names ChatGPT only for a real ChatGPT callback; no enrollment disclosure', () => {
  assert.ok(chatgptPage({request:'r'.repeat(43),consent:consent({is_chatgpt:true,redirect_host:'chatgpt.com'})}).includes('<h1>Allow ChatGPT to use Faravan on this computer?</h1>'));
  const other=chatgptPage({request:'r'.repeat(43),consent:consent()});
  assert.ok(!other.includes('<h1>Allow ChatGPT to use Faravan'));assert.doesNotMatch(other,/asking to join/);
});
test('a finished action shows its local result once, escaped, with no buttons', () => {
  const id=randomUUID();
  const html=chatgptPage({action:{id,label:'create an invitation',what:'Invite',details:{},status:'completed',localResult:{invite:'https://h/join#S3CRET<x>'}}});
  assert.ok(html.includes('S3CRET&lt;x&gt;'));assert.match(html,/only on this computer/i);
  assert.ok(!html.includes('/approve"')&&!html.includes('/decline"'));
});

// --- Real app routes ---------------------------------------------------------------------
function fakeApprovals() {
  const items=new Map(),decided=[];
  return {items,decided,add:a=>items.set(a.id,{status:'waiting',details:{},...a}),
    pending:()=>[...items.values()].filter(a=>a.status==='waiting').map(({id,label,what,expiresAt})=>({id,label,what,expiresAt})),
    localGet:id=>items.get(id)??null,
    decide:async(id,allow)=>{const a=items.get(id);if(!a)return null;decided.push([id,allow]);a.status=allow?'completed':'declined';
      if(allow)a.localResult={invite:'https://h/join#SECRET'};return a;},
    close(){}};
}
async function connected(t,name='page') {
  const fixture=await stagedExposure(t,{kind:'durable'}),f=await appFixture(t),approvals=fakeApprovals();
  await chmod(await f.home(name),0o700);
  const chatgptStartGateway=async o=>{const g=await startChatgptGateway(o);Object.defineProperty(g,'approvals',{value:approvals,configurable:true});return g;};
  const {app,home}=await f.start(name,{chatgptStartGateway,chatgptGozar:fixture.gozar});
  await approveChatgpt(app,home,fixture);
  return {f,app,approvals};
}
async function cookieFor(app,query='') {
  const {url}=await api(app,'/api/handoff',{method:'POST',body:{}});
  const r=await boundedFetch(url+query,{redirect:'manual'});
  return {cookie:r.headers.get('set-cookie').split(';')[0],location:r.headers.get('location'),status:r.status};
}
const post=(app,path,{headers={},form,json}={})=>boundedFetch(app.origin+path,{method:'POST',redirect:'manual',
  headers:{...(form?{'content-type':'application/x-www-form-urlencoded'}:json?{'content-type':'application/json'}:{}),...headers},
  ...(form?{body:new URLSearchParams(form)}:json?{body:JSON.stringify(json)}:{})});

test('app: pending actions list, status count and attention are owner-only', {timeout:120000},async t=>{
  const {app,approvals}=await connected(t,'list'),id=randomUUID();
  approvals.add({id,label:'turn lending on',what:'Lend to Friends',expiresAt:T});
  assert.deepEqual(await api(app,'/api/chatgpt/actions'),[{id,label:'turn lending on',what:'Lend to Friends',expiresAt:T}]);
  await api(app,'/api/chatgpt/actions',{token:null,status:401});
  const status=await api(app,'/api/status');
  assert.equal(status.chatgpt_pending,1);
  assert.ok(status.attention.some(a=>a.chatgptAction===id));
  assert.ok(status.needs_you.some(n=>n.kind==='chatgpt_action'&&n.id===id));
  assert.equal(status.iconState,'Needs attention');
});
test('app: approve needs the Strict browser session and a same-origin Origin; the token alone cannot approve', {timeout:120000},async t=>{
  const {app,approvals}=await connected(t,'approve'),id=randomUUID();approvals.add({id,label:'turn lending on',what:'Lend'});
  const token={'x-faravan-session-token':app.token};
  assert.equal((await post(app,'/api/chatgpt/actions/'+id+'/approve',{headers:{...token,origin:app.origin}})).status,403);
  const {cookie}=await cookieFor(app);
  assert.equal((await post(app,'/api/chatgpt/actions/'+id+'/approve',{headers:{cookie,origin:'https://evil.example'},form:{}})).status,403);
  assert.equal((await post(app,'/api/chatgpt/actions/'+id+'/approve',{headers:{cookie},form:{}})).status,403,'Origin is required');
  assert.deepEqual(approvals.decided,[]);
  const ok=await post(app,'/api/chatgpt/actions/'+id+'/approve',{headers:{cookie,origin:app.origin},form:{}});
  assert.equal(ok.status,303);assert.equal(ok.headers.get('location'),'/connect/chatgpt?action='+id);
  assert.deepEqual(approvals.decided,[[id,true]]);
  const page=await boundedFetch(app.origin+'/connect/chatgpt?action='+id,{headers:{cookie}}).then(r=>r.text());
  assert.ok(page.includes('https://h/join#SECRET'),'the raw secret is shown in the local result');
  assert.equal((await post(app,'/api/chatgpt/actions/not-a-uuid/approve',{headers:{cookie,origin:app.origin},form:{}})).status,404);
  assert.equal((await post(app,'/api/chatgpt/actions/'+randomUUID()+'/approve',{headers:{cookie,origin:app.origin},form:{}})).status,404);
});
test('app: decline accepts a bodyless tray POST and an HTML form', {timeout:120000},async t=>{
  const {app,approvals}=await connected(t,'decline'),a=randomUUID(),b=randomUUID();
  approvals.add({id:a,label:'x',what:'x'});approvals.add({id:b,label:'y',what:'y'});
  const tray=await post(app,'/api/chatgpt/actions/'+a+'/decline',{headers:{'x-faravan-session-token':app.token}});
  assert.equal(tray.status,200);assert.equal((await tray.json()).status,'declined');
  const {cookie}=await cookieFor(app);
  const form=await post(app,'/api/chatgpt/actions/'+b+'/decline',{headers:{cookie,origin:app.origin},form:{}});
  assert.equal(form.status,303);assert.equal(form.headers.get('location'),'/connect/chatgpt?action='+b);
  assert.deepEqual(approvals.decided,[[a,false],[b,false]]);
  assert.equal((await post(app,'/api/chatgpt/actions/'+b+'/decline',{})).status,401);
});
test('app: the action page is local, escaped and form-action self only', {timeout:120000},async t=>{
  const {app,approvals}=await connected(t,'page'),id=randomUUID();
  approvals.add({id,label:'send a job',what:'<b>w</b>',details:{prompt:'<script>alert(1)</script>'}});
  const {cookie}=await cookieFor(app);
  const r=await boundedFetch(app.origin+'/connect/chatgpt?action='+id,{headers:{cookie}}),html=await r.text();
  assert.equal(r.status,200);
  assert.ok(html.includes('&lt;script&gt;alert(1)')&&!html.includes('<script>alert'));
  const csp=r.headers.get('content-security-policy');
  assert.match(csp,/form-action 'self';/);assert.match(csp,/frame-ancestors 'none'/);
  assert.equal((await boundedFetch(app.origin+'/connect/chatgpt?action=nope',{headers:{cookie}})).status,400);
  assert.equal((await boundedFetch(app.origin+'/connect/chatgpt?action='+randomUUID(),{headers:{cookie}})).status,404);
  // Unauthenticated: a bridge that keeps only a valid action id, and grants nothing.
  const bridge=await boundedFetch(app.origin+'/connect/chatgpt?action='+id).then(r=>r.text());
  assert.ok(bridge.includes('action='+id));assert.ok(!bridge.includes('<b>w'));
  const bad=await boundedFetch(app.origin+'/connect/chatgpt?action=javascript:alert(1)').then(r=>r.text());
  assert.ok(!bad.includes('javascript'));
  assert.equal((await boundedFetch(app.origin+'/connect/chatgpt?action='+id+'&local=1')).status,401);
});
test('app: handoff accepts only a valid chatgpt_action UUID and no arbitrary next', {timeout:120000},async t=>{
  const {app}=await connected(t,'handoff'),id=randomUUID();
  const good=await cookieFor(app,'&chatgpt_action='+id);
  assert.equal(good.status,302);assert.equal(good.location,'/connect/chatgpt?action='+id);assert.match(good.cookie,/^faravan_local_session_/);
  for(const q of ['&next=https://evil.example','&chatgpt_action=https://evil.example','&chatgpt_action=../api','&chatgpt_action='+id+'&chatgpt_action='+randomUUID()])
    assert.equal((await cookieFor(app,q)).location,'/',q);
});
test('app: explicit start opens pairing, also when already running; automatic resume does not', {timeout:120000},async t=>{
  const fixture=await stagedExposure(t,{kind:'durable'}),f=await appFixture(t);
  await chmod(await f.home('pair'),0o700);
  const first=await f.start('pair',{chatgptGozar:fixture.gozar});
  const started=await approveChatgpt(first.app,first.home,fixture);
  assert.match(started.url,/\/mcp$/);
  assert.ok(Number.isFinite((await api(first.app,'/api/chatgpt/status')).pairing_until));
  const exposure=chatgptHosting(join(first.home,'v1'),fixture.gozar);
  const owned=exposure.read();
  await first.app.close();
  const suspended=await exposure.status();
  assert.equal(suspended?.state,'suspended');
  assert.equal(suspended.published,null);
  assert.equal(suspended.operationId,owned.routeOperationId);
  assert.deepEqual(suspended.handle,owned.handle);
  const resumed=await f.start('pair',{chatgptGozar:fixture.gozar});
  await waitFor(async()=>(await api(resumed.app,'/api/chatgpt/status')).url===started.url,'automatic resume');
  assert.equal(exposure.read().routeOperationId,owned.routeOperationId);
  assert.equal((await api(resumed.app,'/api/chatgpt/status')).pairing_until,null,'a restart never opens pairing');
  await api(resumed.app,'/api/chatgpt/start',{method:'POST',body:{}});
  assert.ok(Number.isFinite((await api(resumed.app,'/api/chatgpt/status')).pairing_until),'Connect on a running gateway opens pairing');
  // The page's Connect button posts a form and lands back on the page.
  const {cookie}=await cookieFor(resumed.app);
  const form=await post(resumed.app,'/api/chatgpt/start',{headers:{cookie,origin:resumed.app.origin},form:{}});
  assert.equal(form.status,303);assert.equal(form.headers.get('location'),'/connect/chatgpt');
  const disconnected=await api(resumed.app,'/api/chatgpt/disconnect',{method:'POST',body:{}});
  assert.equal(disconnected.connected,false);
  assert.equal(disconnected.cleanup?.state,'confirmed');
  assert.equal(exposure.read(),null);
});
test('app: per-connection revoke and local-only activity clear', {timeout:120000},async t=>{
  const {app}=await connected(t,'revoke');
  assert.equal((await post(app,'/api/chatgpt/connections/missing/revoke',{headers:{'x-faravan-session-token':app.token}})).status,404);
  assert.equal((await post(app,'/api/chatgpt/audit/clear',{headers:{'x-faravan-session-token':app.token,origin:app.origin}})).status,403,'clearing needs the browser session');
  const {cookie}=await cookieFor(app);
  const cleared=await post(app,'/api/chatgpt/audit/clear',{headers:{cookie,origin:app.origin},form:{}});
  assert.equal(cleared.status,303);assert.equal(cleared.headers.get('location'),'/connect/chatgpt');
});
