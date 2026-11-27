import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {join,basename} from 'node:path';
register(new URL('./helpers/mac-ui-instrument.mjs',import.meta.url));
const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
const p=await import('../lib/protocol/index.mjs');
const {json}=await import('./helpers/v1-journey.mjs');
const {visibleInterval}=await import('../ui/v1/src/display-visibility.mjs');
const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
const {createSbxPolicy,sbxRunner}=await import('./helpers/sbx-policy-model.mjs');
const {createMeasurementHistory}=await import('../lib/v1/event-history.mjs');
const {passingRecord}=await import('./helpers/credential-probe-fixture.mjs');
const {getHarnessAdapter}=await import('../lib/harnesses/index.mjs');
const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// The base replay uses the base server sources and the unconditional periodic timers shipped at that revision.
const before=process.env.MAC_UI_BASE_REPLAY==='1';
test('Mac data and all display routes leave consecutive preparation steps responsive',{timeout:180000},async t=>{
  const f=await appFixture(t),firstApp=await f.start('mac-ui',{pollMs:30000}),home=firstApp.home;let app=firstApp.app;
  const memberProfiles=new Map();
  const previous=f.override;f.override=async ctx=>{if(ctx.route==='/presence'){json(ctx.res,{now:new Date().toISOString().slice(0,19)+'Z',online_seconds:90,devices:(f.circles.get(ctx.circleId)?.roster?.payload.members??[]).map(m=>({device:m.key_id,member_capabilities:['circle_profile_v1','circle_people_v1','circle_authority_v1'],...(memberProfiles.has(m.key_id)?{member_profile:memberProfiles.get(m.key_id)}:{}),online:false})),persons:[]});return true;}return previous(ctx);};
  await f.provisionFromHome('mac-ui');
  const circle=await api(app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Synthetic Mac circle'}});
  const sender=await f.start('mac-sender',{pollMs:30000});
  const invite=(await api(app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}})).invite;
  await api(sender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await sender.app.device.refreshRoster(circle.id);
  for(let i=0;i<3;i++)await app.device.updateCircleProfile(circle.id,{name:'Synthetic Mac '+i,purpose:'.'.repeat(200)});
  await app.device.refreshRoster(circle.id);

  for(let i=0;i<12;i++){
    const row=await api(i<6?app:sender.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Fixture '+i+' '+'.'.repeat(800),harness:'codex',send_anyway:true}});
    f.jobs.get(row.jobDigest).state='expired';
  }
  await sleep(100);
  const dir=join(home,'v1'),cdir=join(dir,'circles',circle.id);
  const pad=async(file,target)=>{const value=JSON.parse(await readFile(file,'utf8'));value.fixturePadding='.'.repeat(Math.max(0,target-Buffer.byteLength(JSON.stringify(value))-24));await writeFile(file,JSON.stringify(value));};
  const metadata=JSON.parse(await readFile(join(dir,'job-meta.json'),'utf8')),sample=Object.values(metadata)[0];
  for(const id of f.jobs.keys())metadata[id]??={...sample,title:'Synthetic received history',prompt:'',circle:circle.id};
  await writeFile(join(dir,'job-meta.json'),JSON.stringify(metadata));
  await pad(join(cdir,'intents.json'),54000);await pad(join(dir,'job-meta.json'),14500);

  const epoch=(await app.device.rosterCache(circle.id).get()).current.payload.epoch;
  for(const actor of [app,sender.app]) {
    const body={capabilities:['member_profile_v1'],profile:{person_name:'Synthetic person',revision:1}};
    const proof=p.buildRequestProof({circle:circle.id,roster_epoch:epoch,method:'POST',target:f.origin+'/v1/circles/'+circle.id+'/heartbeat',body:Buffer.from(p.canonicalize(body)),content_type:'application/json',artifact_media_type:'',idempotency_key:randomUUID(),created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},actor.device.deviceKey,{lanMode:true});
    memberProfiles.set(actor.device.keyId,{body,proof});
  }
  await writeFile(join(cdir,'member-profiles.json'),JSON.stringify(Object.fromEntries(memberProfiles)));
  await pad(join(cdir,'member-profiles.json'),3900);
  // These are valid empty display stores with the Mac's byte sizes, not copied user records.
  const events=Array.from({length:60},(_,i)=>({kind:'run',circle:circle.id,keyId:sender.app.device.keyId,jobDigest:[...f.jobs.keys()][i%12],attemptId:'fixture-'+i,at:Date.now()-i*1000,title:'Synthetic history row',agent:'codex'}));
  await writeFile(join(dir,'contributions.json'),JSON.stringify({version:1,events}));await pad(join(dir,'contributions.json'),30000);
  const evidence=Array.from({length:16},()=>passingRecord(getHarnessAdapter('codex')));
  evidence[0].fixturePadding='.'.repeat(Math.max(0,37000-Buffer.byteLength(JSON.stringify(evidence))-24));
  await writeFile(join(dir,'credential-evidence.json'),JSON.stringify(evidence));
  await app.close();
  // Replay the existing capped writer unchanged; its separate fix is PR 265.
  const seed=createMeasurementHistory({directory:join(f.root,'seed')});seed.record('observation_completed',{resources:[]});seed.record('observation_completed',{resources:[{used_micro:10000000,kappa_micro:1000000,duration_ms:604800000,observed_at:Date.now(),resets_at:Date.now()+86400000}]});await seed.flush();seed.close();
  const templates=(await readFile(join(seed.directory,'measurements.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const cap=16*1024*1024,lines=[];let historyBytes=0;
  for(let i=1;;i++){const line=JSON.stringify({...templates[i%templates.length],event_id:randomUUID(),sequence:i})+'\n';if(historyBytes+Buffer.byteLength(line)>cap)break;lines.push(line);historyBytes+=Buffer.byteLength(line);}
  const historyRoot=join(dir,'history','measurements');await mkdir(historyRoot,{recursive:true});await writeFile(join(historyRoot,'measurements.jsonl'),lines.join(''));
  const history=createMeasurementHistory({directory:join(dir,'history')});
  app=(await f.start('mac-ui',{pollMs:30000,lendingPace50:{measurementHistory:history}})).app;
  await history.flush();
  const names=await app.device.memberNames(circle.id,{refresh:false});
  assert.equal([...names.values()].filter(name=>name==='Synthetic person').length,2);
  if(!before)assert.deepEqual(await app.device.displaySnapshot().memberNames(circle.id),names);
  const files={};for(const file of ['job-meta.json','contributions.json','credential-evidence.json'])files[file]=(await readFile(join(dir,file))).length;
  for(const file of ['intents.json','roster.json','member-profiles.json'])files[file]=(await readFile(join(cdir,file))).length;
  let reads={};globalThis.__macUiReads=file=>{if(!String(file).startsWith(home))return;const key=basename(file);reads[key]=(reads[key]??0)+1;const end=performance.now()+(key==='job-meta.json'?4:16);while(performance.now()<end){}};
  t.after(()=>{delete globalThis.__macUiReads;});
  const jobsAt=performance.now(),rows=await api(app,'/api/jobs'),jobsMs=performance.now()-jobsAt,jobsReads={...reads};
  assert.equal(rows.length,12);reads={};
  const oldHome=process.env.FARAVAN_SBX_HOME,oldScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=join(f.root,'sbx');process.env.FARAVAN_SCRATCH_ROOT=join(f.root,'scratch');
  t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldScratch;});
  const policy=createSbxPolicy(),stub=sbxRunner(policy),active=new Set(),delays=[],steps=[];
  const backend=new DockerSbxBackend({home:join(f.root,'backend'),hostDisk:{free:async()=>({free:64*1024**3})},storage:{available:async()=>false,supported:async()=>false,release:async()=>{}},runCommand:async(args,options)=>{
    steps.push({at:performance.now(),command:args[0]});
    const {stdout}=await exec(process.execPath,['-e','process.stdout.write(String(Date.now()))'],{signal:options?.signal});delays.push(Date.now()-Number(stdout));
    if(args[0]==='run')active.add(args[args.indexOf('--name')+1]);if(args[0]==='rm')active.delete(args.at(-1));
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify([...active].map(name=>({name,status:'running'}))),stderr:''};
    return stub.run(args,options);
  }});
  const pending=[],failures=[];let browserReads=0;
  const get=path=>{const p=api(app,path).catch(e=>{failures.push({path,error:e.message});});pending.push(p);};
  const stops=[];const document=new class extends EventTarget {visibilityState='visible';}();
  const poll=(run,ms)=>{if(before){run();const id=setInterval(run,ms);return()=>clearInterval(id);}return visibleInterval(run,ms,{document});};
  const resources=['home','readiness','circles','agents','devices','approvals','activity','jobs','updates'];
  const streamStop=new AbortController();
  const stream=await fetch(app.origin+'/api/events',{headers:{'x-faravan-session-token':app.token},signal:streamStop.signal});
  const drain=stream.body.pipeTo(new WritableStream({write(){}})).catch(()=>{});
  t.after(async()=>{streamStop.abort();await drain;});
  const elu=performance.eventLoopUtilization(),started=performance.now();
  stops.push(poll(()=>{browserReads+=9;for(const r of resources)get('/api/'+r);},5000));
  for(const [path,ms] of [['/api/circles/'+circle.id+'/compose',15000],['/api/circles/'+circle.id+'/compose',20000],['/api/hosting',15000],['/api/devices',20000]])stops.push(poll(()=>{browserReads++;get(path);},ms));
  const tray=setInterval(()=>{get('/api/status');get('/api/approvals');get('/api/notifications');},2000);
  const capture=setInterval(()=>history.record('observation_requested',{}),1000);stops.push(()=>clearInterval(capture));stops.push(()=>clearInterval(tray));t.after(()=>stops.forEach(stop=>stop()));
  const run=async()=>{
    let preparedAt;
    const prepare=backend.prepare.bind(backend);backend.prepare=async(...args)=>{const h=await prepare(...args);preparedAt=performance.now();return h;};
    const first=steps.length,at=performance.now();
    const result=await backend.testWorkspace({harnessName:'claude-code-subscription'});
    backend.prepare=prepare;
    const commands=steps.slice(first).filter(s=>s.at<=preparedAt),gaps=commands.slice(1).map((row,i)=>row.at-commands[i].at);
    return {part:result.ok?'passed':'failed',prepare_ms:preparedAt-at,max_step_gap_ms:Math.max(...gaps),commands:commands.length,result};
  };
  const visible=await run();await sleep(Math.max(0,6500-(performance.now()-started)));
  document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));
  const hiddenReadsAt=browserReads,hidden=await run();await sleep(5500);
  const hiddenReads=browserReads-hiddenReadsAt;
  for(const stop of stops)stop();await Promise.all(pending);await history.flush();
  const busy=performance.eventLoopUtilization(elu).utilization;
  t.diagnostic(JSON.stringify({before,files,historyBytes,historyRows:lines.length,circles:(await app.device.listCircles()).length,jobs:rows.length,jobs_ms:jobsMs,jobsReads,busy_fraction:busy,max_callback_delay_ms:Math.max(...delays),visible,hidden,hidden_browser_reads:hiddenReads,reads,failures}));
  assert.deepEqual(failures,[]);assert.equal(visible.part,'passed');assert.equal(hidden.part,'passed');
  // Absolute latency is a dedicated performance gate: parallel CI also includes host scheduling/throttling.
  // The full suite keeps the preparation deadline, no-route-failure and deterministic read-count regressions.
  if(process.env.MAC_UI_PERF_BUDGET==='1') {
    assert.ok(visible.max_step_gap_ms<1000);assert.ok(hidden.max_step_gap_ms<1000);
    assert.ok(Math.max(...delays)<1000);
  }
  assert.equal(hiddenReads,0);
  assert.ok(jobsReads['intents.json']<=10,'display intents are not read once per row');
});
