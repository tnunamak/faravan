import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserTelemetry, posthogConfig, sanitizeEvent, createBrowserTransport, INGEST_HOST, CONFIG_URL, LIMITS} from './posthog.mjs';
const id = 'f7c9f198-f634-419e-8617-59f82466d719';
const on = {installId:id,consent:'on',generation:1,remoteEnabled:true,noticePending:false};
function fixture() {
  const calls = [], sdk = {init(token, config){calls.push(['init',config]);},capture(...args){calls.push(['capture',...args]);},stopSessionRecording(){calls.push(['stop']);},opt_out_capturing(){calls.push(['off']);}};
  const transport = {send(){},stop(){calls.push(['abort']);},setAllowed(){}};
  return {calls, sdk, browser:createBrowserTelemetry({sdk,transport,now:()=>1000,document:null})};
}
test('OFF, remote stop and pending notice never initialize the SDK', () => {
  for (const state of [{...on,consent:'off'},{...on,remoteEnabled:false},{...on,noticePending:true}]) {
    const {calls,browser}=fixture(); browser.connection(true); browser.bootstrap(state); assert.equal(calls.filter(x=>x[0]==='init').length,0);
  }
});
test('ON initializes once and OFF stops locally before any later capture', () => {
  const {calls,browser}=fixture(); browser.connection(true); browser.bootstrap(on); browser.page('home');
  assert.equal(calls.filter(x=>x[0]==='init').length,1);
  assert.equal(browser.captureAllowed(),true);
  browser.stop(); browser.page('jobs');
  assert.equal(browser.captureAllowed(),false);
  assert.deepEqual(calls.slice(-3).map(x=>x[0]),['abort','stop','off']);
  assert.equal(calls.filter(x=>x[0]==='capture').length,1);
});
test('closed analytics properties drop title, URL, text, IP and extra identities', () => {
  const event=sanitizeEvent({event:'$pageview',properties:{$title:'PRIVATE_JOB_TITLE',$current_url:'https://private/?q=secret#secret',screen:'job',$ip:'secret',distinct_id:'wrong',$session_id:'019a1234-1234-7123-8123-123456789abc'}},id,'local');
  assert.equal(event.properties.distinct_id,id); assert.equal(event.properties.$geoip_disable,true);
  assert.equal(event.properties.screen,'job'); assert.doesNotMatch(JSON.stringify(event),/PRIVATE|secret|wrong|title|current_url/);
  assert.equal(sanitizeEvent({event:'unknown',properties:{}},id),null);
});
test('SDK config bundles replay, masks title and attributes and restricts autocapture', () => {
  const config=posthogConfig(id,()=>{});
  assert.equal(config.person_profiles,'always'); assert.equal(config.persistence,'memory');
  assert.equal(config.disable_external_dependency_loading,true); assert.notEqual(config.advanced_disable_flags,true);
  assert.equal(config.request_batching,false); assert.equal(config.disable_compression,true);
  assert.equal(config.session_recording.compress_events,false); assert.equal(config.session_recording.sampleRate,1); assert.equal(config.session_recording.maskAllInputs,true);
  assert.equal(config.session_recording.maskTextSelector,'*'); assert.equal(config.session_recording.maskAllElementAttributes,true);
  assert.ok(config.session_recording.blockSelector.includes('title'));
  assert.equal(config.session_recording.maskCapturedNetworkRequestFn({url:'https://private/?secret#private'}).url,'https://faravan.invalid/');
  assert.deepEqual(config.autocapture.css_selector_allowlist,['[data-telemetry-control]']);
});
test('transport permits only exact config JSON and ingestion, drops offline and aborts in flight', async () => {
  const requests=[];let finish;
  const transport=createBrowserTransport({fetcher:(url,options)=>{requests.push({url,options});return new Promise(resolve=>{finish=resolve;});},online:()=>true});
  transport.send({url:CONFIG_URL,method:'GET'}); assert.equal(requests.length,0);
  transport.setAllowed(true);
  transport.send({url:CONFIG_URL+'.js',method:'GET'}); transport.send({url:INGEST_HOST+'/flags/',method:'POST',data:{}});
  assert.equal(requests.length,0);
  transport.send({url:CONFIG_URL,method:'GET'}); assert.equal(requests.length,1);
  transport.stop(); assert.equal(requests[0].options.signal.aborted,true); finish({status:200,json:async()=>({})});
  const offline=createBrowserTransport({fetcher:()=>assert.fail('offline network'),online:()=>false}); offline.setAllowed(true);offline.send({url:CONFIG_URL,method:'GET'});
});
test('transport enforces 60 analytics/minute, pending bytes and replay daily bytes before compression', async () => {
  let now=0;const requests=[];
  const transport=createBrowserTransport({now:()=>now,online:()=>true,fetcher:async(url,options)=>{requests.push(options);return {status:200,json:async()=>({})};}});
  transport.setAllowed(true);
  const event={event:'$pageview',properties:{}};
  for(let i=0;i<61;i++)transport.send({url:INGEST_HOST+'/i/v0/e/',method:'POST',data:event});
  assert.equal(requests.length,60);await new Promise(resolve=>setImmediate(resolve));now=60001;
  transport.send({url:INGEST_HOST+'/i/v0/e/',method:'POST',data:event});assert.equal(requests.length,61);
  transport.send({url:INGEST_HOST+'/s/',method:'POST',data:{event:'$snapshot',properties:{$snapshot_data:'x'.repeat(LIMITS.pendingBytes)}}});assert.equal(requests.length,61);
  for(let i=0;i<22;i++){transport.send({url:INGEST_HOST+'/s/',method:'POST',data:{event:'$snapshot',properties:{$snapshot_data:'x'.repeat(500000)}}});await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(requests.length,81,'20 replay chunks fit below 10 MiB');
});

test('build stop prevents SDK initialization even with ON consent',()=>{
  let count=0;
  const browser=createBrowserTelemetry({enabled:false,sdk:{init(){count++;}},transport:{stop(){},setAllowed(){}}});
  browser.connection(true);browser.bootstrap(on);assert.equal(count,0);
});
test('15 active minutes stop replay; hidden time does not consume the cap',()=>{
  let now=0,stops=0;const document={visibilityState:'hidden',hasFocus:()=>true};
  const sdk={init(){},capture(){},stopSessionRecording(){stops++;}};
  const browser=createBrowserTelemetry({sdk,document,now:()=>now,transport:{stop(){},setAllowed(){}}});
  browser.connection(true);browser.bootstrap(on);
  for(let i=0;i<1000;i++){now+=1000;browser.tick();}assert.equal(stops,0);
  document.visibilityState='visible';for(let i=0;i<900;i++){now+=1000;browser.tick();}assert.equal(stops,1);
});
test('recorder and in-flight requests share the pending memory cap',async()=>{
  const {guardRecorder}=await import('./posthog.mjs');
  let options,appended=0;
  const transport=createBrowserTransport({online:()=>true,fetcher:(_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}))});
  transport.setAllowed(true);
  transport.send({url:INGEST_HOST+'/i/v0/e/',method:'POST',data:{event:'$pageview',properties:{padding:'x'.repeat(400000)}}});
  const record=guardRecorder(value=>{options=value;return ()=>{};},transport);
  record({emit(){appended++;}});
  options.emit({type:2,data:'x'.repeat(600000)});assert.equal(appended,1);
  options.emit({type:3,data:'x'.repeat(100000)});assert.equal(appended,1);
  transport.stop();
});

for (const transition of ['off-on','reset-id']) test('duration measurements are discarded across '+transition,()=>{
  let now=1000;const events=[],daily=new Map();
  const sdk={init(){},capture(event,properties){events.push({event,properties});},stopSessionRecording(){},opt_out_capturing(){}};
  const browser=createBrowserTelemetry({sdk,now:()=>now,document:{visibilityState:'visible',hasFocus:()=>true},storage:{getItem:key=>daily.get(key),setItem:(key,value)=>daily.set(key,value)},transport:{stop(){},setAllowed(){}}});
  browser.connection(true);browser.bootstrap(on);browser.page('home');browser.onboarding({flow:'borrowing',step:'joined'});
  now+=1000;browser.tick();
  if(transition==='off-on')browser.bootstrap({...on,consent:'off',installId:null,generation:2});
  now+=2000;
  browser.bootstrap({...on,installId:'e7c9f198-f634-419e-8617-59f82466d719',generation:3});
  // A tick immediately after the boundary must not count the pre-boundary gap.
  browser.tick();browser.page('jobs');browser.onboarding({flow:'borrowing',step:'reviewed'});
  assert.equal(events.findLast(item=>item.event==='screen_engagement').properties.visible_focused_ms,0);
  assert.equal(events.findLast(item=>item.event==='onboarding_step_changed' && item.properties.state==='exited').properties.elapsed_active_ms,0);
  assert.equal(JSON.parse(daily.get('faravan-replay-active')).ms,1000,'daily replay quota survives identity changes');
  now+=500;browser.tick();browser.page('home');browser.onboarding({flow:'borrowing',step:'joined'});
  assert.equal(events.findLast(item=>item.event==='screen_engagement').properties.visible_focused_ms,500);
  assert.equal(events.findLast(item=>item.event==='onboarding_step_changed' && item.properties.state==='exited').properties.elapsed_active_ms,500);
});

test('screen recording starts only when the person turned it on, and Off stops it with everything else', () => {
  const configs=[],calls=[];
  const sdk={init(_t,config){configs.push(config);},capture(){},startSessionRecording(){calls.push('start');},stopSessionRecording(){calls.push('stop');},opt_out_capturing(){calls.push('off');},opt_in_capturing(){}};
  const browser=createBrowserTelemetry({sdk,now:()=>1000,document:null,transport:{send(){},stop(){},setAllowed(){}}});
  browser.connection(true);
  browser.bootstrap(on);
  assert.equal(configs[0].disable_session_recording,true,'reports on without the recording choice never records');
  assert.equal(calls.includes('start'),false);
  browser.bootstrap({...on,generation:2,recordings:true});
  assert.equal(configs[1].disable_session_recording,false,'the recording choice starts it');
  browser.bootstrap({...on,consent:'off',generation:3,recordings:false});
  assert.equal(browser.captureAllowed(),false);
  assert.deepEqual(calls.slice(-2),['stop','off'],'reports Off stops recording and capture');
  browser.bootstrap({...on,generation:4});
  assert.equal(configs[2].disable_session_recording,true,'turning reports back on does not bring recording back');
});
