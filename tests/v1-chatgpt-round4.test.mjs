import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as gateway from '../lib/v1/chatgpt-mcp.mjs';

const issuer='https://faravan.example',redirect='https://chatgpt.com/connector_platform_oauth_redirect';
const unpack=r=>JSON.parse(r.content[0].text.split('---\n')[1].split('\n---')[0]);
async function temporary(t){const home=await mkdtemp(join(tmpdir(),'faravan-r4-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
async function gw(t){let now=Date.UTC(2026,9,20,8,5);const server=await gateway.startChatgptGateway({home:await temporary(t),origin:issuer,localOrigin:()=> 'http://127.0.0.1:1234',ops:{call:async()=>({})},now:()=>now});t.after(()=>server.close());return {server,origin:'http://127.0.0.1:'+server.port,advance:ms=>now+=ms};}
const register=(origin,body,headers={})=>fetch(origin+'/oauth/register',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('R2-1: closed pairing attempts cannot spend hourly or peer registration capacity',async t=>{
  const {server,origin}=await gw(t);
  for(let n=0;n<35;n++)assert.equal((await register(origin,{redirect_uris:[redirect]})).status,503,'closed pairing always refuses without spending the next window');
  server.oauth.openPairing();assert.equal((await register(origin,{redirect_uris:[redirect]})).status,201);
});
test('R2-1: unsuccessful open-window registrations do not spend successful-registration capacity',async t=>{
  const {server,origin,advance}=await gw(t);server.oauth.openPairing();
  for(let n=0;n<35;n++){if(n%10===0)advance(60001);assert.equal((await register(origin,{redirect_uris:['https://evil.example/cb']})).status,400);}
  assert.equal((await register(origin,{redirect_uris:[redirect]})).status,201);
});
test('R2 forwarded peer: untrusted direct requests cannot rotate XFF to escape a peer budget',async t=>{
  const {server,origin}=await gw(t);server.oauth.openPairing();
  for(let n=0;n<20;n++)assert.equal((await register(origin,{redirect_uris:['https://evil.example/cb']},{'x-forwarded-for':'198.51.100.'+n})).status,400);
  assert.equal((await register(origin,{redirect_uris:['https://evil.example/cb']},{'x-forwarded-for':'198.51.100.99'})).status,429);
});
test('R2 forwarded peer: missing authenticated ingress falls back to the socket address',()=>{
  const req=(remoteAddress,xff)=>({socket:{remoteAddress,remotePort:12345},headers:{'x-forwarded-for':xff}});
  assert.equal(gateway.gatewayPeerAddress(req('198.51.100.1','203.0.113.9')),'198.51.100.1');
  assert.equal(gateway.gatewayPeerAddress(req('127.0.0.1','203.0.113.9')),'127.0.0.1');
  assert.equal(gateway.gatewayPeerAddress(req('127.0.0.1','198.51.100.1, 203.0.113.9'),
    {handle:{generation:1},ingress:{generation:1,validUntil:new Date(Date.now()+5000).toISOString(),
      clientAddress:{source:'unavailable',reason:'no-authenticated-proxy'}}}),'127.0.0.1');
});
test('R2-2: public authorize tab shows the same matching code as the owner consent and CLI status',async t=>{
  const {server,origin}=await gw(t);server.oauth.openPairing();
  const client=await register(origin,{redirect_uris:[redirect]}).then(r=>r.json());
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'read',state:'mine',resource:issuer+'/mcp',code_challenge:'v'.repeat(43),code_challenge_method:'S256'});
  const html=await fetch(origin+'/oauth/authorize?'+params).then(r=>r.text()),pending=server.oauth.requests()[0];
  assert.ok(html.includes(pending.matching_code),'compare the code visible on the owner’s public authorize tab');
  assert.equal(server.oauth.status().pending_requests[0].matching_code,pending.matching_code);
});
async function calls(t,reply){const seen=[],home=await temporary(t),members=[{key_id:'peer',name:'Sam',device_name:'Sam laptop'}];const remote=gateway.createRemoteCalls({home,localOrigin:()=> 'http://127.0.0.1:1234',oauth:{active:()=>true,audit:()=>true,auditRead:()=>true,auditRoom:()=>true},ops:{call:async(id,input)=>{seen.push({id,input});return reply?reply(id,input):id==='circles.list'?[{id:'circle-id',name:'Friendly people',origin:'https://circle.example'}]:id==='device.get'?{circles:[{circle:'circle-id',members}]}:{ok:true};}}});t.after(()=>remote.close());return {remote,seen};}
const grant=id=>({id,client_id:id,scope:'read act'});
test('R2-5: one connection cannot fill another connection’s action slots or block ungated reads',async t=>{
  const {remote}=await calls(t),a=grant('a'),b=grant('b');
  for(let n=0;n<4;n++)assert.equal(unpack(await remote.call(a,'limits_set',{dailyJobs:n+1})).status,'needs_your_ok');
  assert.equal(unpack(await remote.call(a,'limits_set',{dailyJobs:9})).code,'busy');
  assert.equal(unpack(await remote.call(b,'limits_set',{dailyJobs:10})).status,'needs_your_ok');
  assert.equal(unpack(await remote.call(a,'status_get')).ok,true);assert.equal(unpack(await remote.call({...b,scope:'read'},'status_get')).ok,true);
});
test('R2-7: circle effects use names and automatic lending is an explicit sentence',async t=>{
  const {remote}=await calls(t);
  for(const [name,args] of [['lending_set_mode',{circle:'circle-id',mode:'auto'}],['circles_invite',{circle:'circle-id'}],['limits_set',{circle:'circle-id',mode:'auto'}]]){
    const value=unpack(await remote.call(grant('a'),name,args));assert.equal(value.status,'needs_your_ok');
    assert.match(value.what,/Friendly people/);assert.doesNotMatch(value.what,/circle-id/);
    assert.doesNotMatch(value.what,/[{}]/,'the effect is prose, with individual limits shown below');
    if(args.mode==='auto'){assert.match(value.what,/Automatic for/);assert.match(value.what,/selected agents.*(?:(?:current|saved) )?limits and hours/);assert.match(value.what,/30 days after each verified, non-empty membership refresh/);}
    await remote.decide(value.approval_id,false);
  }
});
test('R2-7: nonexistent local job approvals are refused before asking the person to allow',async t=>{
  const {remote}=await calls(t,id=>id==='approvals.list'?[]:{ok:true});
  assert.equal(unpack(await remote.call(grant('a'),'approvals_accept',{id:'missing'})).code,'not_found');assert.equal(remote.pending().length,0);
});
test('R2-3: join previews identify the circle and owner; execution uses the reviewed resolved invite',async t=>{
  const preview={name:'Friends',origin:'https://circle.example',ownerName:'Sam',members:[{name:'Sam',device_name:'Sam laptop'}],resolvedLink:'https://circle.example/join#invite=frozen',membersComplete:true};
  const {remote,seen}=await calls(t,id=>id==='circles.preview_join'?preview:{ok:true});
  const r=unpack(await remote.call(grant('a'),'circles_join',{link:'https://circle.example/i/abcdefghij#secret'}));assert.equal(r.status,'needs_your_ok');
  const local=remote.localGet(r.approval_id);assert.equal(local.details.join_preview.name,'Friends');assert.equal(local.details.recipient_members[0].name,'Sam');assert.match(r.what,/Friends/);assert.match(r.what,/Sam/);
  assert.equal(seen.find(x=>x.id==='circles.preview_join').input.includeResolvedLink,true,'only the local approval preparation requests the resolved secret');
  await remote.decide(r.approval_id,true);assert.equal(seen.find(x=>x.id==='circles.join').input.link,preview.resolvedLink);
});
test('R2-3: an invitation that cannot be previewed is never offered for approval',async t=>{
  const {remote}=await calls(t,id=>{if(id==='circles.preview_join')throw Object.assign(new Error('Cannot check invitation'),{code:'invalid_invite'});return {ok:true};});
  assert.equal(unpack(await remote.call(grant('a'),'circles_join',{link:'bad'})).code,'invalid_invite');assert.equal(remote.pending().length,0);
});
test('R2-1: only successful registrations spend the 30 per hour cap',async t=>{
  const {server,origin,advance}=await gw(t);
  for(let n=0;n<30;n++){if(n%10===0)advance(60001);server.oauth.openPairing();assert.equal((await register(origin,{redirect_uris:[redirect]})).status,201);}
  advance(60001);
  server.oauth.openPairing();assert.equal((await register(origin,{redirect_uris:[redirect]})).status,429);
});
test('R2 forwarded peer: a claimed header without the required peer identity shares the socket budget',async t=>{
  const {server,origin}=await gw(t);
  const validUntil=new Date(Date.now()+20000).toISOString();
  server.configure(issuer,{handle:{generation:1},verification:{validUntil:{known:true,value:validUntil}},
    ingress:{generation:1,validUntil,clientAddress:{source:'trusted-header',evidenceRef:'fixture-only',
      peer:{kind:'unix-socket',path:'/unavailable-from-tcp',ownerUid:process.getuid()},
      header:{name:'x-forwarded-for',format:'ip-list',selection:'rightmost-untrusted',sanitization:'strip-inbound-and-write',trustedHops:0,trustedProxyCidrs:[]}}}});
  server.oauth.openPairing();
  for(let n=0;n<20;n++)assert.equal((await register(origin,{redirect_uris:['https://evil.example/cb']},{'x-forwarded-for':'203.0.113.'+n})).status,400);
  assert.equal((await register(origin,{redirect_uris:['https://evil.example/cb']},{'x-forwarded-for':'203.0.113.200'})).status,429);
});
test('R2-5: running reads have their own per-connection cap and never wait on pending actions',async t=>{
  let release;const hold=new Promise(r=>{release=r;});
  const {remote}=await calls(t,id=>id==='status.get'?hold.then(()=>({ok:true})):{ok:true});
  const a=grant('a');
  const first=[...Array(4)].map(()=>remote.call(a,'status_get'));
  await new Promise(r=>setTimeout(r,20));
  const fifth=await remote.call(a,'status_get');assert.equal(unpack(fifth).code,'busy');
  assert.equal(unpack(await remote.call(a,'limits_set',{dailyJobs:1})).status,'needs_your_ok','a pending action is not blocked by running reads');
  release();await Promise.all(first);remote.close();
});
test('R2-3: a preview without a verified owner or resolved link is never offered',async t=>{
  for(const preview of [{name:'F',origin:'https://c.example',resolvedLink:'https://c.example/join#invite=x'},{name:'F',origin:'https://c.example',ownerName:'Sam'}]){
    const {remote}=await calls(t,id=>id==='circles.preview_join'?preview:{ok:true});
    assert.equal(unpack(await remote.call(grant('a'),'circles_join',{link:'https://c.example/i/abcdefghij#s'})).code,'invalid_invite');assert.equal(remote.pending().length,0);
  }
});
test('R2-7: an existing local job approval is offered with its details',async t=>{
  const {remote}=await calls(t,id=>id==='approvals.list'?[{id:'job1',prompt:'p'}]:{ok:true});
  const r=unpack(await remote.call(grant('a'),'approvals_accept',{id:'job1'}));assert.equal(r.status,'needs_your_ok');
  assert.equal(remote.localGet(r.approval_id).details.job_to_run.id,'job1');
});
