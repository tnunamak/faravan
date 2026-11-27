import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as oauthModule from '../lib/v1/chatgpt-oauth.mjs';

const {createChatgptOAuth}=oauthModule;
const issuer='https://faravan.example',loopback='http://127.0.0.1:43210/callback';
const STABLE='https://chatgpt.com/connector_platform_oauth_redirect',CALLBACK='https://chatgpt.com/connector/oauth/cb_Ab12-x';
const DAY=86400000,verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
const sha=value=>createHash('sha256').update(value).digest('base64url');
async function temporary(t){const home=await mkdtemp(join(tmpdir(),'faravan-oauth-sec-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
function setup(t,home,options={}) {
  const clock={now:1_000_000_000};
  const make=()=>createChatgptOAuth({home,origin:issuer,localOrigin:()=> 'http://127.0.0.1:1',now:()=>clock.now,...options});
  return {clock,make,oauth:make()};
}
const authParams=(client,{redirect=client.redirect_uris[0],scope='read act',state='client-state'}={})=>new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope,state,resource:issuer+'/mcp',code_challenge:challenge,code_challenge_method:'S256'});
const exchange=(oauth,client,code,redirect=client.redirect_uris[0])=>oauth.token({client_id:client.client_id,grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier,resource:issuer+'/mcp'});
const refresh=(oauth,client,token)=>oauth.token({client_id:client.client_id,grant_type:'refresh_token',refresh_token:token});
function connect(oauth,{redirect=loopback,scope='read act',selected,name}={}) {
  oauth.openPairing?.();
  const client=oauth.register({redirect_uris:[redirect],client_name:name});
  const request=oauth.authorize(authParams(client,{scope}));
  const code=new URL(oauth.approve(request.id,true,selected)).searchParams.get('code');
  const tokens=exchange(oauth,client,code);
  return {client,tokens,code,grant:oauth.authenticate('Bearer '+tokens.access_token)};
}
const oauthError=code=>error=>error.oauthError===code;

test('a pending local action cannot execute after its grant absolute expiry',async t=>{
  const home=await temporary(t),{oauth,clock}=setup(t,home);oauth.openPairing();
  const {grant}=connect(oauth);assert.equal(oauth.active(grant),true);
  clock.now+=30*DAY+1;
  assert.equal(oauth.active(grant),false,'local authorization must prune expiry even without a new bearer request');
});

test('P1-2 redirect allowlist: only documented ChatGPT callbacks and loopback; lookalikes refused',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  for(const uri of [STABLE,CALLBACK,'https://chatgpt.com/connector/oauth/abc123',loopback,'http://localhost:6274/oauth/callback','http://[::1]:8080/cb','https://127.0.0.1:9000/cb'])
    assert.ok(oauth.register({redirect_uris:[uri]}).client_id,uri);
  for(const uri of [
    'https://evil.example/callback','https://chatgpt-connect.evil.example/oauth/callback','https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
    'https://evilchatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com/other','https://chatgpt.com/','https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/a/b','https://chatgpt.com/connector/oauth/../../evil','https://chatgpt.com/connector/oauth/%2e%2e',
    STABLE+'?next=https://evil.example',STABLE+'#frag',STABLE+'/','https://user@chatgpt.com/connector_platform_oauth_redirect',
    'https://user:pw@chatgpt.com/connector_platform_oauth_redirect','http://chatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com:443/connector_platform_oauth_redirect',
    'https://chatgpt.com:8443/connector_platform_oauth_redirect','https://CHATGPT.COM/connector_platform_oauth_redirect','https://chatgpt.com./connector_platform_oauth_redirect',
    'https://www.chatgpt.com/connector_platform_oauth_redirect','https://chat.openai.com/connector_platform_oauth_redirect',
    loopback+'?x=1',loopback+'#f','http://user@127.0.0.1/cb','http://localhost.evil.example/cb','http://127.0.0.1.nip.io/cb','javascript:alert(1)','chatgpt://callback',
  ]) assert.throws(()=>oauth.register({redirect_uris:[uri]}),oauthError('invalid_redirect_uri'),uri);
  assert.throws(()=>oauth.register({redirect_uris:[STABLE,'https://evil.example/cb']}),oauthError('invalid_redirect_uri'),'one bad URI rejects the registration');
  assert.equal(typeof oauthModule.classifyRedirect,'function');
  assert.deepEqual(oauthModule.classifyRedirect(STABLE),{kind:'chatgpt',host:'chatgpt.com'});
  assert.deepEqual(oauthModule.classifyRedirect(loopback),{kind:'loopback',host:'127.0.0.1:43210'});
  assert.equal(oauthModule.classifyRedirect('https://evil.example/cb'),null);
});

test('P1-2 pairing window: closed by default, 10 minutes after openPairing, never reopened by restart or refresh',async t=>{
  const home=await temporary(t),{oauth,clock,make}=setup(t,home);
  assert.equal(oauth.status().pairing_until,null);
  assert.throws(()=>oauth.register({redirect_uris:[STABLE]}),oauthError('temporarily_unavailable'),'registration refused without pairing');
  const opened=oauth.openPairing();assert.equal(opened.pairing_until,clock.now+600000);assert.equal(oauth.status().pairing_until,clock.now+600000);
  const client=oauth.register({redirect_uris:[loopback]});
  const live=connect(oauth);oauth.openPairing();
  clock.now+=400000;const lateRequest=oauth.authorize(authParams(client));
  clock.now+=200001;
  assert.equal(oauth.status().pairing_until,null,'expired window reports closed');
  assert.throws(()=>oauth.register({redirect_uris:[STABLE]}),oauthError('temporarily_unavailable'));
  assert.throws(()=>oauth.authorize(authParams(client)),oauthError('temporarily_unavailable'),'authorize refused after the window');
  assert.throws(()=>oauth.approve(lateRequest.id,true),oauthError('temporarily_unavailable'),'approve refused after the window');
  const fresh=refresh(oauth,live.client,live.tokens.refresh_token);assert.ok(fresh.access_token,'refresh keeps working outside the window');
  assert.equal(oauth.status().pairing_until,null,'refresh does not reopen pairing');
  const resumed=make();assert.equal(resumed.status().pairing_until,null,'a restarted authority starts closed');
  assert.throws(()=>resumed.authorize(authParams(live.client)),oauthError('temporarily_unavailable'));
  assert.ok(resumed.authenticate('Bearer '+fresh.access_token),'existing connections keep working after restart');
  const disk=await readFile(join(home,'v1/chatgpt-oauth.json'),'utf8');assert.ok(!/pairing/i.test(disk),'pairing is memory-only');
});

test('P1-2 consent metadata, pending requests list and read-only downgrade',async t=>{
  const home=await temporary(t),{oauth,clock}=setup(t,home);oauth.openPairing();
  const chat=oauth.register({redirect_uris:[STABLE],client_name:'ChatGPT'});const registeredAt=clock.now;clock.now+=5000;
  const request=oauth.authorize(authParams(chat,{state:'SECRET-STATE'}));
  assert.deepEqual(oauth.consent(request.id),{client:'ChatGPT',scope:'read act',redirect_uri:STABLE,redirect_host:'chatgpt.com',registered_at:registeredAt,requested_at:clock.now,is_chatgpt:true,matching_code:request.matching_code});
  const fake=oauth.register({redirect_uris:[loopback],client_name:'ChatGPT'});const fakeRequest=oauth.authorize(authParams(fake));
  assert.equal(oauth.consent(fakeRequest.id).is_chatgpt,false,'a client named ChatGPT on loopback is not ChatGPT');
  assert.equal(oauth.consent(fakeRequest.id).redirect_host,'127.0.0.1:43210');
  const listed=oauth.requests();assert.deepEqual(listed.map(r=>r.id).sort(),[request.id,fakeRequest.id].sort());
  assert.deepEqual(listed.find(r=>r.id===request.id),{id:request.id,...oauth.consent(request.id)});
  assert.ok(!JSON.stringify(listed).includes('SECRET-STATE')&&!JSON.stringify(listed).includes(challenge),'no state or PKCE values');
  assert.throws(()=>oauth.approve(fakeRequest.id,true,'admin'),oauthError('invalid_scope'));
  const readOnly=oauth.authorize(authParams(fake,{scope:'read'}));
  assert.throws(()=>oauth.approve(readOnly.id,true,'read act'),oauthError('invalid_scope'),'cannot widen beyond request');
  const downgraded=new URL(oauth.approve(fakeRequest.id,true,'read')).searchParams.get('code');
  const tokens=exchange(oauth,fake,downgraded);assert.equal(tokens.scope,'read');
  assert.equal(oauth.authenticate('Bearer '+tokens.access_token).scope,'read');
  assert.throws(()=>oauth.approve(request.id,true),oauthError('invalid_request'),'the first decision invalidated the other pending request');
  oauth.openPairing();const again=oauth.authorize(authParams(chat));
  const plain=new URL(oauth.approve(again.id,true)).searchParams.get('code');assert.equal(exchange(oauth,chat,plain).scope,'read act','boolean approve keeps full requested scope');
});

const CODE=/^[0-9A-F]{4}-[0-9A-F]{4}$/;
const pendingFor=(oauth,n=2)=>Array.from({length:n},()=>oauth.authorize(authParams(oauth.register({redirect_uris:[STABLE],client_name:'ChatGPT'}))));

test('R2-2 one-shot pairing: first allow closes pairing and invalidates every other pending consent',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  assert.equal(oauth.pairingOpen(),true);
  const [mine,attacker]=pendingFor(oauth);
  oauth.approve(mine.id,true);
  assert.equal(oauth.pairingOpen(),false);assert.equal(oauth.status().pairing_until,null);
  assert.deepEqual(oauth.status().pending_requests,[]);assert.deepEqual(oauth.requests(),[]);
  assert.throws(()=>oauth.consent(attacker.id),oauthError('invalid_request'),'the attacker request is gone');
  assert.throws(()=>oauth.approve(attacker.id,true),oauthError('invalid_request'));
  assert.throws(()=>oauth.register({redirect_uris:[STABLE]}),oauthError('temporarily_unavailable'));
});

test('R2-2 one-shot pairing: a deny also closes pairing and invalidates other pending consents',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  const [a,b]=pendingFor(oauth);
  assert.match(new URL(oauth.approve(a.id,false)).searchParams.get('error'),/access_denied/);
  assert.equal(oauth.pairingOpen(),false);assert.equal(oauth.status().pairing_until,null);
  assert.throws(()=>oauth.approve(b.id,true),oauthError('invalid_request'));
  assert.deepEqual(oauth.requests(),[]);
});

test('R2-2 a failed invalid-scope decision does not close pairing or drop requests',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  const [a,b]=pendingFor(oauth);
  assert.throws(()=>oauth.approve(a.id,true,'admin'),oauthError('invalid_scope'));
  assert.throws(()=>oauth.approve(a.id,true,'  '),oauthError('invalid_scope'));
  assert.equal(oauth.pairingOpen(),true);assert.equal(oauth.requests().length,2);
  assert.ok(oauth.status().pairing_until);
  assert.ok(oauth.consent(b.id));
});

test('R2-2 openPairing clears stale pending requests but keeps grants and issued codes',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  const kept=connect(oauth);
  oauth.openPairing();
  const client=oauth.register({redirect_uris:[loopback]});
  const stale=oauth.authorize(authParams(client));
  const issued=new URL(oauth.approve(oauth.authorize(authParams(client)).id,true)).searchParams.get('code');
  oauth.openPairing();const stale2=oauth.authorize(authParams(client));
  oauth.openPairing();
  assert.throws(()=>oauth.consent(stale.id),oauthError('invalid_request'));
  assert.throws(()=>oauth.consent(stale2.id),oauthError('invalid_request'));
  assert.deepEqual(oauth.requests(),[]);
  assert.ok(oauth.authenticate('Bearer '+kept.tokens.access_token),'existing grants survive');
  assert.ok(exchange(oauth,client,issued).access_token,'an already issued code still redeems');
});

test('R2-2 matching_code: per request XXXX-XXXX label, distinct, derived from the id hash, never authority',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  const client=oauth.register({redirect_uris:[STABLE],client_name:'ChatGPT'});
  const a=oauth.authorize(authParams(client,{state:'STATE-ONE'})),b=oauth.authorize(authParams(client,{state:'STATE-ONE'}));
  assert.match(a.matching_code,CODE);assert.match(b.matching_code,CODE);
  assert.notEqual(a.matching_code,b.matching_code,'a window-wide code could not tell requests apart');
  assert.equal(a.matching_code,createHash('sha256').update(a.id).digest('hex').slice(0,8).toUpperCase().replace(/^(.{4})/,'$1-'));
  assert.equal(oauth.consent(a.id).matching_code,a.matching_code);
  assert.deepEqual(oauth.requests().map(r=>r.matching_code).sort(),[a.matching_code,b.matching_code].sort());
  const pending=oauth.status().pending_requests;
  assert.deepEqual(pending.map(r=>r.matching_code).sort(),[a.matching_code,b.matching_code].sort());
  const shown=pending.find(r=>r.matching_code===a.matching_code);
  assert.equal(shown.redirect_host,'chatgpt.com');assert.equal(shown.is_chatgpt,true);assert.equal(shown.scope,'read act');assert.equal(shown.client,'ChatGPT');
  const text=JSON.stringify(pending);
  for(const secret of [a.id,b.id,'STATE-ONE',challenge,client.client_id])assert.ok(!text.includes(secret),'status pending_requests leaks '+secret);
  assert.equal(shown.id,undefined);
  // The code is a label only: presenting it as an authorization code or token does nothing.
  assert.throws(()=>oauth.token({client_id:client.client_id,grant_type:'authorization_code',code:a.matching_code,redirect_uri:STABLE,code_verifier:verifier,resource:issuer+'/mcp'}),oauthError('invalid_grant'));
  assert.throws(()=>oauth.approve(a.matching_code,true),oauthError('invalid_request'));
  assert.equal(oauth.authenticate('Bearer '+a.matching_code),null);
  const code=new URL(oauth.approve(a.id,true)).searchParams.get('code');
  assert.ok(!code.toUpperCase().includes(a.matching_code.replace('-','')));
});

test('P1-2 status shows real callback host per connection; revokeConnection is local',async t=>{
  const home=await temporary(t),{oauth,clock}=setup(t,home);oauth.openPairing();
  const real=connect(oauth,{redirect:STABLE,name:'ChatGPT'});
  const fake=connect(oauth,{name:'ChatGPT'});
  const connections=oauth.status().connections;assert.equal(connections.length,2);
  const shown=connections.find(c=>c.client_id===fake.client.client_id);
  assert.equal(shown.redirect_host,'127.0.0.1:43210');assert.equal(shown.is_chatgpt,false);assert.equal(shown.registered_at,clock.now);assert.ok(shown.id);
  assert.equal(connections.find(c=>c.client_id===real.client.client_id).redirect_host,'chatgpt.com');
  assert.equal(oauth.revokeConnection(shown.id),true);
  assert.equal(oauth.authenticate('Bearer '+fake.tokens.access_token),null);
  assert.throws(()=>refresh(oauth,fake.client,fake.tokens.refresh_token),oauthError('invalid_grant'));
  assert.ok(oauth.authenticate('Bearer '+real.tokens.access_token),'other connection untouched');
  assert.equal(oauth.revokeConnection('nope'),false);
});

test('P2-5 refresh: 30-day absolute lifetime, bounded per-grant storage, previous token replay revokes',async t=>{
  const home=await temporary(t),{oauth,clock,make}=setup(t,home,{accessLifetimeMs:600000});oauth.openPairing();
  const first=connect(oauth),other=connect(oauth);
  let tokens=first.tokens;
  for(let i=0;i<300;i++)tokens=refresh(oauth,first.client,tokens.refresh_token);
  const size=(await stat(join(home,'v1/chatgpt-oauth.json'))).size;
  assert.ok(size<8192,'state stays bounded after 300 refreshes: '+size+' bytes');
  assert.equal(oauth.authenticate('Bearer '+first.tokens.access_token),null,'old access tokens are bounded per grant');
  assert.ok(oauth.authenticate('Bearer '+tokens.access_token));
  assert.ok(refresh(oauth,other.client,other.tokens.refresh_token).access_token,'one chatty connection cannot exhaust another');
  // Previous token replay revokes the family.
  const previous=tokens.refresh_token;tokens=refresh(oauth,first.client,tokens.refresh_token);
  assert.throws(()=>refresh(oauth,first.client,previous),oauthError('invalid_grant'));
  assert.equal(oauth.authenticate('Bearer '+tokens.access_token),null,'replay of previous refresh token revokes family');
  // Absolute lifetime.
  const aged=connect(oauth);let current=aged.tokens;
  for(let week=0;week<4;week++){clock.now+=7*DAY;current=refresh(oauth,aged.client,current.refresh_token);}
  clock.now+=3*DAY;
  assert.throws(()=>refresh(oauth,aged.client,current.refresh_token),oauthError('invalid_grant'),'grant older than 30 days cannot refresh');
  assert.equal(make().status().connections.some(c=>c.client_id===aged.client.client_id),false,'expired grant is pruned');
});

test('P2-5 migration: old state gains absolute expiry, dead grants pruned, legacy audit moved to private audit file',async t=>{
  const home=await temporary(t),now=1_000_000_000;await mkdir(join(home,'v1'),{recursive:true});
  const live='L'.repeat(43),dead='D'.repeat(43),old='O'.repeat(43),access='A'.repeat(43),usedRefresh='U'.repeat(43);
  const client={client_id:'c1',client_name:'ChatGPT',redirect_uris:[STABLE],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'read act',client_id_issued_at:Math.floor((now-DAY)/1000),approved_at:now-DAY};
  const evil={...client,client_id:'evil',redirect_uris:['https://chatgpt-connect.evil.example/cb']};
  await writeFile(join(home,'v1/chatgpt-oauth.json'),JSON.stringify({origin:issuer,clients:{c1:client,evil},
    grants:{g1:{id:'g1',client_id:'c1',scope:'read act',created_at:now-DAY},g2:{id:'g2',client_id:'c1',scope:'read',created_at:now-2*DAY},g3:{id:'g3',client_id:'c1',scope:'read',created_at:now-40*DAY},g4:{id:'g4',client_id:'evil',scope:'read act',created_at:now-DAY}},
    access:{[sha(access)]:{grant:'g1',expires:now+1000}},
    refresh:{[sha(live)]:{grant:'g1',expires:now+20*DAY,used:false},[sha(usedRefresh)]:{grant:'g1',expires:now+19*DAY,used:true},[sha(dead)]:{grant:'g2',expires:now-1,used:false},[sha(old)]:{grant:'g3',expires:now+DAY,used:false},[sha('E'.repeat(43))]:{grant:'g4',expires:now+DAY,used:false}},
    audit:[{at:now-5,actor:'ChatGPT',client_id:'c1',op:'lending.on',outcome:'completed'}]}),{mode:0o600});
  const {oauth}=setup(t,home);
  assert.deepEqual(oauth.status().connections.map(c=>c.id),['g1'],'only the grant with a live refresh, inside 30 days, on an allowed redirect survives');
  assert.ok(oauth.authenticate('Bearer '+access));
  assert.ok(refresh(oauth,{client_id:'c1'},live).access_token);
  const state=JSON.parse(await readFile(join(home,'v1/chatgpt-oauth.json'),'utf8'));
  assert.equal(state.audit,undefined,'legacy audit no longer in token state');assert.equal(state.clients.evil,undefined,'non-allowlisted client dropped');
  assert.equal(state.grants.g1.expires_at,now-DAY+30*DAY,'absolute lifetime derived from created_at');
  const auditFile=join(home,'v1/chatgpt-audit.json');assert.equal((await stat(auditFile)).mode&0o777,0o600);
  assert.ok(oauth.status().audit.some(e=>e.op==='lending.on'&&e.client_id==='c1'),'legacy audit preserved');
  const again=setup(t,home).oauth;assert.equal(again.status().audit.filter(e=>e.op==='lending.on').length,1,'migration is idempotent');
});

test('P2-7 authorization code replay with full proof revokes the first grant; without proof it does not',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  const a=connect(oauth);
  assert.throws(()=>oauth.token({client_id:a.client.client_id,grant_type:'authorization_code',code:a.code,redirect_uri:loopback,code_verifier:'x'.repeat(64),resource:issuer+'/mcp'}),oauthError('invalid_grant'));
  assert.ok(oauth.authenticate('Bearer '+a.tokens.access_token),'a replay without the PKCE verifier cannot revoke');
  assert.throws(()=>exchange(oauth,a.client,a.code),oauthError('invalid_grant'));
  assert.equal(oauth.authenticate('Bearer '+a.tokens.access_token),null,'proven replay revokes the grant from the first use');
  assert.throws(()=>refresh(oauth,a.client,a.tokens.refresh_token),oauthError('invalid_grant'));
});

test('P2-2 audit: private separate file, per-client buckets, never evicted remotely, room gate, revoke still works',async t=>{
  const home=await temporary(t),{oauth,make}=setup(t,home);oauth.openPairing();
  const a=connect(oauth),b=connect(oauth);
  assert.equal(oauth.auditRoom(a.grant),true);
  assert.equal(oauth.audit(a.grant,'lending.set_mode','started','Set lending to auto'),true);
  const auditFile=join(home,'v1/chatgpt-audit.json');assert.equal((await stat(auditFile)).mode&0o777,0o600);
  const tokenState=await readFile(join(home,'v1/chatgpt-oauth.json'),'utf8');assert.ok(!tokenState.includes('lending.set_mode'));
  let accepted=1;while(oauth.auditRoom(a.grant)){assert.equal(oauth.audit(a.grant,'status.get','completed'),true);accepted++;if(accepted>5000)break;}
  assert.ok(accepted<5000,'bucket is bounded');
  assert.equal(oauth.audit(a.grant,'status.get','completed'),true,'completion of an already started call uses the reserve');
  for(let i=0;i<500;i++)oauth.audit(a.grant,'status.get','completed');
  assert.equal(oauth.audit(a.grant,'status.get','completed'),false,'full bucket refuses new entries');
  const entries=oauth.status().audit.filter(e=>e.client_id===a.client.client_id);
  assert.ok(entries.some(e=>e.op==='lending.set_mode'&&e.effect==='Set lending to auto'),'first consequential entry never evicted');
  const bucket=oauth.status().audit_buckets.find(x=>x.client_id===a.client.client_id);assert.ok(bucket.overflow>0&&bucket.full);
  assert.equal(oauth.auditRoom(a.grant),false);assert.equal(oauth.auditRoom(b.grant),true,'one client cannot fill another client audit');
  refresh(oauth,a.client,a.tokens.refresh_token);
  oauth.revoke({client_id:a.client.client_id,token:a.tokens.access_token});
  assert.equal(oauth.active(a.grant),false,'revocation works even with a full audit');
  oauth.clearAudit(a.client.client_id);
  assert.equal(oauth.status().audit.some(e=>e.client_id===a.client.client_id&&e.op==='status.get'),false);
  const raw=await readFile(auditFile,'utf8');
  for(const token of [a.tokens.access_token,a.tokens.refresh_token,b.tokens.access_token,b.tokens.refresh_token])assert.ok(!raw.includes(token),'no token values in audit');
  assert.ok(make().auditRoom(b.grant),'audit persists across restart');
});

test('P2-2 OAuth lifecycle is audited: registration, consent allow/deny, refresh, reuse and revoke',async t=>{
  const home=await temporary(t),{oauth}=setup(t,home);oauth.openPairing();
  const denied=oauth.register({redirect_uris:[STABLE],client_name:'ChatGPT'});oauth.approve(oauth.authorize(authParams(denied)).id,false);
  const a=connect(oauth,{redirect:STABLE});
  const fresh=refresh(oauth,a.client,a.tokens.refresh_token);
  assert.throws(()=>refresh(oauth,a.client,a.tokens.refresh_token));
  const b=connect(oauth);oauth.revoke({client_id:b.client.client_id,token:b.tokens.refresh_token});
  const ops=oauth.status().audit.map(e=>e.op+':'+e.outcome);
  for(const expected of ['oauth.register:completed','oauth.consent:denied','oauth.consent:allowed','oauth.refresh_reuse:revoked','oauth.revoke:completed'])assert.ok(ops.includes(expected),expected+' in '+ops);
  const bucket=oauth.status().audit_buckets.find(x=>x.client_id===a.client.client_id);assert.equal(bucket.refreshes,1,'refresh counted without consuming entries');
  assert.ok(!JSON.stringify(oauth.status()).includes(fresh.access_token));
});

test('P2-3 DCR: clients with pending consent are never evicted; full DCR fails closed; protected audit survives',async t=>{
  const home=await temporary(t),{oauth,clock}=setup(t,home);oauth.openPairing();
  const a=connect(oauth);oauth.audit(a.grant,'lending.on','started','Turn lending on');oauth.openPairing();
  const waiting=oauth.register({redirect_uris:[STABLE],client_name:'ChatGPT'});const request=oauth.authorize(authParams(waiting));
  for(let i=0;i<200;i++)oauth.register({redirect_uris:[loopback]});
  assert.ok(oauth.consent(request.id),'pending consent survives a registration flood');
  assert.ok(oauth.status().audit.some(e=>e.op==='lending.on'),'protected audit survives');
  clock.now+=400000;oauth.openPairing();
  // Fill every slot with pending consent: registration must refuse instead of evicting.
  const blockers=[];while(blockers.length<99){const c=oauth.register({redirect_uris:[loopback]});oauth.authorize(authParams(c));blockers.push(c);}
  assert.throws(()=>oauth.register({redirect_uris:[loopback]}),oauthError('temporarily_unavailable'));
  assert.ok(oauth.authenticate('Bearer '+a.tokens.access_token));
});

test('P2-B reads are aggregated: 500 reads never consume action capacity or evict history; actions still cap; revoke works full',async t=>{
  const home=await temporary(t),{oauth,clock,make}=setup(t,home);oauth.openPairing();
  const a=connect(oauth),read=(op,outcome)=>(oauth.auditRead??oauth.audit)(a.grant,op,outcome);
  assert.equal(oauth.audit(a.grant,'lending.on','started','Turn lending on'),true);
  const first=clock.now;
  for(let i=0;i<500;i++){clock.now+=10;assert.equal(read('tools.list','read'),true);read('status.get','started');read('status.get','completed');read('jobs.get','refused');}
  assert.equal(oauth.auditRoom(a.grant,5),true,'reads leave action capacity untouched');
  const status=oauth.status(),mine=status.audit.filter(e=>e.client_id===a.client.client_id);
  assert.ok(mine.some(e=>e.op==='lending.on'&&e.effect==='Turn lending on'),'protected history kept');
  const list=mine.find(e=>e.op==='tools.list'&&e.outcome==='read');
  assert.equal(list.count,500);assert.equal(list.first_at,first+10);assert.equal(list.at,clock.now);assert.equal(list.actor,'ChatGPT');
  assert.equal(mine.find(e=>e.op==='status.get'&&e.outcome==='completed').count,500);
  assert.ok(mine.length<10,'aggregates, not entries: '+mine.length);
  const bucket=status.audit_buckets.find(b=>b.client_id===a.client.client_id);
  assert.equal(bucket.read_calls,1500,'started is not counted as a separate read');assert.equal(bucket.entries,2,'consent + one action');assert.equal(bucket.full,false);
  // Bounded keys, no prototype pollution; existing keys keep counting after the cap.
  for(let i=0;i<200;i++)read('op.'+i,'completed');
  assert.equal(read('__proto__','completed'),false);assert.equal(({}).count,undefined);
  assert.equal(read('tools.list','read'),true,'existing key still counts after the key cap');
  const capped=oauth.status().audit_buckets.find(b=>b.client_id===a.client.client_id);
  assert.ok(capped.read_overflow>0);assert.ok(oauth.status().audit.filter(e=>e.client_id===a.client.client_id&&e.count).length<=128);
  assert.equal(make().status().audit.find(e=>e.op==='tools.list').count,501,'aggregates persist');
  // Protected actions still fill and refuse; revocation still works when full.
  let n=0;while(oauth.auditRoom(a.grant)&&n<1000){oauth.audit(a.grant,'jobs.submit','started','Submit');n++;}
  assert.equal(n,198,'200 protected entries: consent, lending.on, 198 submits');assert.equal(oauth.audit(a.grant,'jobs.submit','started'),false);
  assert.equal(read('status.get','completed'),true,'reads still counted while actions are full');
  oauth.revoke({client_id:a.client.client_id,token:a.tokens.refresh_token});assert.equal(oauth.active(a.grant),false);
  oauth.clearAudit(a.client.client_id);
  const cleared=oauth.status();
  assert.equal(cleared.audit_buckets.some(b=>b.client_id===a.client.client_id),false,'clear resets protected and reads');
  assert.equal(cleared.audit.some(e=>e.client_id===a.client.client_id&&(e.count||e.op==='lending.on')),false);
});
