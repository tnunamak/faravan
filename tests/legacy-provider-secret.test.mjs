import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {restrictCredentialScope,removeNativeProviderGlobalSecret} from '../lib/sandbox-credentials.mjs';
import {isPrivateSbxHome} from '../lib/docker-backend.mjs';

const CANARY='private-credential-value-canary';
const SANDBOX='wf-0123456789abcdef';
// A fake sbx store: list, rm (global only unless --sandbox) and the ssh settings restrictCredentialScope reads.
function store(rows,{stuck=false}={}) {
  const state={rows:[...rows],calls:[]};
  state.run=async args=>{
    state.calls.push(args.join(' '));
    if(args[0]==='secret'&&args[1]==='ls')return {code:0,stdout:JSON.stringify({secrets:state.rows,custom_secrets:[],shadowed_services:[],env_only_count:0}),stderr:''};
    if(args[0]==='secret'&&args[1]==='rm') {
      if(stuck)return {code:1,stdout:'',stderr:'synthetic failure'};
      const scoped=args.includes('--sandbox');
      state.rows=state.rows.filter(row=>!(row.name===args[2]&&(scoped?row.scope===args[args.indexOf('--sandbox')+1]:['global','(global)'].includes(row.scope))));
      return {code:0,stdout:'',stderr:''};
    }
    if(args[0]==='settings'&&args[1]==='get')return {code:0,stdout:args[2]==='ssh.agentForwardingEnabled'?'false':'""',stderr:''};
    return {code:0,stdout:'',stderr:''};
  };
  return state;
}
const row=(name,scope='global')=>({type:'service',name,scope,value:CANARY});
const claude={image:'claude',github_access_required:false,egress:'internet'};
const codex={image:'codex',github_access_required:false,egress:'internet'};
// What the backend does for a job with a native generation: remove, then restrict with that generation.
async function prepare(state,job,{privateHome=true,events=[]}={}) {
  await removeNativeProviderGlobalSecret(state.run,job,{privateHome,onDiagnostic:event=>events.push(event)});
  return restrictCredentialScope(state.run,job,SANDBOX,null,{},{});
}

test('a global anthropic value is removed for a native Claude job, which then prepares',async()=>{
  const state=store([row('anthropic')]);
  await prepare(state,claude);
  assert.deepEqual(state.rows,[]);
});
test('without the removal the same store is refused (red before the fix)',async()=>{
  const state=store([row('anthropic')]);
  await assert.rejects(restrictCredentialScope(state.run,claude,SANDBOX,null,{},{}),error=>error.condition==='unrelated_service_credential');
});
test('a global value that cannot be removed refuses with a fixed code and a plain message',async()=>{
  const state=store([row('anthropic')],{stuck:true});
  await assert.rejects(prepare(state,claude),error=>error.code==='credential_scope_unenforceable'&&error.condition==='legacy_provider_secret_global'
    &&!error.message.includes(CANARY)&&/could not be removed/.test(error.message));
});
test("another provider's global value is left alone",async()=>{
  const state=store([row('openai')]);
  const events=[];
  await prepare(state,claude,{events});
  assert.deepEqual(state.rows.map(r=>r.name),['openai']);
  assert.equal(state.calls.some(call=>call.startsWith('secret rm')),false);
  assert.equal(events.length,0);
});
test('a sandbox-scoped value is never removed',async()=>{
  const state=store([row('anthropic',SANDBOX),row('anthropic','wf-fedcba9876543210')]);
  const removed=await removeNativeProviderGlobalSecret(state.run,claude,{privateHome:true});
  assert.equal(removed,false);
  assert.equal(state.rows.length,2);
  assert.equal(state.calls.some(call=>call.startsWith('secret rm')),false);
});
test('only the global one goes when a scoped value of the same service exists',async()=>{
  const state=store([row('anthropic'),row('anthropic',SANDBOX)]);
  await removeNativeProviderGlobalSecret(state.run,claude,{privateHome:true});
  assert.deepEqual(state.rows.map(r=>r.scope),[SANDBOX]);
});
test('a job with no native generation removes nothing (the caller does not call; a job with no native provider is a no-op)',async()=>{
  const state=store([row('anthropic')]);
  assert.equal(await removeNativeProviderGlobalSecret(state.run,{image:'wf-gh-cli'},{privateHome:true}),false);
  assert.equal(state.rows.length,1);
  const backend=readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
  assert.match(backend,/if \(providerGeneration\) await removeNativeProviderGlobalSecret\(/,'only a job with a native generation reaches the removal');
  assert.ok(backend.indexOf('removeNativeProviderGlobalSecret(run')<backend.indexOf('inertServices = await restrictCredentialScope'),'removal runs before the scope check');
});
test('with a store that is not the private one, nothing is removed and the existing refusal stands',async()=>{
  const state=store([row('anthropic')]);
  const events=[];
  await assert.rejects(prepare(state,claude,{privateHome:false,events}),error=>error.condition==='unrelated_service_credential');
  assert.equal(state.rows.length,1);
  assert.equal(state.calls.some(call=>call.startsWith('secret rm')),false);
  assert.equal(events.length,0);
});
test('private-home proof: only the home Faravan selected counts',()=>{
  const opts={override:undefined,selected:()=>'/data/faravan/sbx',userHomes:['/home/me']};
  assert.equal(isPrivateSbxHome('/data/faravan/sbx',opts),true);
  assert.equal(isPrivateSbxHome('/home/me',opts),false);
  assert.equal(isPrivateSbxHome('/home/me/.sbx',opts),false);
  assert.equal(isPrivateSbxHome('/home/me/.docker',opts),false);
  assert.equal(isPrivateSbxHome('/elsewhere',opts),false);
  assert.equal(isPrivateSbxHome('relative/path',opts),false);
  assert.equal(isPrivateSbxHome(undefined,opts),false);
  assert.equal(isPrivateSbxHome('/custom/own',{...opts,override:'/custom/own'}),true);
  assert.equal(isPrivateSbxHome('/home/me',{...opts,override:'/home/me'}),false);
});
test('exactly one diagnostic event per removal, naming the provider and no secret',async()=>{
  for(const [job,provider] of [[claude,'anthropic'],[codex,'openai']]) {
    const state=store([row(provider)]);
    const events=[];
    await removeNativeProviderGlobalSecret(state.run,job,{privateHome:true,onDiagnostic:event=>events.push(event),now:()=>0});
    assert.equal(events.length,1);
    assert.equal(events[0].provider,provider);
    assert.equal(events[0].code,'legacy_provider_secret_removed');
    assert.equal(JSON.stringify(events).includes(CANARY),false);
  }
  const state=store([row('anthropic')],{stuck:true});
  const events=[];
  await assert.rejects(removeNativeProviderGlobalSecret(state.run,claude,{privateHome:true,onDiagnostic:event=>events.push(event)}));
  assert.equal(events.length,0,'no event when nothing was removed');
});
test('the app passes its diagnostic log to the backend',()=>{
  const app=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  assert.match(app,/backendOptions=\{[^}]*onDiagnostic:entry=>recordDiagnostic\(entry\)/);
});
