import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startApp} from '../lib/v1/app.mjs';
import {DockerSbxBackend,_internal} from '../lib/docker-backend.mjs';
import {createLender,createLenderCounterStorage} from '../lib/v1/lender.mjs';
import {sbxOwnerFile} from '../lib/sbx-daemon-owner.mjs';
import {syntheticBackend,api,waitFor} from './helpers/v1-app-fixture.mjs';

const fixtures=new URL('./fixtures/upgrade/',import.meta.url);
function env(t,key,value){const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}
const json=async file=>JSON.parse(await readFile(file,'utf8'));
// 71f83df88: lending is authorized from the agent toggles. A saved policy's providerConsent is still accepted on load, but it
// authorizes nothing and is neither kept in the loaded policy nor written back. Every other saved field must survive.
const withoutProviderConsent=policy=>{const {providerConsent:_retired,...rest}=policy;return rest;};
async function copyFixture(t,version) {
 const root=await mkdtemp('/tmp/u'+version+'-');
 const apps=[];
 t.after(async()=>{for(const app of apps)await app.close();await rm(root,{recursive:true,force:true});});
 const home=join(root,'data');await cp(new URL(version+'/',fixtures),home,{recursive:true});
 // Rebase captured throwaway locations, retaining every stored field and shape.
 for(const key of ['HOME','FARAVAN_HOME','FARAVAN_HOME','FARAVAN_DATA_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','FARAVAN_COORDINATOR_HOME','FARAVAN_COORDINATOR_HOME'])env(t,key,home);
 env(t,'FARAVAN_SCRATCH_ROOT',join(root,'scratch'));
 env(t,'TZ','America/Chicago');
 const bin=join(root,'bin');await mkdir(bin);await mkdir(join(root,'scratch'));
 for(const command of ['sbx','docker'])await writeFile(join(bin,command),'#!/bin/sh\nexit 97\n',{mode:0o755});
 env(t,'PATH',bin+':'+process.env.PATH);
 for(const file of ['v1/app-counters.json',...(await readdir(join(home,'cleanup'))).map(name=>'cleanup/'+name)]){
  const target=join(home,file);await writeFile(target,(await readFile(target,'utf8')).replaceAll('@ROOT@',root));
 }
 if(version==='62')await writeFile(sbxOwnerFile(),(await readFile(join(home,'sandbox-owner.json'),'utf8')).replaceAll('@ROOT@',root));
 return {root,home,apps,settings:join(home,'v1/app-settings.json'),counters:join(home,'v1/app-counters.json')};
}
async function boot(t,f,extra={}) {
 const backend=syntheticBackend(f.root);
 const app=await startApp({home:f.home,port:0,freshLending:'off',adapters:[],backendFactory:async()=>backend,
  signInProbe:async()=>({signedIn:null}),lendingSignInProbe:async()=>({signedIn:null}),
  identityProbe:async()=>({providers:[]}),lendingIdentityProbe:async()=>({providers:[]}),
  autostart:{status:async()=>({supported:false,enabled:false})},...extra});
 f.apps.push(app);return app;
}
for(const version of ['59','60','61','62']) {
 test('.'+version+' U4: every saved setting survives startup and save/load',{timeout:30000},async t=>{
  const f=await copyFixture(t,version),before=await json(f.settings);
  for(const field of ['dailyJobs','dailyMinutes','maxWallSeconds','quotaReserve','timeZone','schedule','lendingPolicy'])assert.notEqual(before.limits?.[field],undefined,'.'+version+' fixture must hold settings.limits.'+field);
  assert.ok(Object.keys(before.limits).length>=7,'.'+version+' fixture settings must be non-empty');
  let app=await boot(t,f);
  for(const cycle of ['load','save/load']) {
   if(cycle==='save/load') {
    // A supported save of one unrelated field must not rewrite the rest.
    await api(app,'/api/lending/limits',{method:'POST',body:{dailyMinutes:before.limits.dailyMinutes}});
   }
   const loaded=(await api(app,'/api/lending')).limits,after=await json(f.settings);
   for(const [field,value] of Object.entries(before.limits)) {
    const kept=field==='lendingPolicy'?withoutProviderConsent(value):value;
    assert.deepEqual(loaded[field],kept,'.'+version+' '+cycle+' loaded settings.limits.'+field);
    assert.deepEqual(after.limits[field],kept,'.'+version+' '+cycle+' saved settings.limits.'+field);
   }
   assert.equal(Object.hasOwn(loaded.lendingPolicy,'providerConsent'),false,'.'+version+' '+cycle+' the retired consent is not loaded');
   assert.equal(Object.hasOwn(after.limits.lendingPolicy,'providerConsent'),false,'.'+version+' '+cycle+' the retired consent is not written back');
   for(const field of ['name','intent','enabled'])assert.deepEqual(after[field],before[field],'.'+version+' '+cycle+' settings.'+field);
   const phones=await api(app,'/api/phone');
   assert.ok(JSON.stringify(phones).includes('Fixture device'),'.'+version+' paired device survives '+cycle);
   await app.close();
   if(cycle==='load')app=await boot(t,f);
  }
  // Restart once more after the supported save and compare the loaded values again.
  app=await boot(t,f);
  const loaded=(await api(app,'/api/lending')).limits;
  for(const [field,value] of Object.entries(before.limits))assert.deepEqual(loaded[field],field==='lendingPolicy'?withoutProviderConsent(value):value,'.'+version+' restart after save loaded settings.limits.'+field);
 });
 for(const variant of ['','-false','-mixed']) test('.'+version+' U5: rejected policy preserves consent and every valid field'+(variant?' ('+variant.slice(1)+' consent)':''),{timeout:30000},async t=>{
  const f=await copyFixture(t,version);await cp(join(f.home,'invalid-policy'+variant+'.json'),f.settings);
  const before=await json(f.settings);let app=await boot(t,f);
  const consent=before.limits.lendingPolicy.providerConsent,label='.'+version+(variant||'')+' ';
  assert.ok(consent&&typeof consent==='object','fixture '+label+'holds the retired saved consent');
  for(const cycle of ['load','save/load']) {
   const after=await json(f.settings),old=before.limits.lendingPolicy;
   for(const [field,value] of Object.entries(old))if(!['warningPct','providerConsent'].includes(field))assert.deepEqual(after.limits.lendingPolicy[field],value,label+cycle+' policy.'+field);
   // 71f83df88: the saved consent authorizes nothing. Neither the saved file, the loaded policy nor the notice carries it, so
   // migration can never grant one; the repair holds lending off until the owner turns it on again.
   const loadedPolicy=(await api(app,'/api/lending')).limits.lendingPolicy,notice=after.lendingPolicyMigration,loadedConsent=loadedPolicy.providerConsent;
   // The only invalid field is warningPct=150; it is repaired to the default 10, in the saved file and in the loaded policy.
   assert.equal(after.limits.lendingPolicy.warningPct,10,label+cycle+' saved policy.warningPct is repaired');
   assert.equal(loadedPolicy.warningPct,10,label+cycle+' loaded policy.warningPct is repaired');
   for(const [field,value] of Object.entries(old))if(!['warningPct','providerConsent'].includes(field))assert.deepEqual(loadedPolicy[field],value,label+cycle+' loaded policy.'+field);
   for(const [where,active] of [['saved',after.limits.lendingPolicy.providerConsent],['loaded',loadedConsent]])
    assert.equal(active,undefined,label+cycle+' '+where+' policy carries no provider consent, so migration granted none');
   assert.equal(Object.hasOwn(notice??{},'consentWas'),false,label+cycle+' the notice keeps no retired consent');
   assert.equal(after.intent,'off',label+cycle+' a repaired policy holds lending off');
   assert.equal(notice?.acknowledged,false,label+'rejected warningPct has an unacknowledged notice');
   assert.ok(notice?.reset?.some(row=>row.field==='warningPct'&&row.was===150),label+'notice preserves warningPct=150');
   await app.close();if(cycle==='load')app=await boot(t,f);
  }
 });
 test('.'+version+' U2: account-only stored journals reach the update gate',{timeout:30000},async t=>{
  const f=await copyFixture(t,version),captured=await json(f.counters);let ticks=[];
  const app=await boot(t,f,{updater:{kind:'tarball',startDelayMs:1,intervalMs:20,tick:async({idle})=>{ticks.push(idle);return null;}}});
  for(const field of ['pending','claimPending','claimedPending','acceptedClaim','outputPending','resultPending','declinePending','stoppedPending'])await t.test(field,async()=>{
   const state=structuredClone(captured),row=state.accounts['codex:0'],pending=row.pending;delete row.pending;row[field]=pending;
   // Same old writer shape, selecting each durable journal reader independently.
   await writeFile(f.counters,JSON.stringify(state));ticks=[];
   await waitFor(()=>ticks.length>0,'.'+version+' updater tick for '+field);
   assert.equal(ticks[0],false,'.'+version+' accounts.codex:0.'+field+' must block updates');
  });
  await writeFile(f.counters,JSON.stringify({jobs:0,milliseconds:0,accounts:{}}));ticks=[];
  await waitFor(()=>ticks.length>0,'.'+version+' clear counter control');assert.equal(ticks[0],true,'.'+version+' clear counters allow updates');
  await app.close();
 });
 // .62 pending rows are scoped and resolved through the cleanup journal's own create receipt, not a listing or process scan,
 // so its fail-closed case is an owner that does not match this installation.
 for(const scenario of version==='62'?['readable','ambiguous owner']:['readable','unreadable listing','incomplete process scan','ambiguous daemon'])
 test('.'+version+' U1: '+(scenario==='readable'?'absent sandbox recovery clears pending and charges its reservation':'fail-closed, '+scenario+' keeps the hold'),{timeout:30000},async t=>{
  const f=await copyFixture(t,version),captured=await json(f.counters),pending=captured.accounts['codex:0'].pending;
  if(scenario==='ambiguous owner')pending.owner_scope='unrelated-installation';
  if(version==='62')env(t,'FARAVAN_SBX_HOME',f.root);
  const closed=scenario!=='readable',label='.'+version+' '+scenario+': ';
  const homeSelection={home:_internal.sbxHome(),migration:null};
  const runCommand=async args=>args[0]==='ls'?(scenario==='unreadable listing'?{code:1,stdout:'',stderr:'daemon unavailable'}:{code:0,stdout:'[]',stderr:''}):args[0]==='daemon'?{code:0,stdout:'Status: running',stderr:''}:{code:0,stdout:'',stderr:''};
  const daemons=scenario==='ambiguous daemon'?[{pid:123,environ:{HOME:homeSelection.home}},{pid:124,environ:{HOME:homeSelection.home}}]:[{pid:123,environ:{HOME:homeSelection.home}}];
  const backend=new DockerSbxBackend({home:f.home,storage:{release:async()=>{}},cleanupDirectory:join(f.home,'cleanup'),runCommand,
   legacyDaemonOptions:{platformName:'linux',selectHome:()=>homeSelection,inspectDaemons:async()=>daemons,
    isProcessAlive:()=>true,inspectProcesses:async()=>({complete:scenario!=='incomplete process scan',references:[]})}});
  // .62 wrote scoped records. Relocation supplies the same captured HOME to the backend.
  const proof=await backend.reconcilePending(pending,{sourceDirectory:join(f.home,'v1')});
  if(closed)assert.notEqual(proof.removed,true,label+'unverified cessation is not proof: '+JSON.stringify(proof));
  else {
   assert.equal(proof.removed,true,label+'pending sandbox absent: '+JSON.stringify(proof));
   assert.equal(proof.sbx_home,_internal.sbxHome(),label+'recovery.sbx_home must reach the lender');
  }
  const storage=createLenderCounterStorage(f.counters);
  const release=await storage.acquire();try{await storage.set({...captured.accounts['codex:0'],day:'2099-12-31',jobs:1,milliseconds:pending.reservedMs});}finally{await release();}
  const controller=new AbortController(),calls=[];  t.after(()=>controller.abort());
  const worker=createLender({backend,clock:{now:()=>4102444800000-1},policy:{storage,enabled:false,timeZone:'UTC'},adapters:[],
   client:{release:async(...a)=>{calls.push(['release',a]);},stopped:async(...a)=>{calls.push(['stopped',a]);},offers:async()=>[]},onPoll:()=>{if(!closed)controller.abort();}});
  const running=worker.start(controller.signal);t.after(()=>running);
  if(closed) {
   await new Promise(resolve=>setTimeout(resolve,1500));controller.abort();await running;
   const held=await storage.get();
   assert.deepEqual(held.pending,pending,label+'pending hold remains unchanged');
   assert.equal(held.milliseconds,pending.reservedMs,label+'reservation neither released nor re-charged');
   assert.deepEqual(calls,[],label+'no settle or release was called');
   return;
  }
  await waitFor(async()=>!(await storage.get())?.pending,label+'pending hold settled');
  controller.abort();await running;
  const after=await storage.get();assert.equal(after.pending,null,label+'recovered pending cleared');
  assert.equal(after.milliseconds,pending.reservedMs,label+'full reservation stays charged after recovery');
 });
}
