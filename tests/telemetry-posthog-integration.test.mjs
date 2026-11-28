import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {TELEMETRY_COPY} from '../lib/v1/telemetry/copy.mjs';
import {ownTempDir} from './helpers/temp-dir.mjs';
import {createBrowserTelemetry,sanitizeEvent,CONFIG_URL,INGEST_HOST,createBrowserTransport} from '../ui/v1/src/posthog.mjs';

const notice='Faravan sends usage data to PostHog for the Faravan team. Screen recordings are sent only if you turn them on. Turn this off in Settings → Your data.';
for(const release of ['61','62'])for(const level of ['counts','diagnostics','off'])test(`saved .${release} state with old ${level} waits for notice and preserves the choice`,{timeout:120000},async t=>{
 const f=await appFixture(t),home=await f.home('upgrade');
 cpSync(new URL(`./fixtures/upgrade/${release}/v1/`,import.meta.url),join(home,'v1'),{recursive:true});
 const dir=join(home,'v1','telemetry');mkdirSync(dir,{recursive:true});
 // Historical app fixtures did not capture telemetry. Add a labelled old-policy
 // variant, rather than claiming it came from the original fixture capture.
 writeFileSync(join(dir,'policy.json'),JSON.stringify({version:1,level,region:'US',generation:8,noticeShownAt:1,decidedAt:1}));
 let time=Date.UTC(2026,10,6);const events=[],requests=[];
 const transport=async(url,init)=>{requests.push(url);if(url.includes('/flags/'))return {status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})};events.push(...JSON.parse(gunzipSync(init.body)).batch);return {status:200,headers:new Headers(),body:{cancel:async()=>{}}};};
 const {app}=await f.start('upgrade',{home,version:'1.2.3',env:{...process.env,FARAVAN_NO_TELEMETRY:'0',DO_NOT_TRACK:'0'},clock:{now:()=>time},telemetryTransport:transport,telemetryOptions:{tripwire:async()=>null,random:()=>0}});
 const tel=app.telemetry;
 assert.equal((await api(app,'/api/telemetry/bootstrap')).noticePending,true);
 assert.equal(tel.observeFact('app_started',{}),false);
 await tel.flushNow();assert.deepEqual(requests,[]);assert.deepEqual(events,[]);assert.deepEqual(tel.preview().items,[]);
 assert.match(TELEMETRY_COPY.firstRun.body,/^Faravan sends usage data to help improve it\.$/);assert.equal(TELEMETRY_COPY.settings.intro,notice);
 await api(app,'/api/telemetry/notice',{method:'POST',body:{}});
 const boot=await api(app,'/api/telemetry/bootstrap');assert.equal(boot.consent,level==='off'?'off':'on');
 assert.equal(boot.noticePending,false);
 assert.equal(tel.observeFact('app_started',{}),false,'remote permission still required');
 await tel.flushNow();
 if(level==='off'){assert.deepEqual(requests,[]);assert.equal(boot.installId,null);}
 else {assert.equal(tel.observeFact('app_started',{}),true);time+=600001;await tel.flushNow();assert.ok(events.some(event=>event.event==='app_started'));assert.ok(events.every(event=>event.distinct_id===boot.installId));}
 // Loading and saving the old state must retain the fixture's limits.
 assert.equal(JSON.parse(readFileSync(join(home,'v1','app-settings.json'))).limits.dailyJobs,7);
});

for(const flag of ['missing','false','expired'])test(`server and browser reject remote flag ${flag}; fresh true uses only approved hosts`,async t=>{
 const dir=ownTempDir(t,'posthog-integrated-');let time=Date.UTC(2026,10,6),value=flag;const requests=[],events=[];
 const transport=async(url,init)=>{requests.push(url);if(url.includes('/flags/'))return {status:200,json:async()=>({flags:value==='missing'?{}:{'faravan-telemetry-enabled':{enabled:value==='true'}}})};events.push(...JSON.parse(gunzipSync(init.body)).batch);return {status:200,headers:new Headers(),body:{cancel:async()=>{}}};};
 const tel=createTelemetry({dir,base:dir,version:'1.2.3',env:{},now:()=>time,transport,tripwire:async()=>null,random:()=>0});t.after(()=>tel.close());await tel.markNoticeShown();
 if(flag==='expired'){value='true';await tel.flushNow();time+=900001;}
 else await tel.flushNow();
 let init=0;const browser=createBrowserTelemetry({sdk:{init(){init++;},capture(){},stopSessionRecording(){},opt_out_capturing(){}},transport:{stop(){},setAllowed(){}},now:()=>time,document:null});browser.connection(true);
 browser.bootstrap(tel.bootstrap());assert.equal(init,0);assert.equal(tel.observeFact('app_started',{}),false);assert.deepEqual(events,[]);
 value='true';time+=300001;await tel.flushNow();const boot=tel.bootstrap();assert.equal(boot.remoteEnabled,true);browser.bootstrap(boot);assert.equal(init,1);
 assert.equal(tel.observeFact('system_profile_observed',{os_type:'linux',$set:{os_type:'linux',arch:'amd64',cpu_class:'amd',ram_bucket:'32',app_version:'1.2.3',codex_plan:'pro'}}),true);
 assert.equal(tel.observeFact('system_profile_observed',{$set:{name:'PRIVATE'}}),false);
 assert.equal(tel.observeFact('system_profile_observed',{$set:{email:'PRIVATE'}}),false);
 time+=600001;await tel.flushNow();assert.ok(events.length>0);
 assert.ok(requests.every(url=>new URL(url).origin===INGEST_HOST));
 for(const event of events){assert.equal(event.distinct_id,boot.installId);assert.equal(event.properties.$geoip_disable,true);assert.doesNotMatch(JSON.stringify(event),/PRIVATE|hostname|\$ip|city|latitude|longitude/);}
 const clean=sanitizeEvent({event:'$pageview',properties:{name:'PRIVATE',email:'PRIVATE',hostname:'PRIVATE',path:'/PRIVATE',$ip:'PRIVATE',$set:{email:'PRIVATE'},screen:'home'}},boot.installId);
 assert.equal(clean.properties.distinct_id,boot.installId);assert.equal(clean.properties.$geoip_disable,true);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE|hostname|\$ip|\$set/);
 const urls=[];const network=createBrowserTransport({online:()=>true,fetcher:async url=>{urls.push(url);return {status:200,json:async()=>({})};}});network.setAllowed(true);
 network.send({url:CONFIG_URL,method:'GET'});network.send({url:CONFIG_URL+'.js',method:'GET'});network.send({url:INGEST_HOST+'/i/v0/e/',method:'POST',data:clean});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(urls,[CONFIG_URL,INGEST_HOST+'/i/v0/e/']);network.stop();browser.stop();
});

test('generated catalog preserves released enum history while adding telemetry members',async()=>{
 const {CATALOG,enumMembers}=await import('../lib/v1/telemetry/catalog.mjs');
 for(const [name,value,since] of [['error_type','confirmation_required',59],['error_type','hold_release_requested',59],['error_type','sandbox_cleanup_unverified',60],['op','lending.release_hold',59]]){
  assert.equal(CATALOG.enums[name].find(item=>item.value===value)?.since,since,`${name}.${value} keeps its released schema version`);
 }
 assert.ok(enumMembers('op',59).includes('lending.release_hold'),'released records remain readable');
 assert.equal(enumMembers('op').includes('lending.release_hold'),false,'current clients cannot emit the retired operation');
 assert.ok(CATALOG.enums.offer_reason.some(item=>item.value==='machine_capacity'));
});
