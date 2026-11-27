import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {startChatgptGateway,createRemoteCalls} from '../lib/v1/chatgpt-mcp.mjs';
import {createChatgptOAuth} from '../lib/v1/chatgpt-oauth.mjs';

const issuer='https://faravan.example',redirect='http://127.0.0.1:43210/callback';
const data=value=>value.structuredContent??JSON.parse(value.content[0].text.split('---\n')[1].split('\n---')[0]);
const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
const authParams=client=>new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'read act',state:'test-state',resource:issuer+'/mcp',code_challenge:challenge,code_challenge_method:'S256'});
const tokenParams=(client,code)=>({client_id:client.client_id,grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier,resource:issuer+'/mcp'});
async function temporary(t){const home=await mkdtemp(join(tmpdir(),'faravan-oauth-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
function grant(oauth,scope='read act') {
  oauth.openPairing();
  const client=oauth.register({redirect_uris:[redirect],token_endpoint_auth_method:'none'});
  const params=authParams(client);params.set('scope',scope);
  const request=oauth.authorize(params), callback=new URL(oauth.approve(request.id,true));
  const tokens=oauth.token(tokenParams(client,callback.searchParams.get('code')));
  return {client,tokens,grant:oauth.authenticate('Bearer '+tokens.access_token)};
}
async function post(origin,path,value,{form=false,headers={}}={}) {
  return fetch(origin+path,{method:'POST',headers:{'content-type':form?'application/x-www-form-urlencoded':'application/json',...headers},body:form?new URLSearchParams(value):JSON.stringify(value),redirect:'manual'});
}
const rpc=(origin,token,method,params={})=>post(origin,'/mcp',{jsonrpc:'2.0',id:1,method,params},{headers:{authorization:'Bearer '+token,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}});

test('OAuth: consent, strict PKCE/audience/redirect, single-use code, refresh rotation, persistence, revoke and expiry',async t=>{
  const home=await temporary(t);let now=100000;
  const make=()=>createChatgptOAuth({home,origin:issuer,localOrigin:()=> 'http://127.0.0.1:1234',now:()=>now,accessLifetimeMs:1000});
  const oauth=make();oauth.openPairing();const client=oauth.register({redirect_uris:[redirect],client_name:'<unverified>',token_endpoint_auth_method:'none'});
  for(const uri of ['https://evil.test/#fragment','javascript:alert(1)','http://evil.test/callback','https://evil.test/callback','https://chatgpt.com.evil.test/connector_platform_oauth_redirect'])assert.throws(()=>oauth.register({redirect_uris:[uri]}));
  const params=authParams(client);
  for(const [k,v] of [['resource','https://evil.test/mcp'],['redirect_uri',redirect+'evil'],['code_challenge_method','plain'],['scope','admin']]) {
    const bad=new URLSearchParams(params);bad.set(k,v);assert.throws(()=>oauth.authorize(bad),k);
  }
  const req=oauth.authorize(params);assert.equal(oauth.status().connected,false);
  assert.throws(()=>oauth.token(tokenParams(client,'unapproved')));
  const callback=new URL(oauth.approve(req.id,true)),code=callback.searchParams.get('code');
  assert.equal(callback.searchParams.get('iss'),issuer);assert.equal(callback.searchParams.get('state'),'test-state');
  assert.throws(()=>oauth.approve(req.id,true));
  const first=oauth.token(tokenParams(client,code));assert.throws(()=>oauth.token(tokenParams(client,code)));
  assert.equal(oauth.authenticate('Bearer '+first.access_token),null,'a proven code replay revokes what the code issued');
  oauth.openPairing();
  const tokens=oauth.token(tokenParams(client,new URL(oauth.approve(oauth.authorize(params).id,true)).searchParams.get('code')));
  oauth.openPairing();
  const otherClient=oauth.register({redirect_uris:[redirect]});
  for(const [field,value] of [['code_verifier','x'.repeat(64)],['redirect_uri',redirect+'-other'],['client_id',otherClient.client_id]]) {
    oauth.openPairing();
    const request=oauth.authorize(params),nextCode=new URL(oauth.approve(request.id,true)).searchParams.get('code');
    assert.throws(()=>oauth.token({...tokenParams(client,nextCode),[field]:value}),field);
    assert.throws(()=>oauth.token(tokenParams(client,nextCode)),'a failed exchange cannot replay its code');
  }
  oauth.openPairing();
  const resourceRequest=oauth.authorize(params),resourceCode=new URL(oauth.approve(resourceRequest.id,true)).searchParams.get('code');
  assert.throws(()=>oauth.token({...tokenParams(client,resourceCode),resource:'https://other.example/mcp'}));
  assert.equal(make().authenticate('Bearer '+tokens.access_token).client_id,client.client_id);
  const disk=await readFile(join(home,'v1/chatgpt-oauth.json'),'utf8');assert.ok(!disk.includes(tokens.access_token));assert.ok(!disk.includes(tokens.refresh_token));
  assert.equal((await stat(join(home,'v1/chatgpt-oauth.json'))).mode&0o777,0o600);
  const fresh=oauth.token({client_id:client.client_id,grant_type:'refresh_token',refresh_token:tokens.refresh_token,resource:issuer+'/mcp'});
  assert.throws(()=>oauth.token({client_id:client.client_id,grant_type:'refresh_token',refresh_token:fresh.refresh_token,resource:'https://other.example/mcp'}));
  assert.ok(oauth.authenticate('Bearer '+fresh.access_token));
  assert.throws(()=>oauth.token({client_id:client.client_id,grant_type:'refresh_token',refresh_token:tokens.refresh_token,resource:issuer+'/mcp'}));
  assert.equal(oauth.authenticate('Bearer '+fresh.access_token),null,'refresh replay revokes family');
  const again=grant(oauth);now+=1001;assert.equal(oauth.authenticate('Bearer '+again.tokens.access_token),null);
  const refreshed=oauth.token({client_id:again.client.client_id,grant_type:'refresh_token',refresh_token:again.tokens.refresh_token});
  oauth.revoke({client_id:again.client.client_id,token:refreshed.refresh_token});assert.equal(oauth.authenticate('Bearer '+refreshed.access_token),null);
  oauth.openPairing();
  const denied=oauth.authorize(authParams(client));assert.equal(new URL(oauth.approve(denied.id,false)).searchParams.get('error'),'access_denied');
});

test('HTTP OAuth journey: DCR, owner consent, token, MCP status.blockers, refresh, revoke; local routes never public',async t=>{
  const home=await temporary(t),seen=[];
  // Frozen clock: 241 requests must not straddle a real minute boundary and reset the rate window.
  const frozen=Date.now();
  const gateway=await startChatgptGateway({home,origin:issuer,now:()=>frozen,localOrigin:()=> 'http://127.0.0.1:1234',ops:{call:async(id,input,options)=>{seen.push({id,input,options});return {blockers:[],next:[]};}}});
  t.after(()=>gateway.close());gateway.oauth.openPairing();const origin='http://127.0.0.1:'+gateway.port;
  const discovery=await fetch(origin+'/.well-known/oauth-protected-resource/mcp').then(r=>r.json());assert.equal(discovery.resource,issuer+'/mcp');
  const metadata=await fetch(origin+'/.well-known/oauth-authorization-server').then(r=>r.json());assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
  const missing=await rpc(origin,'invalid','tools/list');assert.equal(missing.status,401);assert.match(missing.headers.get('www-authenticate'),/resource_metadata/);
  const registration=await post(origin,'/oauth/register',{redirect_uris:[redirect],token_endpoint_auth_method:'none'});assert.equal(registration.status,201);const client=await registration.json();
  const authorize=await fetch(origin+'/oauth/authorize?'+authParams(client));assert.equal(authorize.status,200);
  const html=await authorize.text(),id=html.match(/request=([A-Za-z0-9_-]+)/)[1];
  assert.equal((await post(origin,'/api/chatgpt/consent',{request:id,allow:'yes'})).status,404);
  const callback=new URL(gateway.oauth.approve(id,true));
  const tokens=await post(origin,'/oauth/token',tokenParams(client,callback.searchParams.get('code')),{form:true}).then(r=>r.json());assert.ok(tokens.access_token);
  const init=await rpc(origin,tokens.access_token,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.status,200);
  const listed=await rpc(origin,tokens.access_token,'tools/list').then(r=>r.json());assert.ok(listed.result.tools.some(x=>x.name==='status_blockers'));
  assert.ok(!listed.result.tools.some(x=>['uninstall_run','app_open_link'].includes(x.name)));
  const value=await rpc(origin,tokens.access_token,'tools/call',{name:'status_blockers',arguments:{}}).then(r=>r.json());assert.deepEqual(data(value.result).blockers,[]);assert.equal(seen[0].id,'status.blockers');
  const refusal=await rpc(origin,tokens.access_token,'tools/call',{name:'lending_off',arguments:{}}).then(r=>r.json());assert.equal(data(refusal.result).status,'needs_your_ok');assert.equal(seen.length,1);
  for(let i=0;i<61;i++)await post(origin,'/oauth/token',{client_id:'unapproved',grant_type:'refresh_token',refresh_token:'invalid'},{form:true});
  for(let i=0;i<61;i++)await post(origin,'/oauth/token',{client_id:client.client_id,grant_type:'refresh_token',refresh_token:'invalid'},{form:true});
  const fresh=await post(origin,'/oauth/token',{client_id:client.client_id,grant_type:'refresh_token',refresh_token:tokens.refresh_token,resource:issuer+'/mcp'},{form:true}).then(r=>r.json());
  assert.ok(fresh.access_token,'junk requests cannot consume an approved client refresh budget');
  assert.equal((await rpc(origin,fresh.access_token,'tools/list')).status,200);
  for(let i=0;i<241;i++)await fetch(origin+'/.well-known/oauth-protected-resource/mcp');
  assert.equal((await fetch(origin+'/.well-known/oauth-protected-resource/mcp')).status,429);
  assert.equal((await rpc(origin,fresh.access_token,'tools/list')).status,200,'anonymous discovery traffic cannot exhaust authenticated MCP budget');
  await post(origin,'/oauth/revoke',{client_id:client.client_id,token:fresh.refresh_token},{form:true});assert.equal((await rpc(origin,fresh.access_token,'tools/list')).status,401);
  for(const path of ['/','/api/status','/api/handoff','/auth/handoff','/api/ops/status.get','/api/chatgpt/start','/oauth/authorize/../token','/mcp?token=anything'])assert.equal((await fetch(origin+path)).status,404,path);
  assert.equal((await fetch(origin+'/mcp',{headers:{origin:'https://evil.test'}})).status,403);
});

test('unapproved registrations stay bounded without expiring active consent or approved clients',async t=>{
  const home=await temporary(t);let now=1000000;
  const oauth=createChatgptOAuth({home,origin:issuer,localOrigin:()=> 'http://127.0.0.1:1',now:()=>now});
  const approved=grant(oauth);
  oauth.openPairing();
  for(let i=0;i<99;i++)oauth.register({redirect_uris:[redirect]});
  assert.ok(oauth.register({redirect_uris:[redirect]}).client_id,'evict an unapproved registration instead of permanently locking out DCR');
  now+=300001;oauth.openPairing();
  assert.ok(oauth.register({redirect_uris:[redirect]}).client_id);
  assert.ok(oauth.authorize(authParams(approved.client)).id,'approved client survives unapproved client expiry');
  const other=oauth.register({redirect_uris:[redirect]});
  for(let i=0;i<3;i++)oauth.authorize(authParams(other));
  assert.throws(()=>oauth.authorize(authParams(other)));
  assert.ok(oauth.authorize(authParams(approved.client)).id,'one client cannot fill another client pending authorization budget');
  const delayed=oauth.register({redirect_uris:[redirect]});now+=200000;
  const request=oauth.authorize(authParams(delayed));now+=150000;
  assert.ok(oauth.consent(request.id),'a later authorization keeps its complete five-minute consent window');
  oauth.approve(request.id,true);
});

test('remote policy: read scope, human rejection, local root guard, bounded wait, pending calls and disconnect',async t=>{
  const home=await temporary(t),oauth=createChatgptOAuth({home,origin:issuer,localOrigin:()=> 'http://127.0.0.1:1'});
  const full=grant(oauth),read=grant(oauth,'read'),seen=[];let finish;
  const remote=createRemoteCalls({oauth,waitMs:5,ops:{call:async(id,input)=>{seen.push({id,input});if(id==='jobs.wait')await new Promise(r=>finish=r);return {ok:true};}}});
  t.after(()=>remote.close());
  assert.ok(remote.tools(read.grant).every(x=>x.annotations.readOnlyHint));
  assert.equal(data(await remote.call(read.grant,'lending_off',{})).code,'insufficient_scope');
  for(const name of ['uninstall_run','app_open_link','signin_start','events_list'])assert.equal(data(await remote.call(full.grant,name,{})).code,'unknown_operation');
  assert.equal((await remote.call(full.grant,'repo_inspect',{path:home})).isError,true);
  const pending=await remote.call(full.grant,'jobs_wait',{digest:'a'.repeat(64),timeout_seconds:30});
  assert.equal(seen.at(-1).input.timeout_seconds,10);assert.equal(data(pending).pending,true);
  assert.equal((await remote.call(read.grant,'remote_call_get',{call_id:data(pending).call_id})).isError,true);
  finish();await new Promise(r=>setImmediate(r));assert.equal(data(await remote.call(full.grant,'remote_call_get',{call_id:data(pending).call_id})).ok,true);
  oauth.disconnect();assert.equal((await remote.call(full.grant,'status_blockers',{})).isError,true);
});

test('remote invitation and circle reads use read scope without local approval and hide resolved links',async t=>{
  const home=await temporary(t),oauth=createChatgptOAuth({home,origin:issuer,localOrigin:()=> 'http://127.0.0.1:1'});
  const read=grant(oauth,'read'),seen=[],invite='faravan://join#invite='+'S'.repeat(80);
  const remote=createRemoteCalls({oauth,ops:{call:async(id,input,options)=>{
    seen.push({id,input,options});
    if(id==='circles.preview_join')return {name:'Friends',origin:'https://friends.example',ownerName:'Ana',members:[],membersComplete:true,resolvedLink:invite};
    if(id==='circles.check')return {state:'approved'};
    if(id==='circles.presence')return {lenders:[]};
    throw new Error('unexpected operation '+id);
  }}});
  t.after(()=>remote.close());
  const expected=['circles_check','circles_presence','circles_preview_join'];
  const tools=remote.tools(read.grant);
  for(const name of expected){
    const tool=tools.find(item=>item.name===name);
    assert.ok(tool,name+' must be listed for a read grant');
    assert.deepEqual(tool.securitySchemes,[{type:'oauth2',scopes:['read']}],name);
    assert.equal(tool.annotations.readOnlyHint,true,name);
    assert.equal(tool.annotations.destructiveHint,false,name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties,'confirm'),false,name);
  }
  const preview=data(await remote.call(read.grant,'circles_preview_join',{link:invite,includeResolvedLink:true}));
  assert.equal(preview.name,'Friends');
  assert.doesNotMatch(JSON.stringify(preview),/invite|faravan:\/\/join|S{20}/i);
  assert.deepEqual(data(await remote.call(read.grant,'circles_check',{circle:'friends'})),{state:'approved'});
  assert.deepEqual(data(await remote.call(read.grant,'circles_presence',{circle:'friends'})),{lenders:[]});
  assert.deepEqual(seen.map(call=>call.id),['circles.preview_join','circles.check','circles.presence']);
  const actOnly={...read.grant,scope:'act'};
  assert.ok(expected.every(name=>!remote.tools(actOnly).some(tool=>tool.name===name)));
  assert.equal(data(await remote.call(actOnly,'circles_check',{circle:'friends'})).code,'insufficient_scope');
  assert.equal(seen.length,3,'a grant without read scope never reaches the operation');
});
