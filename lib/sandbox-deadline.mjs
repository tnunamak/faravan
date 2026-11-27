import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processLockOwners} from './v1/lock.mjs';

// Fixed reserve for output collection and cleanup; after app death compute
// can continue through this reserve before independent removal starts.
export const SANDBOX_DEADLINE_GRACE_MS=120_000;
const guardFile=fileURLToPath(new URL('./sandbox-deadline-supervisor.mjs',import.meta.url));
// Loaded once, before an upgrade can replace files beneath a running guard.
// Keep this separate from the record binding so old observations remain valid.
export const SANDBOX_GUARD_BUILD_ID=createHash('sha256').update([
  'sandbox-deadline.mjs','sandbox-deadline-supervisor.mjs','sandbox-create-fence.mjs',
  'v1/lock.mjs','v1/sandbox-record-owner.mjs','v1/sandbox-watch-proofs.mjs','v1/sandbox-shared-watcher.mjs','durable-write.mjs',
].map(file=>fs.readFileSync(new URL(file,import.meta.url),'utf8')).join('\0')).digest('hex');

let darwinBootSession;
function readDarwinBootSession() {
  // Boot identity cannot change during this process. Cache success and failure:
  // even an unavailable sysctl must not spawn a child on every guard tick.
  if(darwinBootSession===undefined) {
    darwinBootSession='';
    try{darwinBootSession=execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],
      {encoding:'utf8',timeout:1000,maxBuffer:1024,env:{LC_ALL:'C'},stdio:['ignore','pipe','ignore']}).trim();}catch{/* Refuse the clock below. */}
  }
  return darwinBootSession;
}

export function sandboxDeadlineClock({platform=process.platform,now=Date.now,
  hrtime=process.hrtime.bigint,bootSession=readDarwinBootSession}={}) {
  const wall=now();
  if(platform==='linux')return {wall,
    boot_id:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
    boot_ms:Math.floor(Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0])*1000)};
  if(platform==='darwin') {
    const session=bootSession();
    // Node hrtime exposes libuv's boot-relative mach_continuous_time on supported
    // macOS, including sleep. Older libuv fallbacks use mach_absolute_time: sleep
    // then extends the deadline rather than shortening it. Never use os.uptime.
    const ticks=hrtime(),boot_ms=typeof ticks==='bigint'?Number(ticks/1000000n):NaN;
    if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session)&&
      typeof ticks==='bigint'&&ticks>=0n&&Number.isSafeInteger(boot_ms))
      return {wall,boot_id:'darwin:'+session.toLowerCase(),boot_ms};
  }
  throw Error('The sandbox deadline clock is unavailable. Please retry.');
}

export function validSandboxDeadline(row) {
  const c=row.deadline_clock;
  return Number.isSafeInteger(row.deadline_at)&&row.deadline_at>=0&&c?.version===1&&
    typeof c.boot_id==='string'&&c.boot_id.length>0&&Number.isSafeInteger(c.boot_at)&&c.boot_at>=0;
}

export function sandboxDeadlineRemaining(row,clock) {
  if(!Number.isSafeInteger(row.deadline_at)||!Number.isFinite(clock.wall))return 0;
  const wall=row.deadline_at-clock.wall;
  if(!row.deadline_clock)return Math.max(0,wall);
  if(!validSandboxDeadline(row)||clock.boot_id!==row.deadline_clock.boot_id||!Number.isFinite(clock.boot_ms))return 0;
  return Math.max(0,row.deadline_clock.boot_at-clock.boot_ms);
}

export function sandboxDeadlineReservation(remaining,clock,inherited) {
  const ms=Math.ceil(remaining)+SANDBOX_DEADLINE_GRACE_MS;
  return {deadline_at:Math.min(clock.wall+ms,inherited?.deadline_at??Infinity),
    deadline_clock:{version:1,boot_id:clock.boot_id,
      boot_at:Math.min(clock.boot_ms+ms,inherited?.deadline_clock?.boot_id===clock.boot_id?inherited.deadline_clock.boot_at:Infinity)}};
}

function target(row) {
  if(!/^(?:wf-[a-f0-9]{16}|dl-[a-f0-9]{16})$/.test(row.sandbox_id)||
    typeof row.sbx_home!=='string'||!path.isAbsolute(row.sbx_home)||/[\0\r\n]/.test(row.sbx_home)||
    !Number.isSafeInteger(row.deadline_at))throw Error('Invalid sandbox deadline.');
}

export function sandboxDeadlineUnit(row) {
  target(row);
  const incarnation=row._cleanupId?'-'+row._cleanupId.replace(/-/g,'').slice(0,12):'';
  return `faravan-${createHash('sha256').update(row.sbx_home).digest('hex').slice(0,12)}-deadline-${row.sandbox_id}${incarnation}`;
}

export function sandboxDeadlineUnitMatches(row,unit) {
  const base=sandboxDeadlineUnit(row);
  return unit===base||typeof unit==='string'&&unit.startsWith(base+'-b')&&/^[a-f0-9]{12}$/.test(unit.slice(base.length+2));
}

// Only service-manager connection settings go to the control commands. HOME
// for the removal itself is explicit; no provider or account values are copied.
function managerEnv() {
  const env={};
  for(const key of ['HOME','PATH'])if(process.env[key]!==undefined)env[key]=process.env[key];
  if(process.platform==='linux') {
    const uid=process.getuid(),runtime='/run/user/'+uid;
    for(const directory of ['/run','/run/user',runtime]) {
      const entry=fs.lstatSync(directory);
      if(!entry.isDirectory()||entry.isSymbolicLink()||(directory===runtime&&entry.uid!==uid))throw Error('Unverified user bus');
    }
    const entry=fs.lstatSync(runtime+'/bus');
    if(!entry.isSocket()||entry.isSymbolicLink()||entry.uid!==uid)throw Error('Unverified user bus');
    env.XDG_RUNTIME_DIR=runtime;env.DBUS_SESSION_BUS_ADDRESS='unix:path='+runtime+'/bus';
  }
  return env;
}

export function runDeadlineCommand(binary,args,options={}) {
  let env;try{env=options.env??managerEnv();}catch{return Promise.resolve({code:1,stdout:'',stderr:'The user bus is unavailable.'});}
  try{options.onCommand?.(binary,args);}catch{/* Metrics cannot affect cleanup. */}
  return new Promise(resolve=>execFile(binary,args,{env,timeout:15_000,killSignal:'SIGKILL',maxBuffer:64*1024},(error,stdout,stderr)=>
    // `exit` is the program's own exit status; a launch failure or a kill has none, so a failure is never read as an exit.
    resolve({code:error?1:0,stdout,stderr,...(error?{exit:typeof error.code==='number'?error.code:null,killed:error.killed===true}:{})})));
}

// A PID is authority only while the same process start and boot are observed.
// Three answers: the process start (a string) while it runs; `null` when it is confirmed not running (no such process, or a
// zombie); `undefined` when it could not be read. Unknown is not gone: only `null` shows that a process exited.
export async function deadlineProcessIdentity(pid,{platform=process.platform,run=runDeadlineCommand}={}) {
  if(!Number.isSafeInteger(pid)||pid<=1)return null;
  try {
    if(platform==='linux') {
      let stat;
      try{stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');}
      catch(error){return error?.code==='ENOENT'||error?.code==='ESRCH'?null:undefined;}
      const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
      if(fields[0]==='Z')return null;
      const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
      return boot&&/^\d+$/.test(fields[19]??'')?`${boot}:${fields[19]}`:undefined;
    }
    if(platform==='darwin') {
      const result=await run('/bin/ps',['-p',String(pid),'-o','lstart=','-o','command=']);
      if(result.code===0&&result.stdout.trim())return result.stdout.trim();
      // `ps` exits 1 with no output when there is no such process. Anything else (output on stderr, a kill, no exit status) is a failed query.
      const noSuchProcess=result.code===1&&!String(result.stdout??'').trim()&&!String(result.stderr??'').trim()&&
        result.killed!==true&&(result.exit===undefined||result.exit===1);
      return noSuchProcess?null:undefined;
    }
  }catch{return undefined;}
  return null;
}

// For callers that need a start identity or nothing: a process that cannot be read gives no identity (`null`).
export async function deadlineProcessStart(pid,options) {return (await deadlineProcessIdentity(pid,options))??null;}

export function deadlineProcessStartSync(pid) {
  if(!Number.isSafeInteger(pid)||pid<=1)return null;
  try {
    if(process.platform==='linux') {
      const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
      const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
      return fields[0]!=='Z'&&/^\d+$/.test(fields[19]??'')&&boot?`${boot}:${fields[19]}`:null;
    }
    return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart=','-o','command='],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}).trim()||null;
  }catch{return null;}
}

// Every deadline guard process this host runs, with the payload it was started with. Linux reads /proc; macOS asks `ps`.
// A systemd unit runs the same program, so its guard is listed too. Only a payload of the expected shape is returned.
const GUARD_PROGRAM='sandbox-deadline-supervisor.mjs';
function guardPayload(text) {
  try {
    const payload=JSON.parse(text);
    if(!/^(?:wf|dl)-[a-f0-9]{16}$/.test(payload?.sandbox_id??'')||typeof payload.recordPath!=='string'||!path.isAbsolute(payload.recordPath)||
      payload.statusPath!==payload.recordPath+'.deadline')return null;
    return payload;
  }catch{return null;}
}
export async function listDeadlineGuardProcesses({platform=process.platform}={}) {
  const found=[];
  if(platform==='linux') {
    for(const entry of fs.readdirSync('/proc')) {
      if(!/^\d+$/.test(entry))continue;
      let argv;
      try{argv=fs.readFileSync('/proc/'+entry+'/cmdline','utf8').split('\0');}catch{continue;}
      const at=argv.findIndex(arg=>path.basename(arg)===GUARD_PROGRAM),payload=at>=0?guardPayload(argv[at+1]):null;
      if(payload)found.push({pid:Number(entry),payload});
    }
  }else if(platform==='darwin') {
    const output=await new Promise((resolve,reject)=>execFile('/bin/ps',['-axo','pid=,command='],{env:{PATH:'/usr/bin:/bin'},timeout:5000,maxBuffer:16*1024*1024},
      (error,stdout)=>error?reject(error):resolve(stdout)));
    for(const line of output.split('\n')) {
      const match=/^\s*(\d+)\s+.*?sandbox-deadline-supervisor\.mjs\s+(\{.*\})(?:\s+--standby)?\s*$/.exec(line),payload=match?guardPayload(match[2]):null;
      if(payload)found.push({pid:Number(match[1]),payload});
    }
  }
  return found;
}

export function deadlineSupervisorPayload(row,binary,directory,launchMode='systemd') {
  target(row);
  const recordPath=path.join(directory??path.join(row.sbx_home,'.faravan-deadlines'),(row._cleanupId??row.sandbox_id)+'.json');
  return {sandbox_id:row.sandbox_id,sbx_home:row.sbx_home,binary,launchMode,deadline_at:row.deadline_at,
    ...(row.deadline_clock?{deadline_clock:row.deadline_clock}:{}),recordPath,statusPath:recordPath+'.deadline'};
}
const buildSuffix=buildId=>createHash('sha256').update(buildId).digest('hex').slice(0,12);
export const deadlineSuccessorPath=(payload,buildId=SANDBOX_GUARD_BUILD_ID)=>payload.statusPath+'.successor-'+buildSuffix(buildId)+'.ready';
export const deadlineBinding=payload=>createHash('sha256').update(JSON.stringify(payload)).digest('hex');
export const deadlineMaterialized=(payload,state)=>state?.binding===deadlineBinding(payload)&&state.observed===true&&
  ['armed','failed','removed'].includes(state.state)&&Number.isSafeInteger(state.pid)&&state.pid>1&&typeof state.start==='string'&&state.start.length>0;
// A missing file is `null`. A file that exists but cannot be read or parsed throws: that is unknown, not "no guard".
const readState=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};

export function createSandboxDeadlineManager({binary,platform=process.platform,run=runDeadlineCommand,directory,
  now=Date.now,clock=()=>({...sandboxDeadlineClock(),wall:now()}),spawnGuard=spawn,processStart=deadlineProcessIdentity,
  stateReader=readState,processStartSync=deadlineProcessStartSync,readyTimeoutMs=15000,listProcesses=listDeadlineGuardProcesses,
  buildId=SANDBOX_GUARD_BUILD_ID,signalGuard=(pid,signal)=>process.kill(pid,signal)}={}) {
  const executable=()=>typeof binary==='function'?binary():binary;
  // A unit started without a timer has no `.timer`: systemctl then exits 5 for the timer it cannot find, after it has stopped
  // the service. That is a success only when the service is then not running.
  const stopUnit=async unit=>{
    const stopped=await run('systemctl',['--user','stop',unit+'.timer',unit+'.service']);
    if(stopped.code===0)return true;
    return stopped.exit===5&&(await run('systemctl',['--user','is-active','--quiet',unit+'.service'])).code!==0;
  };
  const payloadFor=row=>deadlineSupervisorPayload(row,row.deadline_enforcer?.binary??executable(),directory,row.deadline_enforcer?.kind??(platform==='linux'?'systemd':'guard'));
  // Everywhere except retirement, a status that cannot be read is no published guard.
  const readStatus=file=>{try{return stateReader(file);}catch{return null;}};
  const stateFor=payload=>{const state=readStatus(payload.statusPath);return state?.binding===deadlineBinding(payload)&&['armed','failed'].includes(state.state)&&Number.isSafeInteger(state.pid)&&state.pid>1&&typeof state.start==='string'&&state.start.length>0?state:null;};
  const argvFor=payload=>['/usr/bin/env','-i','HOME='+payload.sbx_home,process.execPath,guardFile,JSON.stringify(payload)];
  const alive=row=>{if(sandboxDeadlineRemaining(row,clock())<=0)throw Error('The sandbox deadline has passed. Please retry.');};
  const bus=async args=>{const result=await run('busctl',['--user','--json=short',...args]);try{return result.code===0?JSON.parse(result.stdout).data:null;}catch{return null;}};
  const unitFor=row=>{
    const base=sandboxDeadlineUnit(row),saved=row.deadline_enforcer?.unit;
    return sandboxDeadlineUnitMatches(row,saved)?saved:base;
  };
  const successorUnit=row=>sandboxDeadlineUnit(row)+'-b'+buildSuffix(buildId);
  async function commandUnit(unit,payload) {
    if((await run('systemctl',['--user','is-active','--quiet',unit+'.service'])).code!==0)return false;
    const object=await bus(['call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','GetUnit','s',unit+'.service']);
    if(!Array.isArray(object)||!/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object[0]??''))return false;
    const commands=await bus(['get-property','org.freedesktop.systemd1',object[0],'org.freedesktop.systemd1.Service','ExecStart']);
    const argv=argvFor(payload);
    return Array.isArray(commands)&&commands.length===1&&commands[0][0]===argv[0]&&
      [argv,[...argv,'--standby']].some(expected=>JSON.stringify(commands[0][1])===JSON.stringify(expected));
  }
  async function provedUnit(row,payload,unit=unitFor(row)) {
    if(!await commandUnit(unit,payload))return false;
    const state=stateFor(payload);
    return Boolean(state&&await processStart(state.pid)===state.start);
  }
  async function standbyState(payload) {
    const state=readStatus(deadlineSuccessorPath(payload,buildId));
    return state?.state==='waiting'&&state.binding===deadlineBinding(payload)&&state.build_id===buildId&&
      Number.isSafeInteger(state.pid)&&state.pid>1&&typeof state.start==='string'&&state.start&&
      await processStart(state.pid)===state.start?state:null;
  }
  async function guardState(payload) {
    const state=stateFor(payload);
    return state&&typeof state.start==='string'&&await processStart(state.pid)===state.start?state:null;
  }
  async function active(row,{recovery=false}={}) {
    target(row);if(!recovery&&row.deadline_clock&&row.deadline_clock.boot_id!==clock().boot_id)return false;
    const payload=payloadFor(row);
    if(row.deadline_enforcer?.kind==='guard')return Boolean(await guardState(payload));
    return platform==='linux'&&await provedUnit(row,payload);
  }
  // Only this store's bound process may be stopped. A changed or unknown
  // identity is a refusal, never permission to signal a reused PID.
  async function retireGuard(payload,state,{unit,beforeRetire}={}) {
    if(await processStart(state.pid)!==state.start)throw Error('Sandbox guard identity changed.');
    const latest=stateFor(payload);
    if(!latest||latest.pid!==state.pid||latest.start!==state.start)throw Error('Sandbox guard publication changed.');
    if(latest.build_id===buildId)return false;
    if(unit) {
      if(!await provedUnit(unit,payload))throw Error('The older sandbox guard could not be verified.');
      await beforeRetire();
      if(!await stopUnit(unitFor(unit)))throw Error('The older sandbox guard could not be stopped.');
    }else {
      const processes=await listProcesses({platform});
      if(!processes.some(item=>item.pid===state.pid&&deadlineBinding(item.payload)===deadlineBinding(payload)))throw Error('Sandbox guard command could not be verified.');
      await beforeRetire();
      // No await between the final identity check and signaling. This is a
      // checked PID snapshot; macOS does not provide an atomic PID handle here.
      if(processStartSync(state.pid)!==state.start)throw Error('Sandbox guard identity changed.');
      signalGuard(state.pid,'SIGTERM');
    }
    const until=Date.now()+readyTimeoutMs;
    do {
      const identity=await processStart(state.pid);
      if(identity===null||typeof identity==='string'&&identity!==state.start)return true;
      if(Date.now()>=until)break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }while(true);
    throw Error('The older sandbox guard has not exited.');
  }
  // Readiness is separate from the occupied status file. The successor owns
  // its waiting loop before we retire anything; it takes over even if this app
  // dies between readiness, retirement and the journal update.
  async function replaceGuard(row,payload,old,{unit}={}) {
    const nextUnit=unit?successorUnit(row):null;
    if(unit) {
      if(!await provedUnit(unit,payload))throw Error('The older sandbox guard could not be verified.');
    }else {
      const processes=await listProcesses({platform});
      if(!processes.some(item=>item.pid===old.pid&&deadlineBinding(item.payload)===deadlineBinding(payload))||processStartSync(old.pid)!==old.start)
        throw Error('The older sandbox guard could not be verified.');
    }
    let child,launchError;
    const ready=async()=>{
      const state=await standbyState(payload);
      return state&&(!nextUnit||await commandUnit(nextUnit,payload))?state:null;
    };
    let successor=await ready();
    if(!successor) {
      if(nextUnit) {
        const result=await run('systemd-run',['--user','--unit='+nextUnit,'--collect','--expand-environment=no','--setenv=HOME='+row.sbx_home,'--',...argvFor(payload),'--standby']);
        if(result.code!==0)throw Error('The successor sandbox guard could not be launched.');
      }else {
        child=spawnGuard(process.execPath,[guardFile,JSON.stringify(payload),'--standby'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{HOME:row.sbx_home}});
        child.once('error',error=>{launchError=error;});
        child.once('exit',()=>{launchError??=Error('The successor sandbox guard exited.');});
      }
      const until=Date.now()+readyTimeoutMs;
      do {
        if(launchError)throw launchError;
        successor=await ready();if(successor)break;
        if(Date.now()>=until)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }while(true);
      if(!successor){child?.kill();if(child?.connected)child.disconnect();throw Error('The successor sandbox guard did not become ready.');}
    }
    if(child?.connected)child.disconnect();child?.unref?.();
    const beforeRetire=async()=>{
      const current=await ready();
      if(!current||current.pid!==successor.pid||current.start!==successor.start)throw Error('The successor sandbox guard is no longer ready.');
    };
    await retireGuard(payload,old,{unit,beforeRetire});
    const until=Date.now()+readyTimeoutMs;
    do {
      const active=await guardState(payload);
      if(active?.pid===successor.pid&&active.start===successor.start&&active.build_id===buildId&&(!nextUnit||await commandUnit(nextUnit,payload)))
        return nextUnit?{kind:'systemd',unit:nextUnit,binary:payload.binary}:{kind:'guard',pid:active.pid,start:active.start,binary:payload.binary};
      if(Date.now()>=until)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }while(true);
    // A published successor remains independent when acknowledgement is late.
    throw Error('The successor sandbox guard has not published active protection.');
  }
  async function register(row,{recovery=false}={}) {
    // A handed-off row can regain removal protection only through recovery.
    // Keep a current-build guard; an older build releases its lifetime status
    // lock only after an independently ready successor is waiting for it.
    if(row?.watch_state==='watch_adopted'&&!recovery)throw Error('This sandbox is reserved for cleanup.');
    // Recovery restores removal, never launch eligibility; overdue rows fire immediately.
    const checkDeadline=()=>{if(!recovery)alive(row);};
    target(row);checkDeadline();const payload=payloadFor(row),resolved=payload.binary;
    if(typeof resolved!=='string'||!path.isAbsolute(resolved)||/[\0\r\n]/.test(resolved))throw Error('Sandbox removal executable is unavailable.');
    const guardPayload={...payload,launchMode:'guard'};const old=await guardState(guardPayload);
    if(old){
      if(old.build_id===buildId){checkDeadline();return {kind:'guard',pid:old.pid,start:old.start,binary:resolved};}
      return replaceGuard(row,guardPayload,old);
    }
    if(platform==='linux'&&(await run('systemctl',['--user','show','--property=Version','--value'])).code===0) {
      payload.launchMode='systemd';
      // Discover a successor even when the app died before saving its unit.
      const waiting=await standbyState(payload),current=stateFor(payload);
      if(waiting&&current?.build_id===buildId&&await provedUnit(row,payload,successorUnit(row)))
        return {kind:'systemd',unit:successorUnit(row),binary:resolved};
      const unit=unitFor(row);
      if(await provedUnit(row,payload)) {
        const state=stateFor(payload);
        if(state?.build_id===buildId){checkDeadline();return {kind:'systemd',unit,binary:resolved};}
        return replaceGuard(row,payload,state,{unit:row});
      }
      checkDeadline();
      await run('systemd-run',['--user','--unit='+unit,'--collect','--expand-environment=no','--setenv=HOME='+row.sbx_home,'--',...argvFor(payload)]);
      const until=Date.now()+readyTimeoutMs;
      do {
        if(await provedUnit(row,payload)&&stateFor(payload)?.build_id===buildId){checkDeadline();return {kind:'systemd',unit,binary:resolved};}
        if(Date.now()>=until)break;await new Promise(resolve=>setTimeout(resolve,25));
      }while(true);
      await stopUnit(unit).catch(()=>false);throw Error('The independent sandbox deadline could not be registered. Please retry.');
    }
    payload.launchMode='guard';
    checkDeadline();
    return new Promise((resolve,reject)=>{
      const child=spawnGuard(process.execPath,[guardFile,JSON.stringify(payload)],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{HOME:row.sbx_home}});
      let done=false;
      const fail=error=>{if(done)return;done=true;clearTimeout(timer);const published=stateFor(payload);if(!published||processStartSync(published.pid)!==published.start)child.kill();if(child.connected)child.disconnect();reject(error);};
      const timer=setTimeout(()=>fail(Error('Sandbox deadline guard did not become ready.')),readyTimeoutMs);
      child.once('error',fail);child.once('exit',()=>fail(Error('Sandbox deadline guard exited before registration.')));
      child.once('message',async message=>{
        if(message?.ready!==true)return fail(Error('Sandbox deadline guard could not register.'));
        const saved=await guardState(payload);if(!saved||saved.build_id!==buildId)return fail(Error('Sandbox deadline guard identity is unavailable.'));
        try{checkDeadline();}catch(error){return fail(error);}
        if(done)return;done=true;clearTimeout(timer);if(child.connected)child.disconnect();child.unref?.();
        resolve({kind:'guard',pid:saved.pid,start:saved.start,binary:resolved});
      });
    });
  }
  // Classify guards of this store. A verified older build is passed to the
  // journal's locked upgrade callback; current and unknown guards are retained.
  // Other scan results are one of two things:
  //  - adopted: the guard this record names (its saved guard, or the one its status binds to this record's own payload), the guard
  //    whose status file names its exact PID and start identity, or the guard of a record another live process holds.
  //  - blocked: a guard that cannot be told apart from the record's own (its status names no such process, or cannot be read). It
  //    keeps the record's hand-off blocked and shows in status.
  // Nothing is matched by name or pattern.
  async function reconcileGuards({directory,rowFor,heldElsewhere=()=>false,upgrade}) {
    const report={adopted:[],blocked:[]};
    let processes;
    try{processes=await listProcesses({platform});}catch{return {...report,unknown:true};}
    for(const {pid,payload} of processes) {
      if(path.dirname(payload.recordPath)!==directory||!payload.recordPath.endsWith('.json'))continue;
      const id=path.basename(payload.recordPath,'.json');
      const identity=await processStart(pid);
      if(identity===null)continue; // Already gone.
      let row=null;try{row=rowFor(id);}catch{row=null;}
      let state;try{state=stateReader(payload.statusPath);}catch{state=undefined;}
      const named=identity!==undefined&&state?.pid===pid&&state.start===identity;
      const waiting=await standbyState(payload);
      if(waiting?.pid===pid&&waiting.start===identity){report.adopted.push({id,pid});continue;}
      const own=row&&identity!==undefined&&(row.deadline_enforcer?.kind==='guard'?row.deadline_enforcer.pid===pid&&row.deadline_enforcer.start===identity
        :named&&state.binding===deadlineBinding(payloadFor(row)));
      if(own&&named&&state?.build_id!==buildId&&upgrade) {
        if(await upgrade(row))report.adopted.push({id,pid});else report.blocked.push({id,pid});
        continue;
      }
      (own||named||heldElsewhere(id)?report.adopted:report.blocked).push({id,pid});
    }
    return report;
  }
  // The exact guard a proof is about: the enforcer kind and unit, and the published guard's pid, start, state, build and binding.
  // Synchronous and spawns nothing: one status-file read and one /proc read. Any change to it (replacement, exit, a new build)
  // gives a different identity, so a full `active` proof taken for the old one is never reused for the new one.
  const identitySync=row=>{
    const state=stateFor(payloadFor(row));
    if(!state||processStartSync(state.pid)!==state.start)return null;
    return JSON.stringify([row.deadline_enforcer?.kind??null,unitFor(row),state.pid,state.start,state.state,state.build_id,state.binding]);
  };
  const activeSync=row=>identitySync(row)!==null;
  // Observation remains evidence after its supervisor exits; execution still
  // requires the separate live-process checks above.
  const observed=row=>{try{
    const payload=payloadFor(row),state=readStatus(payload.statusPath);
    if(deadlineMaterialized(payload,state))return true;
    // A detached fallback can publish observation and exit before register's
    // descriptor reaches the journal. Observation outlives that process, so
    // discover its exact alternate binding without requiring live protection.
    return !row.deadline_enforcer&&deadlineMaterialized({...payload,launchMode:'guard'},state);
  }catch{return false;}};
  let statusCursor=0;
  // Status files outlive guard exit. Prune only in background, in small batches,
  // after both the row and a positively identified publisher are gone. Stable
  // lock directories are deliberately retained: unlinking those races owners.
  async function pruneStatuses({signal}={}) {
    let names;try{names=fs.readdirSync(directory).filter(name=>/^[a-f0-9-]{36}\.json\.deadline$/.test(name)).sort();}catch{return;}
    const recordExists=file=>{try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
    const count=Math.min(32,names.length);
    for(let i=0;i<count;i++) {
      signal?.throwIfAborted();
      const status=path.join(directory,names[(statusCursor+i)%names.length]),record=status.slice(0,-9);
      try {
        if(recordExists(record)||fs.lstatSync(status).isSymbolicLink()||processLockOwners(status+'.lock').length)continue;
        const bytes=fs.readFileSync(status,'utf8'),state=JSON.parse(bytes);
        if(!Number.isSafeInteger(state.pid)||state.pid<=1||typeof state.start!=='string'||!state.start)continue;
        if(await processStart(state.pid)!==null)continue;
        if(recordExists(record)||fs.lstatSync(status).isSymbolicLink()||processLockOwners(status+'.lock').length||fs.readFileSync(status,'utf8')!==bytes)continue;
        fs.unlinkSync(status);
      }catch{/* Unknown ownership or concurrent publication keeps the status. */}
    }
    statusCursor=names.length?(statusCursor+count)%names.length:0;
  }
  return {register,active,activeSync,identitySync,observed,reconcileGuards,pruneStatuses};
}
