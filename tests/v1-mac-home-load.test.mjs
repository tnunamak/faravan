import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

register(new URL('./helpers/mac-home-instrument.mjs',import.meta.url));
const {appFixture,api} = await import('./helpers/v1-app-fixture.mjs');
const {macPriceCatalogs} = await import('./helpers/mac-price-catalogs.mjs');
const {setLiveListPrices,currentPriceCatalog} = await import('../lib/v1/lending-meter.mjs');
const {DockerSbxBackend} = await import('../lib/docker-backend.mjs');
const {createSbxPolicy,sbxRunner} = await import('./helpers/sbx-policy-model.mjs');
const exec = promisify(execFile), sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

for (const shape of ['stored49','raw4554']) test('seven HTTP pollers and real workspace preparation: '+shape,{timeout:90000},async t=>{
  const f=await appFixture(t);
  const {app}=await f.start('mac-home-'+shape,{autostart:{status:async()=>{await sleep(10);return {supported:false};}}});
  const oldHome=process.env.FARAVAN_SBX_HOME,oldScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=join(f.root,'sbx');process.env.FARAVAN_SCRATCH_ROOT=join(f.root,'scratch');
  t.after(()=>{
    if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;
    if(oldScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldScratch;
    delete globalThis.__macHomeCalls;setLiveListPrices({});
  });
  const catalogs=macPriceCatalogs(), selected=shape==='stored49'?catalogs.stored:catalogs.merged;
  setLiveListPrices(selected.data.list_usd);
  const n=Object.keys(currentPriceCatalog().data.list_usd).length;
  assert.equal(n,49);
  let counts={},penaltyMs=0;
  globalThis.__macHomeCalls={hit(name){
    counts[name]=(counts[name]??0)+1;
    if(name==='lookupPriceRow'&&penaltyMs){const end=performance.now()+penaltyMs;while(performance.now()<end){}}
  }};
  await api(app,'/api/home');
  const cold={...counts};counts={};
  // Model the slower Mac CPU in this exact profiled function, independently of cache mechanics.
  // The unmodified path performs hundreds of calls per home view; warm memos perform none.
  penaltyMs=0.35;
  const policy=createSbxPolicy(),stub=sbxRunner(policy),active=new Set(),delays=[],commands=[];
  const backend=new DockerSbxBackend({home:join(f.root,'backend'),hostDisk:{free:async()=>({free:64*1024**3})},
    storage:{available:async()=>false,supported:async()=>false,release:async()=>{}},runCommand:async(args,options)=>{
      commands.push({at:performance.now(),command:args.slice(0,3)});
      // A real child reports when it exits; collection latency belongs to the app's main thread.
      const {stdout}=await exec(process.execPath,['-e','process.stdout.write(String(Date.now()))'],{signal:options?.signal});
      delays.push(Date.now()-Number(stdout));
      if(args[0]==='run')active.add(args[args.indexOf('--name')+1]);
      if(args[0]==='rm')active.delete(args.at(-1));
      if(args[0]==='ls')return {code:0,stdout:JSON.stringify([...active].map(name=>({name,status:'running'}))),stderr:''};
      return stub.run(args,options);
    }});
  const pending=new Set(),waves=[];
  let requests=0;
  const poll=()=>{
    requests+=7;
    const wave=Promise.all(Array.from({length:7},(_,i)=>api(app,i===6?'/api/status':'/api/home')));
    pending.add(wave);waves.push(wave);wave.then(()=>pending.delete(wave),()=>pending.delete(wave));
  };
  const elu=performance.eventLoopUtilization(),started=performance.now();
  poll();const timer=setInterval(poll,1000);t.after(()=>clearInterval(timer));
  let preparedAt=null;
  const prepare=backend.prepare.bind(backend);
  backend.prepare=async(...args)=>{const handle=await prepare(...args);preparedAt=performance.now();return handle;};
  const workspace=backend.testWorkspace({harnessName:'claude-code-subscription'});
  await sleep(4500);clearInterval(timer);
  await Promise.all(waves);const result=await workspace;
  const elapsed=performance.now()-started,busy=performance.eventLoopUtilization(elu).utilization;
  const perHome=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value/(counts.homeView??1)]));
  const create=commands.find(row=>row.command[0]==='run');
  t.diagnostic(JSON.stringify({shape,models:n,rawRows:catalogs.rawRows,convertedRows:catalogs.convertedRows,rawBytes:catalogs.rawBytes,
    requests,homeViews:counts.homeView,coldCalls:cold,calls:counts,callsPerHome:perHome,busy_fraction:busy,
    callback_max_ms:Math.max(...delays),prepare_ms:preparedAt===null?null:preparedAt-started,
    before_create_ms:create?create.at-started:null,total_ms:elapsed,workspace:result}));
  assert.equal(result.ok,true,'real DockerSbxBackend.prepare must finish its workspace');
  assert.ok(preparedAt-started<10000,'preparation must finish well inside its 240-second deadline');
  assert.ok(Math.max(...delays)<1000,'completed children must be collected within one second');
  assert.ok(busy<0.5,'polling should leave most of the event loop idle');
  assert.ok(counts.homeView<requests,'overlapping home/status requests must share work');
  assert.equal(counts.calculateWorstCallUsd??0,0,'warm catalogs must not recalculate price-derived bounds');
});
