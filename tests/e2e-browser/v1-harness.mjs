// Hermetic harness for the browser E2E: a v1 queue server plus three app instances
// (owner, lender, guest) backed by the in-process fixtures. Never uses Docker or the real home.
// Prints one JSON line {owner, lender, guest, queue, control} then runs until SIGTERM/SIGINT.
// POST <control>/hold makes the lender's NEXT fake job wait until it is stopped.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appFixture, syntheticBackend } from '../helpers/v1-app-fixture.mjs';
import { createSyntheticPace50Source } from '../helpers/pace50-synthetic-source.mjs';

if (process.argv.includes('--fresh-app')) {
  await freshApp(process.argv[3]);
} else {

const cleanups = [];
const f = await appFixture({after: fn => cleanups.push(fn)}, {});
const holdOptions = {hold: false};
await f.provisionFromHome('owner');
// The owner's app approves redeemed invitations in the background, as it does by default.
// pollMs: the owner re-reads its tracked jobs every 250 ms (the fixture default of 25 ms would hold the device lock almost constantly).
// approvalPollMs: the owner's queue sweep holds the owner lock for 60-170 ms; at the fixture's 25 ms the page's own reads and Approve
// click lose the lock wait (device_busy) over and over. The product default is 5 s.
const owner = await f.start('owner', {autoApprove: true, pollMs: 250, approvalPollMs: 1500});
const lenderBackend = syntheticBackend(f.root, holdOptions);
// The ordered UI model requires named Docker facts; a generic synthetic 'Ready' is insufficient.
lenderBackend.probeCapabilities = async () => ({available:true,preflight:{ok:true,checks:[
  {name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true},
]}});
const lender = await f.start('lender', {backend:lenderBackend,
  identityProbe:async ({harnessNames}) => ({providers:harnessNames.map(harness_id => ({harness_id,installed:true,signedIn:true}))}),
});
// A third computer that joins by hand-approval (it only needs to join, never to lend).
const guest = await f.start('guest');

const control = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/hold') {holdOptions.hold = true;res.writeHead(204).end();return;}
  res.writeHead(404).end();
});
control.listen(0, '127.0.0.1');
await once(control, 'listening');

console.log(JSON.stringify({
  owner: owner.app.origin, lender: lender.app.origin, guest: guest.app.origin, queue: f.origin, tokens: {owner: owner.app.token, lender: lender.app.token, guest: guest.app.token},
  control: 'http://127.0.0.1:' + control.address().port,
}));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  control.closeAllConnections();
  control.close();
  try {
    for (const fn of cleanups.reverse()) await fn();
  } finally {process.exit(0);}
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
}

// Only this mode is forked after all four synthetic homes are set. IPC controls the fake
// execution, never product actions: hosting, joining, approvals and jobs remain real UI writes.
async function freshApp(installedRoot) {
  const {readFile,writeFile,rename,rm} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const {fileURLToPath,pathToFileURL} = await import('node:url');
  const lib = installedRoot ? pathToFileURL(join(installedRoot,'lib')+'/') : new URL('../../lib/',import.meta.url);
  const appModule = new URL('v1/app.mjs',lib);
  const {startApp} = await import(appModule);
  const {hostCommand} = await import(new URL('v1/host-command.mjs',lib));
  const cleanups=[];
  const options={hold:true,captureStream:true,liveMessage:'G2 agent is working on the deterministic change.',change:{path:'answer.txt',bytes:'the deterministic G2 change\n'}};
  const f=await appFixture({after:fn=>cleanups.push(fn)});
  const backend=syntheticBackend(f.root,options);
  const source=createSyntheticPace50Source({start:Date.now()});
  // This Ask-mode journey must work when the automatic estimate is unknown.
  if(process.env.FARAVAN_TEST_AUTOMATIC_EVIDENCE!=='1')delete source.objectiveInputFor;
  let holdPreparation=false,releasePreparation;
  const prepare=backend.prepare.bind(backend);
  backend.prepare=async spec=>{
    const handle=await prepare(spec);
    if(holdPreparation)try{await new Promise(resolve=>{releasePreparation=resolve;});}
    finally{releasePreparation=null;}
    return handle;
  };
  // Checks execute only the fixed synthetic fixture command, in a fresh returned workspace.
  const capabilities=backend.lenderCapabilities;
  backend.lenderCapabilities=()=>({...capabilities(),capabilities:['verify_v1']});
  backend.checkWithoutProvider=true;
  backend.verificationFiles=async()=>'';
  backend.prepareCheck=async()=>backend.prepare({entrypoint:'true'});
  backend.verify=async(handle,{cmd})=>{
    if(cmd!=="test \"$(cat answer.txt)\" = 'the deterministic G2 change'")throw new Error('Unexpected synthetic check');
    const {execFile}=await import('node:child_process');
    const {promisify}=await import('node:util');
    await promisify(execFile)('sh',['-c',cmd],{cwd:handle.scratch_dir,env:process.env});
    return {exit:0,timed_out:false,stdout:'',timeout_ms:5000};
  };
  backend.probeCapabilities=async()=>({available:true,preflight:{ok:true,checks:[
    {name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]}});
  let confirmStop,closing=false,providerSignedIn=true,rejectShutdown=false;
  const cancel=backend.cancel.bind(backend);
  backend.cancel=async handle=>{
    if(!closing)await new Promise(resolve=>{confirmStop=resolve;});
    confirmStop=null;
    return cancel(handle);
  };
  const relayRequests=[];
  const observeFetch=async(url,init)=>{
    const path=new URL(url).pathname,record={path,method:init?.method??'GET',startedAt:Date.now()};
    if(path.endsWith('/transcript')&&record.method==='POST')record.seq=JSON.parse(init.body).seq;
    relayRequests.push(record);if(relayRequests.length>128)relayRequests.shift();
    try{const response=await globalThis.fetch(url,init);record.status=response.status;return response;}
    catch(error){record.error=error.name;throw error;}
    finally{record.finishedAt=Date.now();}
  };
  const {app}=await f.start('fresh',{home:process.env.FARAVAN_HOME,startApp,backend,pollMs:1000,approvalPollMs:5000,fetch:observeFetch,
    lendingPace50:{account_week_id:'synthetic-week-1',source},demandModel:null,
    ...(process.env.FARAVAN_TEST_AUTOMATIC_EVIDENCE==='1'?{}:{lendingQueueReader:async()=>({known:false})}),
    autoApprove:true,identityProbe:async({harnessNames})=>({providers:harnessNames.map(harness_id=>({harness_id,installed:true,signedIn:providerSignedIn}))})});
  const paths=Object.fromEntries(['FARAVAN_HOME','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR'].map(key=>[key,process.env[key]]));
  async function stopHost() {
    try{await readFile(join(process.env.FARAVAN_COORDINATOR_HOME,'host.json'));}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    await hostCommand({home:process.env.FARAVAN_HOME,coordinatorHome:process.env.FARAVAN_COORDINATOR_HOME},['--stop'],'host_stopped');
  }
  // Inject transport faults at the real local HTTP server. Successful requests always
  // reach the original handler, coordinator and artifact store.
  let deadlineSeconds=null;
  const intentStore=app.device.intentStore.bind(app.device);
  app.device.intentStore=(...args)=>{
    const store=intentStore(...args),set=store.set.bind(store);
    return {...store,async set(slot,intent){
      if(deadlineSeconds&&intent.kind==='submit'&&intent.state==='pending'){
        const protocol=await import(new URL('protocol/index.mjs',lib));
        intent.payload.expires_at=new Date(Date.parse(intent.payload.created_at)+deadlineSeconds*1000).toISOString().replace('.000Z','Z');
        intent.envelope=protocol.signEnvelope('job',intent.payload,app.device.deviceKey.privateKey??app.device.deviceKey);
        intent.jobDigest=protocol.digest(intent.payload);
      }
      return set(slot,intent);
    }};
  };
  const faults=new Map(),heldReads=new Map(),readCounts=new Map();
  let streamEvents=0;const streamTimers=new Set(),emitted=[];
  const handlers=app.server.listeners('request');app.server.removeAllListeners('request');
  app.server.on('request',async(req,res)=>{
    if(req.url.startsWith('/api/events')){const write=res.write.bind(res);res.write=(chunk,...args)=>{streamEvents+=(String(chunk).match(/data:/g)??[]).length;return write(chunk,...args);};}
    const section=/^\/api\/jobs\/[^/]+\/(transcript|changes)(?:\?|$)/.exec(req.url)?.[1]??(req.url==='/api/devices'?'devices':null);
    if(section&&req.method==='GET'){
      readCounts.set(section,(readCounts.get(section)??0)+1);
      const held=heldReads.get(section);if(held)await held.promise;
      const fault=faults.get(section);
      if(fault){if(fault.once)faults.delete(section);if(fault.delayMs)await new Promise(resolve=>setTimeout(resolve,fault.delayMs));res.writeHead(fault.status,{'content-type':'application/json'});res.end(JSON.stringify({code:'fixture_read_failure'}));return;}
    }
    for(const handler of handlers)handler.call(app.server,req,res);
  });
  process.on('message',async({id,command,payload})=>{
    try {
      let value;
      if(command==='hold')options.hold=true;
      else if(command==='hold-prepare')holdPreparation=true;
      else if(command==='release-prepare'){holdPreparation=false;releasePreparation?.();}
      else if(command==='deadline-seconds')deadlineSeconds=payload.seconds;
      else if(command==='stream-records'){
        if(!options.emitRecord)throw new Error('No active fake execution');
        const epoch=Date.now();
        for(let index=1;index<=6;index++){
          const timer=setTimeout(()=>{
            streamTimers.delete(timer);const at=Date.now(),marker='G2 live marker '+index;
            options.emitRecord({type:'assistant',timestamp:new Date(at).toISOString(),message:{content:[{type:'text',text:marker},{type:'tool_use',id:marker,name:'Read',input:{file_path:options.workspace+'/src/parser.js'}}]}});
            emitted.push({at,marker,index,plannedAt:epoch+index*10000});
          },index*10000);streamTimers.add(timer);
        }
        value={epoch,startedAt:options.startedAt};
      }
      else if(command==='admission')value=app.lendingAdmission();
      else if(command==='stream-state')value={emitted,streamEvents,workspace:options.workspace,startedAt:options.startedAt,relayRequests};
      else if(command==='configure-summary'){options.change=payload.zeroChanges?null:{path:'answer.txt',bytes:'the deterministic G2 change\n'};options.finalMessage=payload.finalMessage;}
      else if(command==='fault-read')faults.set(payload.section,{status:payload.status??422,once:payload.once!==false,delayMs:payload.delayMs??0});
      else if(command==='hold-read'){let release;const promise=new Promise(resolve=>release=resolve);heldReads.set(payload.section,{promise,release});}
      else if(command==='release-read'){heldReads.get(payload.section)?.release();heldReads.delete(payload.section);}
      else if(command==='restore-reads'){faults.clear();for(const held of heldReads.values())held.release();heldReads.clear();}
      else if(command==='read-counts')value=Object.fromEntries(readCounts);
      else if(command==='hide-job-metadata'){
        const file=join(process.env.FARAVAN_HOME,'v1','job-meta.json');
        const {acquireProcessLock}=await import(new URL('v1/lock.mjs',lib));
        const release=await acquireProcessLock(join(process.env.FARAVAN_HOME,'v1','job-meta.lock'));
        const temporary=file+'.g2-hidden';
        try {
          const metadata=JSON.parse(await readFile(file,'utf8'));
          value={removed:!!metadata[payload.jobDigest]};delete metadata[payload.jobDigest];
          await writeFile(temporary,JSON.stringify(metadata));await rename(temporary,file);
        } finally {await rm(temporary,{force:true});await release();}
      }
      else if(command==='seed-usage'){
        const {lenderDayKey}=await import(new URL('v1/lender.mjs',lib));
        await writeFile(join(process.env.FARAVAN_HOME,'v1','app-counters.json'),JSON.stringify({day:lenderDayKey(Date.now(),payload.timeZone),jobs:0,milliseconds:payload.milliseconds,pending:null}));
      }
      else if(command==='job-state')value=await(await app.device.client(payload.circle)).getJob(payload.jobDigest);
      else if(command==='emit-record'){
        if(!options.emitRecord)throw new Error('No active fake execution');
        const at=Date.now(),marker=payload.marker;
        options.emitRecord({type:'assistant',timestamp:new Date(at).toISOString(),message:{content:[{type:'text',text:marker},{type:'tool_use',id:marker,name:'Read',input:{file_path:options.workspace+'/src/parser.js'}}]}});
        value={at,startedAt:options.startedAt,workspace:options.workspace};
      }
      else if(command==='reject-shutdown')rejectShutdown=true;
      else if(command==='freeze-host'){
        const {stopOwnedCoordinatorProcess}=await import(new URL('v1/host.mjs',lib));
        const status=JSON.parse(await readFile(join(process.env.FARAVAN_COORDINATOR_HOME,'status.json'),'utf8'));
        stopOwnedCoordinatorProcess(status.pid,join(process.env.FARAVAN_COORDINATOR_HOME,'host.json'),{signal:pid=>process.kill(pid,'SIGSTOP')});
      }
      else if(command==='sign-out')providerSignedIn=false;
      else if(command==='checkpoint'){if(!options.emitLog)throw new Error('No active fake execution');options.emitLog('G2 still running at checkpoint.');}
      else if(command==='release'){options.hold=false;backend.release();}
      else if(command==='confirm-stop'){if(!confirmStop)throw new Error('No stop awaiting confirmation');confirmStop();}
      else if(command==='state')value={runs:backend.calls.filter(([kind])=>kind==='run').length,cancels:backend.calls.filter(([kind])=>kind==='cancel').length,stopPending:!!confirmStop,preparing:!!releasePreparation};
      else if(command==='shutdown'){
        if(rejectShutdown)throw new Error('Synthetic IPC shutdown failure');
        closing=true;holdPreparation=false;releasePreparation?.();confirmStop?.();backend.release();for(const timer of streamTimers)clearTimeout(timer);for(const held of heldReads.values())held.release();await stopHost();
        for(const cleanup of cleanups.reverse())await cleanup();
      } else throw new Error('Unknown fixture control: '+command);
      process.send({id,value},()=>{if(command==='shutdown')process.exit(0);});
    } catch(error){process.send({id,error:error.stack});}
  });
  process.send({ready:{origin:app.origin,token:app.token,pid:process.pid,reportedPaths:paths,runtime:{app:fileURLToPath(appModule),node:process.execPath}}});
}
