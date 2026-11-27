import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createChatgptOAuth} from '../lib/v1/chatgpt-oauth.mjs';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {approveChatgpt,shortGozarAppHome,stagedExposure} from './helpers/gozar-fixture.mjs';
// Surface a missing gateway dependency before waiting for a tunnel callback
// that cannot be reached when the app's dynamic gateway import fails.
test.before(async () => { await import('../lib/v1/chatgpt-mcp.mjs'); });
const redirect='http://127.0.0.1:43210/callback';
const data=value=>value.structuredContent??JSON.parse(value.content[0].text.split('---\n')[1].split('\n---')[0]);
const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
const authParams=(client,issuer)=>new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'read act',state:'test-state',resource:issuer+'/mcp',code_challenge:challenge,code_challenge_method:'S256'});
const tokenParams=(client,code,issuer)=>({client_id:client.client_id,grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier,resource:issuer+'/mcp'});
async function post(origin,path,value,{form=false,headers={}}={}) {
 return fetch(origin+path,{method:'POST',headers:{'content-type':form?'application/x-www-form-urlencoded':'application/json',...headers},body:form?new URLSearchParams(value):JSON.stringify(value),redirect:'manual'});
}
const rpc=(origin,token,method,params={})=>post(origin,'/mcp',{jsonrpc:'2.0',id:1,method,params},{headers:{authorization:'Bearer '+token,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}});
test('concurrent connect requests describe one dedicated local gateway and do not allocate', {timeout:30000},async t=>{
  const f=await appFixture(t),fixture=await stagedExposure(t);
  const {app}=await f.start('g',{chatgptGozar:fixture.gozar});
  const start=()=>api(app,'/api/chatgpt/start',{method:'POST',body:{}});
  const [first,second]=await Promise.all([start(),start()]);
  assert.deepEqual(first,second);
  assert.equal(first.status,'approval_required');
  assert.equal(fixture.opened.size,0);
});
test('legacy route, owner credentials and exact address remain on disk through failed review', {timeout:30000},async t=>{
  const f=await appFixture(t),fixture=await stagedExposure(t);
  const {app,home}=await f.start('g',{chatgptGozar:fixture.gozar});
  const file=join(home,'v1/chatgpt-connect.json'),tokenPath=join(home,'private-token');
  const secret='private-token-canary';
  await writeFile(tokenPath,secret);
  const previous={enabled:false,url:'https://saved.invalid',port:1111,rule:{target:'127.0.0.1:1111',owned:true},tokenPath};
  await writeFile(file,JSON.stringify(previous));
  const refusal=await api(app,'/api/chatgpt/start',{method:'POST',body:{},status:409});
  assert.equal(refusal.code,'legacy_exposure_pending');
  assert.ok(!JSON.stringify(refusal).includes(secret));
  assert.deepEqual(JSON.parse(await readFile(file)),previous);
  assert.equal(await readFile(tokenPath,'utf8'),secret);
  assert.equal(fixture.opened.size,0);
});
test('real app: authenticated local consent, escaped client, callback and disconnect; session never crosses gateway', {timeout:120000},async t=>{
  const f=await appFixture(t),fixture=await stagedExposure(t);
  await shortGozarAppHome(t,f,'g');
  const {app,home}=await f.start('g',{chatgptGozar:fixture.gozar});
  const start=await approveChatgpt(app,home,fixture),issuer=new URL(start.url).origin;
  assert.equal(start.url,issuer+'/mcp');
  const [owned]=fixture.opened.values();
  const publicOrigin='http://127.0.0.1:'+owned.server.address().port;
  const client=await post(publicOrigin,'/oauth/register',{redirect_uris:[redirect],client_name:'<script>evil</script>',token_endpoint_auth_method:'none'}).then(r=>r.json());
  const html=await fetch(publicOrigin+'/oauth/authorize?'+authParams(client,issuer)).then(r=>r.text()),id=html.match(/request=([A-Za-z0-9_-]+)/)[1];
  const page=await fetch(app.origin+'/connect/chatgpt?request='+id,{headers:{'x-faravan-session-token':app.token}}).then(r=>r.text());assert.ok(page.includes('&lt;script&gt;'));assert.ok(!page.includes('<script>evil'));
  assert.equal((await fetch(app.origin+'/connect/chatgpt?request='+id)).status,200,'unauthenticated navigation gets only a static same-site bridge');
  assert.equal((await fetch(app.origin+'/connect/chatgpt?request='+id+'&local=1')).status,401);
  const consent=await post(app.origin,'/api/chatgpt/consent',{request:id,allow:'yes'},{form:true,headers:{'x-faravan-session-token':app.token,origin:app.origin}});assert.equal(consent.status,303);
  const callback=new URL(consent.headers.get('location'));
  const tokens=await post(publicOrigin,'/oauth/token',tokenParams(client,callback.searchParams.get('code'),issuer),{form:true}).then(r=>r.json());
  const blockers=await rpc(publicOrigin,tokens.access_token,'tools/call',{name:'status_blockers',arguments:{}}).then(r=>r.json());assert.ok(Array.isArray(data(blockers.result).blockers));
  assert.ok(!html.includes(app.origin),'public authorization never reveals the local app port');
  const remoteTool=async(name,args={})=>data((await rpc(publicOrigin,tokens.access_token,'tools/call',{name,arguments:args}).then(r=>r.json())).result);
  const {url:handoff}=await api(app,'/api/handoff',{method:'POST',body:{}});
  const session=await fetch(handoff,{redirect:'manual'}),cookie=session.headers.get('set-cookie').split(';')[0];
  const localApprove=async action=>{
    const page=await fetch(action.approve_at,{headers:{cookie}}).then(r=>r.text());
    assert.match(page,/Allow ChatGPT to/);assert.match(page,/\/approve/);
    const allowed=await post(app.origin,'/api/chatgpt/actions/'+action.approval_id+'/approve',{},
      {form:true,headers:{cookie,origin:app.origin}});assert.equal(allowed.status,303);
    return remoteTool('approvals_wait',{approval_id:action.approval_id,timeout_seconds:1});
  };
  const caps=await remoteTool('limits_set',{dailyJobs:20,confirm:true});assert.equal(caps.status,'needs_your_ok');
  assert.equal((await api(app,'/api/lending')).limits.dailyJobs,null);
  assert.equal((await post(app.origin,'/api/chatgpt/actions/'+caps.approval_id+'/approve',{},
    {headers:{'x-faravan-session-token':app.token,origin:app.origin}})).status,403,'a token is not a local browser decision');
  await localApprove(caps);assert.equal((await api(app,'/api/lending')).limits.dailyJobs,20);
  await f.provisionFromHome('g');
  const circle=await api(app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}});
  const inviteRequest=await remoteTool('circles_invite',{circle:circle.id});assert.equal(inviteRequest.status,'needs_your_ok');
  const inviteResult=await localApprove(inviteRequest);assert.equal(inviteResult.view_locally,true);
  assert.equal(inviteResult.invite,undefined);
  const privatePage=await fetch(inviteRequest.approve_at,{headers:{cookie}}).then(r=>r.text());assert.match(privatePage,/only on this computer/);
  const send=await remoteTool('jobs_submit',{circle:circle.id,prompt:'Review this exact code',harness:'codex',
    files:[{path:'README.md',base64:Buffer.from('Exact code before local approval').toString('base64')}]});
  assert.equal(send.status,'needs_your_ok');assert.equal(f.jobs.size,0);
  const preview=await fetch(send.approve_at,{headers:{cookie}}).then(r=>r.text());
  assert.match(preview,/Exact code before local approval/);assert.match(preview,/Review this exact code/);assert.match(preview,/Friends/);
  const submitted=await localApprove(send);assert.ok(submitted.jobDigest);assert.equal(f.jobs.size,1);
  const declined=await remoteTool('lending_off');assert.equal(declined.status,'needs_your_ok');
  await api(app,'/api/chatgpt/actions/'+declined.approval_id+'/decline',{method:'POST',body:{}});
  assert.equal((await remoteTool('approvals_wait',{approval_id:declined.approval_id,timeout_seconds:0})).status,'declined');
  const audit=await api(app,'/api/chatgpt/status');assert.ok(audit.audit.some(e=>e.op==='status.blockers'&&e.outcome==='completed'));
  fixture.failClose(true);
  const stopped=await api(app,'/api/chatgpt/disconnect',{method:'POST',body:{}});
  assert.equal(stopped.cleanup.state,'unconfirmed');
  assert.equal((await fetch(publicOrigin+'/mcp')).status,502,'the closed gateway no longer answers through a retained route');
  fixture.failClose(false);
  assert.equal((await api(app,'/api/chatgpt/disconnect',{method:'POST',body:{}})).cleanup.state,'confirmed');
  const stored=createChatgptOAuth({home,origin:issuer,localOrigin:()=>app.origin});
  assert.equal(stored.status().connected,false);
  assert.equal(stored.authenticate('Bearer '+tokens.access_token),null);
});
