import './helpers/no-browser.mjs';
import test from 'node:test';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {JOB_DEFAULTS} from '../lib/v1/job-defaults.mjs';
import {LENDING_POLICY_DEFAULTS} from '../lib/v1/lending-policy.mjs';
import {appFixture,api,syntheticBackend} from './helpers/v1-app-fixture.mjs';

test('a fresh owner gets keep-more protection, and a saved balanced choice survives restart',{timeout:60000},async t=>{
 const f=await appFixture(t);
 let {app}=await f.start('dial-default');
 const fresh=await api(app,'/api/home');
 assert.equal(fresh.lending.limits.lendingPolicy.protectionPosition,'keep_more_for_me');
 await api(app,'/api/lending/limits',{method:'POST',body:{lendingPolicy:{protectionPosition:'balanced'},version:fresh.lending.configVersion}});
 await app.close();
 ({app}=await f.start('dial-default'));
 const restarted=await api(app,'/api/home');
 assert.equal(restarted.lending.limits.lendingPolicy.protectionPosition,'balanced');
});

test('upgrade startup migrates every legacy policy shape before validation and preserves owner choices',{timeout:60000},async t=>{
 const f=await appFixture(t);
 const legacyShapes=[
  ['protective',{preset:'unlikely_to_need',e0:0.5,fixedSharePct:20,keepPct:30,perJobPct:5,
   hourlyRatePct:2,tailHours:2,tailKeepPct:20,openKeepPct:50,activityThreshold:0.1,personWeeklyPct:12,
   recentActivityMinutes:60,forecast:true,resetKeepPct:10,nearResetHours:1,allowOpenWindow:false},'automatic','keep_more_for_me','on'],
  ['default-off',{e0:0.4,perJobPct:5},'automatic','keep_more_for_me','off'],
  ['legacy-default',{preset:'default',perJobPct:5},'automatic','keep_more_for_me','off'],
  ['explicit-balanced',{preset:'balanced',perJobPct:5},'automatic','balanced','off'],
  ['explicit-position-over-legacy-preset',{preset:'unlikely_to_need',protectionPosition:'balanced',perJobPct:5},'automatic','balanced','off'],
  ['generous',{preset:'lend_more',e0:0.3,perJobPct:10},'automatic','share_more','on'],
  ['fixed-share',{preset:'fixed_share',fixedSharePct:17,keepPct:31,perJobPct:5},'fixed_share','keep_more_for_me','on'],
  ['custom',{preset:'custom',e0:0.4,fixedSharePct:13,keepPct:42,perJobPct:5},'custom','keep_more_for_me','on'],
 ];
 const removedKeys=['preset','e0','fixedSharePct','keepPct','perJobPct','hourlyRatePct','tailHours','tailKeepPct',
  'openKeepPct','activityThreshold','recentActivityMinutes','forecast','resetKeepPct','nearResetHours','allowOpenWindow',
  'personWeeklyPct'];
 for(const [name,legacy,strategy,position,intent] of legacyShapes){
  const home=await f.home('upgrade-'+name),directory=join(home,'v1');
  await mkdir(directory,{recursive:true});
  const expiresAt=Date.now()+86400000;
  const rule={id:'preserve-rule',circle:'synthetic-circle',people:['sha256:person'],agents:['codex'],expiresAt,
   maxWallSeconds:1200,dailyJobs:3,weeklyJobs:21,dailyMinutes:60,weeklyMinutes:420,schedule:null};
  const saved={version:1,name:'Upgrade fixture',enabled:intent==='on',intent,activeCircle:null,
   agents:{codex:false},limits:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30,idleOnly:true,
    timeZone:'UTC',schedule:null,lendingPolicy:{...legacy,providerConsent:{claude:true,codex:false},
     accountPlans:{claude:'max20',codex:'pro'},watchOnlyUntil:expiresAt}},standingRules:[rule]};
  await writeFile(join(directory,'app-settings.json'),JSON.stringify(saved));
  let backendFactoryCalls=0;
  const backend=syntheticBackend(f.root);
  const {app}=await f.start('upgrade-'+name,{backend,backendFactory:async()=>{backendFactoryCalls++;return backend;}});
  assert.equal(backendFactoryCalls,1,`${name} legacy settings must reach backend creation`);
  const migrated=JSON.parse(await readFile(join(directory,'app-settings.json'),'utf8'));
  assert.equal(migrated.intent,intent,`${name} lending intent is unchanged`);
  assert.deepEqual(migrated.agents,{codex:false},`${name} agent choice is unchanged`);
  assert.deepEqual(migrated.standingRules,[rule],`${name} people, agents and rule expiry are unchanged`);
  assert.equal(migrated.limits.lendingPolicy.strategy,strategy,`${name} maps to its selected strategy`);
  assert.equal(migrated.limits.lendingPolicy.protectionPosition,position,name);
  if(strategy==='fixed_share')assert.deepEqual(migrated.limits.lendingPolicy.strategyParams,
   {fixedSharePct:17,keepPct:31,perJobPct:5},'fixed_share keeps its legacy numbers in typed strategy parameters');
  if(strategy==='custom')assert.deepEqual(migrated.limits.lendingPolicy.strategyParams,
   {e0:0.4,fixedSharePct:13,keepPct:42,perJobPct:5},'custom keeps its legacy numbers in typed strategy parameters');
  if(strategy==='automatic')assert.deepEqual(migrated.limits.lendingPolicy.strategyParams,
   {perJobPct:legacy.perJobPct??10},
   'automatic keeps the per-job percentage; deleted volume knobs do not become strategy settings');
  assert.equal(Object.hasOwn(migrated.limits.lendingPolicy,'providerConsent'),false,`${name} does not restore provider-wide consent`);
  assert.deepEqual(migrated.limits.lendingPolicy.accountPlans,{claude:'max20',codex:'pro'},`${name} account plans are unchanged`);
  assert.equal(migrated.limits.lendingPolicy.watchOnlyUntil,expiresAt,`${name} policy expiry is unchanged`);
  assert.deepEqual(Object.keys(migrated.limits.lendingPolicy).filter(key=>removedKeys.includes(key)),[],
   'all legacy volume controls are dropped');
  assert.equal(migrated.lendingPolicyMigration.fromLegacyPolicy,true);
  assert.equal(migrated.lendingPolicyMigration.acknowledged,false,'the one-time explanation remains visible until saved');
 }
});

test('policy settings save atomically and desktop observations are accepted', {timeout:60000},async t=>{
 const f=await appFixture(t),{app}=await f.start('policy');
 const home=await api(app,'/api/home');
 assert.equal(home.lending.limits.lendingPolicy.protectionPosition,'keep_more_for_me');
 await api(app,'/api/lending/limits',{method:'POST',body:{lendingPolicy:{protectionPosition:'share_more'},version:home.lending.configVersion}});
 const saved=await api(app,'/api/home');assert.equal(saved.lending.limits.lendingPolicy.protectionPosition,'share_more');
 await api(app,'/api/lending/limits',{method:'POST',body:{lendingPolicy:{e0:0.9}},status:400});
 assert.equal((await api(app,'/api/home')).lending.limits.lendingPolicy.protectionPosition,'share_more');
 await api(app,'/api/desktop/presence',{method:'POST',body:{idleSeconds:600}});
 assert.equal((await api(app,'/api/home')).ownerPresence.active,false);
 await api(app,'/api/desktop/presence',{method:'POST',body:{idleSeconds:-1},status:400});
 assert.ok(Array.isArray(saved.lendingPolicy.accounts));
});

test('scoped rules use the settings version and enable only circles with a live rule',{timeout:60000},async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
 const before=await api(lender.app,'/api/lending');
 const rule={id:'scoped',circle:circle.id,people:[owner.app.device.keyId],agents:['codex'],maxWallSeconds:1200,dailyJobs:3,weeklyJobs:12,dailyMinutes:60,weeklyMinutes:240,expiresAt:Date.now()+86400000};
 await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[rule],version:before.configVersion}});
 const saved=await api(lender.app,'/api/lending');assert.equal(saved.mode,'auto');assert.deepEqual(saved.standingRules,[{...rule,schedule:null}]);
 await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[],version:before.configVersion},status:409});
 assert.equal((await api(lender.app,'/api/lending')).standingRules.length,1);
 await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[],version:saved.configVersion}});
 assert.equal((await api(lender.app,'/api/lending')).mode,'ask');
});

test('fresh automatic rules have no picked daily, weekly or per-job wall cap',{timeout:60000},async t=>{
 const f=await appFixture(t),{lender,circle}=await f.connect();
 await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
 const before=await api(lender.app,'/api/lending');
 assert.deepEqual([before.limits.dailyJobs,before.limits.dailyMinutes,before.limits.maxWallSeconds],[null,null,null]);
 await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
 const automatic=await api(lender.app,'/api/lending');
 const rule=automatic.standingRules.find(row=>row.circle===circle.id);
 assert.ok(rule,'the automatic mode writes its standing rule');
 assert.deepEqual([rule.maxWallSeconds,rule.dailyJobs,rule.weeklyJobs,rule.dailyMinutes,rule.weeklyMinutes],[null,null,null,null,null]);
});

import {readFileSync} from 'node:fs';
import {boundedFetch, bounded} from './helpers/v1-app-fixture.mjs';
import {lenderDayKey} from '../lib/v1/lender.mjs';

test('concurrent limits saves with one base version have exactly one winner',{timeout:60000},async t=>{
  let hold=false,entered,release,second;
  const firstAudit=new Promise(resolve=>{entered=resolve;});
  const secondAudit=new Promise(resolve=>{second=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  let records=0;
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({decisionLog:()=>({
    async record(){if(!hold)return;if(++records===1){entered();await gate;}else second();}
  })});
  t.after(()=>release());
  await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
  const initial=await api(lender.app,'/api/lending');
  const rule={id:'race',circle:circle.id,people:[owner.app.device.keyId],agents:['codex'],
    maxWallSeconds:1200,dailyJobs:3,weeklyJobs:12,dailyMinutes:60,weeklyMinutes:240,expiresAt:Date.now()+86400000};
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[rule],version:initial.configVersion}});
  const before=await api(lender.app,'/api/lending');
  const post=async dailyJobs=>{
    const response=await boundedFetch(lender.app.origin+'/api/lending/limits',{method:'POST',
      headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},
      body:JSON.stringify({dailyJobs,version:before.configVersion})});
    return {status:response.status,body:await response.json(),dailyJobs};
  };
  hold=true;
  const first=post(4);
  await bounded(firstAudit,'first save held in decision persistence');
  const other=post(5);
  // Before the fix, the second save can enter auditing while the first is held.
  // With serialized CAS it must wait, so release after a bounded observation window.
  let timer;
  try{await Promise.race([secondAudit,new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}
  finally{clearTimeout(timer);release();}
  const results=await Promise.all([first,other]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=results.find(r=>r.status===200),loser=results.find(r=>r.status===409);
  assert.equal(loser.body.code,'config_changed');
  const saved=await api(lender.app,'/api/lending');
  assert.equal(saved.limits.dailyJobs,winner.dailyJobs);
  assert.equal(saved.configVersion,before.configVersion+1);
});

test('approval admission rolls yesterday usage over at Chicago midnight',async()=>{
  // Run the production acceptance gate with a lender snapshot deliberately left
  // on yesterday: a polling loop must not be needed to make midnight correct.
  const source=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const acceptance=source.slice(source.indexOf('  async function checkApprovalAcceptance('),source.indexOf('  async function approval(input)'));
  const usage=source.slice(source.indexOf('  function todayUsage('),source.indexOf('  // Who the running job'));
  assert.match(acceptance,/checkApprovalAcceptance/);assert.match(usage,/todayUsage/);
  let instant=Date.parse('2026-07-15T04:59:59Z'); // July 14, 23:59:59 in Chicago, not UTC midnight.
  const settings={limits:{timeZone:'America/Chicago',dailyJobs:3,dailyMinutes:60},requesterLimits:[]};
  const device={keyId:'lender-device'};
  const counters={day:lenderDayKey(instant,settings.limits.timeZone),jobs:2,milliseconds:55*60000};
  const identity={memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true};
  const check=new Function('settings','lender','now','lenderDayKey','jobReadiness','approvalIdentity','JOB_DEFAULTS','device','requesterCounterKey',
    usage+'\n'+acceptance+'\nreturn checkApprovalAcceptance;')(settings,{getState:()=>({counters})},()=>instant,lenderDayKey,
    async()=>({ready:true,protection:{}}),async()=>identity,JOB_DEFAULTS,device,(circle,key)=>circle+':'+key);
  const card={expiresAt:instant+3600000,identity,requester:'friend',harness:'codex',
    job:{circle:'test',requirements:{limits:{wall_seconds:600}}}};
  assert.equal((await check(card)).code,'daily_limit','yesterday has only five minutes left');
  instant+=2000;
  assert.notEqual(lenderDayKey(instant,settings.limits.timeZone),counters.day);
  assert.equal((await check(card)).code,null,'ten minutes fit after local midnight despite stale counters');
  counters.day=lenderDayKey(instant,settings.limits.timeZone);
  assert.equal((await check(card)).code,'daily_limit','today\'s usage still counts');
  counters.jobs=0;counters.milliseconds=0;
  card.job.requirements.limits.wall_seconds=3601;
  assert.equal((await check(card)).code,'daily_limit','a single job cannot exceed the new day cap');
});

test('the persistence queue compares the base version before computing either save',async()=>{
  // The outer HTTP queue can time out before its work stops. Exercise the real
  // limits route with both operations in flight, holding the first disk write.
  const source=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('  // The patch reaches memory'),source.indexOf('  const automaticReceipt'));
  const queue=source.slice(source.indexOf('  let settingsWrites='),source.indexOf('  const save='));
  const route=source.slice(source.indexOf("            if(parts[2]==='limits')"),source.indexOf("            if(parts[2]==='rules')"));
  assert.match(helpers,/saveThenApply/);assert.match(queue,/persistSettings/);assert.match(route,/config_changed/);
  const settings={configVersion:3,limits:{dailyJobs:3,lendingPolicy:{watchOnlyUntil:null}},standingRules:[]};
  let entered,release,written;
  const firstWrite=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  let writes=0;
  const deps={settings,settingsFile:'test-only',lender:null,policy:null,
    atomic:async(file,value)=>{if(++writes===1){entered();await gate;}written=structuredClone(value);},
    limits:(rest,previous)=>({...previous,...rest}),
    fail:(code,status)=>{throw Object.assign(new Error(code),{code,status});},
    auditedSettingsChange:work=>work([]),
    limitsChanged:(a,b)=>JSON.stringify(a)!==JSON.stringify(b),
    emit:()=>{},lendingView:()=>structuredClone(settings),readinessChanged:()=>{}};
  deps.lifetime=new AppLifetime();
  const save=new Function(...Object.keys(deps),queue+'\n'+helpers+
    '\nreturn async function(input){const parts={2:"limits"};\n'+route+'\n};')(...Object.values(deps));
  const first=save({version:3,dailyJobs:4});
  await firstWrite;
  const second=save({version:3,dailyJobs:5});
  release();
  const results=await Promise.allSettled([first,second]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const rejected=results.find(r=>r.status==='rejected');
  assert.equal(rejected?.reason.code,'config_changed');
  assert.equal(rejected?.reason.status,409);
  assert.equal(writes,1,'the rejected save never writes');
  assert.equal(settings.configVersion,4);
  assert.equal(settings.limits.dailyJobs,4);
  assert.deepEqual(written,settings);
});

test('rules CAS remains serialized after the outer HTTP timeout during auditing', {timeout:60000}, async t => {
  let hold = false, records = 0, entered, release, secondEntered;
  const firstAudit = new Promise(resolve => { entered = resolve; });
  const secondAudit = new Promise(resolve => { secondEntered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await appFixture(t), {owner,lender,circle} = await f.connect({
    mutationTimeoutMs: 1500,
    decisionLog: () => ({ async record() {
      if (!hold) return;
      if (++records === 1) { entered(); await gate; } else secondEntered();
    } })
  });
  t.after(() => release());
  await api(lender.app, '/api/lending/circle', {method:'POST',body:{circle:circle.id}});
  const before = await api(lender.app, '/api/lending');
  const rule = {id:'timeout-race',circle:circle.id,people:[owner.app.device.keyId],agents:['codex'],
    maxWallSeconds:1200,dailyJobs:3,weeklyJobs:12,dailyMinutes:60,weeklyMinutes:240,
    expiresAt:Date.now()+86400000};
  const post = async dailyJobs => {
    const response = await boundedFetch(lender.app.origin+'/api/lending/rules', {method:'POST',
      headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},
      body:JSON.stringify({rules:[{...rule,dailyJobs}],version:before.configVersion})});
    return {status:response.status,body:await response.json()};
  };
  hold = true;
  const first = post(4);
  await bounded(firstAudit, 'first rules audit');
  assert.equal((await first).status, 504, 'real HTTP lane times out while the audit is still held');
  const second = post(5);
  let timer;
  try { await Promise.race([secondAudit,new Promise(resolve => {timer=setTimeout(resolve,150);})]); }
  finally {clearTimeout(timer);release();}
  const other = await second;
  assert.equal(other.status, 409, 'second same-version operation cannot commit');
  assert.equal(other.body.code, 'config_changed');
  const {waitFor} = await import('./helpers/v1-app-fixture.mjs');
  const saved = await waitFor(async () => {
    const current = await api(lender.app, '/api/lending');
    return current.configVersion > before.configVersion ? current : null;
  }, 'first timed-out operation finishes its single durable save');
  assert.equal(saved.configVersion, before.configVersion+1);
  assert.equal(saved.standingRules[0].dailyJobs, 4);
  assert.equal(records, 1, 'stale loser never writes a grant audit');
});

test('rules audit/save failures keep receipts not-applied and leave the settings queue usable', async () => {
  const source=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('  const recordRuleDecisions='),source.indexOf('  const automaticReceipt='));
  const queue=source.slice(source.indexOf('  let settingsWrites='),source.indexOf('  const save='));
  const route=source.slice(source.indexOf("            if(parts[2]==='rules')"),source.indexOf("            if(parts[2]==='mode')"));
  assert.match(helpers,/markNotApplied/);assert.match(route,/persistSettings/);
  for (const failure of ['audit','save']) {
    const settings={configVersion:3,standingRules:[],modes:{circle:'ask'},activeCircle:'circle'};
    const initial=structuredClone(settings),policy={standingRules:[],mode:'ask'},events=[];
    let broken=true,records=0,writes=0,sequence=0;
    const deps={settings,policy,settingsFile:'test-only',now:()=>1000000,clone:structuredClone,
      randomUUID:()=>String(++sequence),decider:()=>({deviceKey:'owner'}),
      decisions:{async record(row){
        if(broken&&failure==='audit'&&!row.supersedes&&++records===2)throw new Error('audit failed');
        events.push(structuredClone(row));
      }},
      atomic:async()=>{writes++;if(broken&&failure==='save')throw new Error('save failed');},
      validateStandingRules:rules=>rules,device:{selectCircle:async()=>({id:'circle'}),listCircles:async()=>[]},
      fail:(code,status)=>{throw Object.assign(new Error(code),{code,status});},
      lendingView:()=>structuredClone(settings)};
    deps.lifetime=new AppLifetime();
    const save=new Function(...Object.keys(deps),queue+'\n'+helpers+
      '\nreturn async function(input){const parts={2:"rules"};\n'+route+'\n};')(...Object.values(deps));
    await assert.rejects(save({version:3,rules:[
      {id:'one',circle:'circle',expiresAt:2000000},
      {id:'two',circle:'circle',expiresAt:2000000}
    ]}),new RegExp(failure+' failed'));
    assert.deepEqual(settings,initial);assert.deepEqual(policy,{standingRules:[],mode:'ask'});
    const receipts=events.filter(row=>!row.supersedes),notApplied=events.filter(row=>row.applied===false);
    assert.equal(receipts.length,failure==='audit'?1:2);
    assert.deepEqual(notApplied.map(row=>row.supersedes).sort(),receipts.map(row=>row.id).sort());
    assert.ok(notApplied.every(row=>row.reason===(failure==='audit'?'audit_failed':'save_failed')));
    assert.equal(writes,failure==='audit'?0:1);
    broken=false;
    await bounded(save({version:3,rules:[]}), 'queue recovers after '+failure);
    assert.equal(settings.configVersion,4);
  }
});

test('a timed-out older mode edit cannot overwrite a later frozen rules save', {timeout:60000}, async t => {
  let hold=false, firstEntered, release, laterEntered, records=0;
  const entered=new Promise(resolve=>{firstEntered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const laterAudit=new Promise(resolve=>{laterEntered=resolve;});
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({
    mutationTimeoutMs:1500,decisionLog:()=>({async record(){
      if(!hold)return;
      if(++records===1){firstEntered();await gate;}else laterEntered();
    }})});
  t.after(()=>release());
  await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
  const rule={id:'frozen-cross-route',circle:circle.id,people:[owner.app.device.keyId],agents:['codex'],
    maxWallSeconds:1200,dailyJobs:3,weeklyJobs:12,dailyMinutes:60,weeklyMinutes:240,expiresAt:Date.now()+86400000};
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[rule]}});
  const before=await api(lender.app,'/api/lending');
  const post=async(path,body)=>{
    const r=await boundedFetch(lender.app.origin+path,{method:'POST',
      headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  hold=true;
  const older=post('/api/lending/mode',{circle:circle.id,mode:'ask'});
  await bounded(entered,'older mode revoke audit');
  assert.equal((await older).status,504);
  const desired={...before.standingRules[0],dailyJobs:2,expiresAt:rule.expiresAt-1000};
  const newer=post('/api/lending/rules',{rules:[desired]});
  let timer;
  try{await Promise.race([laterAudit,new Promise(resolve=>{timer=setTimeout(resolve,150);})]);}
  finally{clearTimeout(timer);release();}
  assert.equal((await newer).status,200);
  const {waitFor}=await import('./helpers/v1-app-fixture.mjs');
  const final=await waitFor(async()=>{
    const s=await api(lender.app,'/api/lending');
    return s.standingRules.length===0||s.configVersion>=before.configVersion+2?s:null;
  },'both serialized durable edits finish');
  assert.deepEqual(final.standingRules,[desired],'older timeout continuation cannot revoke or widen the newer frozen rule');
  assert.equal(final.configVersion,before.configVersion+2);
});
