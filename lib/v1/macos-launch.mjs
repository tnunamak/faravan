// The macOS launch supervisor. Faravan.app/Contents/MacOS/faravan-launch (packaging/macos/launcher/main.swift) runs
//   runtime/bin/node lib/v1/macos-launch.mjs [--background | --open-only] --tray <MacOS/faravan-tray>
// with a pipe as standard input and holds the only write end. End of input means "stop": the launcher quit, the
// session is logging out, or the launcher was force-quit (the kernel closes the pipe; no handler has to run).
//
// One launcher owns a home at a time (v1/launch.lock). It starts the app in this process, or reuses an app that is
// already running (started by the CLI or the service), and owns the tray as a child whose standard input is also a
// pipe. A second launch only opens the running app through the one-time handoff route; it starts and signals nothing.
// Stopping closes only an app this process started, through the app's own close (the lender drains, discovery is
// removed). A reused app and any other process are never signaled.
import { spawn, execFile } from 'node:child_process';
import {promisify} from 'node:util';
import {fstatSync, mkdirSync, chmodSync, openSync, fchmodSync, writeSync, readSync, ftruncateSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import { mkdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {residentQuit,setResidentQuit} from './resident-intent.mjs';


import {launchFailure,readLaunchFailure} from './launch-status.mjs';
export {launchFailure,readLaunchFailure} from './launch-status.mjs';
// Only fixed categories cross this boundary; no error messages, paths or credentials.
export function saveLaunchFailure(home, failure, {now=Date.now}={}) {
  const directory=join(home,'v1'),file=join(directory,'start-failure.json'),temp=file+'.'+process.pid+'.new';
  const {code,kind}=launchFailure(failure);
  const row={version:1,code,kind,at:now()};
  try {
    mkdirSync(directory,{recursive:true,mode:0o700});
    writeFileSync(temp,JSON.stringify(row)+'\n',{mode:0o600});
    renameSync(temp,file);
  } finally { try {unlinkSync(temp);} catch {} }
  return row;
}
export function clearLaunchFailure(home) {
  try {unlinkSync(join(home,'v1','start-failure.json'));} catch(error) {if(error.code!=='ENOENT')throw error;}
}
export async function offlineLaunchStatus(home,{discover=discoverRunningApp}={}) {
  const failure=readLaunchFailure(home);
  if(!failure||await discover(home))return null;
  return {running:false,start_failure:failure};
}
export async function waitForLaunch(home,{discover=discoverRunningApp,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,waitMs=15000}={}) {
  const deadline=now()+waitMs;
  for(;;) {
    const found=await discover(home);
    if(found)return found;
    if(now()>=deadline) {
      const failure=readLaunchFailure(home);
      throw Object.assign(new Error('Faravan session did not start.'),{code:failure?.code??'app_start_failed'});
    }
    await sleep(Math.min(100,Math.max(0,deadline-now())));
  }
}

const USAGE = 'Usage: macos-launch.mjs [--background | --open-only] [--tray /absolute/path/to/faravan-tray]';

/** Synchronous so fatal startup diagnostics survive the CLI's immediate exit. */
export function createLaunchLogger(home, {stderr = process.stderr} = {}) {
  return line => {
    let text;
    try { text = new Date().toISOString() + ' ' + line + '\n'; }
    catch { return; }
    try { stderr.write(text); } catch {}
    let fd;
    try {
      const directory = join(home, 'v1', 'logs');
      mkdirSync(directory, {recursive:true, mode:0o700});
      chmodSync(directory, 0o700);
      fd = openSync(join(directory, 'launcher.log'), 'a+', 0o600);
      fchmodSync(fd, 0o600);
      writeSync(fd, text);
      const size = fstatSync(fd).size;
      if (size > 1024 * 1024) {
        const tail = Buffer.alloc(512 * 1024);
        let read = 0;
        while (read < tail.length) {
          const count = readSync(fd, tail, read, tail.length - read, size - tail.length + read);
          if (!count) break;
          read += count;
        }
        ftruncateSync(fd, 0);
        writeSync(fd, tail.subarray(0, read));
      }
    } catch { /* Logging must never turn a recoverable launch into a failure. */ }
    finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  };
}

// lock.mjs exposes the immutable owner-record path in lock_busy diagnostics.
// Read it only for diagnostics, never to decide takeover or signal a process.
async function launchLockOwnerPid(home, error) {
  try {
    const prefix = join(home, 'v1', 'launch.lock') + '.owners-v1/';
    const message = String(error.message);
    const start = message.indexOf(prefix);
    if (start < 0) return null;
    const name = message.slice(start + prefix.length).split(';')[0];
    if (!/^[0-9a-f-]{36}\.choosing$/.test(name)) return null;
    const record = JSON.parse(process.platform === 'win32'
      ? await readFile(prefix + name, 'utf8') : await readlink(prefix + name));
    return Number.isSafeInteger(record?.pid) && record.pid > 0 ? record.pid : null;
  } catch { return null; }
}

export function parseLaunchArgs(argv) {
  const options = {background:false, openOnly:false, trayPath:null};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--background') options.background = true;
    else if (arg === '--managed') options.managed = true;
    else if (arg === '--open-only') options.openOnly = true;
    else if (arg === '--tray' && argv[i + 1]?.startsWith('/')) options.trayPath = argv[++i];
    else if (arg.startsWith('-psn_')) continue; // Finder on older macOS adds a process serial number.
    else throw new Error(USAGE);
  }
  return options;
}

/** The running app from v1/app.json, if its process is alive and it answers with the recorded token; else null. */
export async function discoverRunningApp(home, {fetch = globalThis.fetch} = {}) {
  let record;
  try { record = JSON.parse(await readFile(join(home, 'v1', 'app.json'), 'utf8')); }
  catch { return null; }
  if (!Number.isInteger(record?.pid) || record.pid <= 0 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.token !== 'string' || !record.token) return null;
  try { process.kill(record.pid, 0); }
  catch (error) { if (error.code !== 'EPERM') return null; }
  const origin = 'http://127.0.0.1:' + record.port;
  try {
    const response = await fetch(origin + '/api/lending', {headers:{'x-faravan-session-token':record.token}, signal:AbortSignal.timeout(2000), redirect:'error'});
    await response.arrayBuffer();
    if (!response.ok) return null;
  } catch { return null; }
  return {origin, token:record.token, pid:record.pid};
}

/** A one-time sign-in link for a running app. The session token goes in a header, never in the URL opened. */
export async function handoffFor(found, {fetch = globalThis.fetch} = {}) {
  const fallback = found.origin + '/';
  try {
    const response = await fetch(found.origin + '/api/handoff', {method:'POST', body:'{}', signal:AbortSignal.timeout(5000), redirect:'error',
      headers:{'x-faravan-session-token':found.token, 'content-type':'application/json'}});
    if (!response.ok) return fallback;
    const {url} = await response.json();
    return typeof url === 'string' && url.startsWith(found.origin + '/auth/handoff?code=') ? url : fallback;
  } catch { return fallback; }
}

// Parent identity comes from the native launcher's actual parent relationship
// and executable, and tray identity comes from the child this supervisor spawned.
export async function managedProcessSnapshot({appPath,tray,pid=process.pid,parentPid=process.ppid,readBirth,readParentExecutable,pipeOwned}={}) {
  if(!appPath?.endsWith('.app')||!tray||!Number.isSafeInteger(tray.pid)||tray.pid<=0||tray.exitCode!==null||tray.signalCode!==null||
     !Number.isSafeInteger(parentPid)||parentPid<=1||parentPid===pid||tray.pid===pid||tray.pid===parentPid||await pipeOwned()!==true)
    throw new Error('Managed process ownership is unavailable');
  const native=join(appPath,'Contents/MacOS/faravan-launch');
  if(await readParentExecutable(parentPid)!==native)throw new Error('Native parent does not match the installation');
  const owners=[];
  for(const [role,id] of [['app',pid],['native',parentPid],['tray',tray.pid]]) {
    const a=await readBirth(id),b=await readBirth(id);
    if(!a||a.state!=='live'||!a.boot?.startsWith('darwin:')||!/^\d+$/.test(a.start??'')||
       b?.state!=='live'||a.boot!==b.boot||a.start!==b.start)throw new Error('Managed process birth cannot be verified');
    owners.push({role,pid:id,boot:a.boot,start:a.start,state:a.state});
  }
  if(tray.exitCode!==null||tray.signalCode!==null||await pipeOwned()!==true)throw new Error('Managed process ownership changed');
  return owners;
}

/**
 * Runs one launch. Returns {role:'duplicate'} when another launcher owns this home, else waits until something stops
 * it and returns {role:'primary', owned, reason}: reason is 'owner' (input ended or a signal), 'tray' (the tray quit
 * cleanly) or 'app' (the app closed itself, for example after POST /api/shutdown from the tray's Quit).
 * With the shutdown boundary, an owned app's affirmative full-close result adds ownedCloseCompleted.
 */
export async function superviseMacLaunch({
  home, trayPath = null, background = false, openOnly = false, managed = false, ownerGone,
  acquireLock, discover, startApp, requestHandoff, openUrl, spawnTray, onOwnedReady, finishShutdown,
  onStartFailure = () => {}, onStartReady = () => {}, now = Date.now,
  shouldQuit = () => residentQuit(home), quitPollMs = 250,
  sleep = (ms,signal) => new Promise(resolve => {
    const timer=setTimeout(done,ms);
    function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}
    signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
  }), log = () => {}, waitMs = 15000, trayRestarts = 6,
}) {
  const waitForApp = async () => {
    for (const end = now() + waitMs; ;) {
      const found = await discover(home);
      if (found || now() >= end) return found;
      await sleep(100);
    }
  };
  let release = null, lockError = null;
  if (!openOnly) {
    try { release = await acquireLock(join(home, 'v1', 'launch.lock')); }
    catch (error) { if (error.code !== 'lock_busy') throw error; lockError = error; }
  }
  if (!release) {
    if (!background) {
      const found = await waitForApp();
      if (found) openUrl(await requestHandoff(found));
      else if (lockError) {
        const pid = await launchLockOwnerPid(home, lockError);
        log('Faravan launch lock is held by ' + (pid === null ? 'an unknown PID' : 'PID ' + pid) + '; no app answered.');
        throw Object.assign(new Error('Faravan launch lock is held; no app answered.'), {code:'launch_lock_held'});
      } else {
        log('Faravan is not running yet; nothing was opened.');
        if (openOnly) throw Object.assign(new Error('Faravan is not running yet; nothing was opened.'), {code:'app_unavailable'});
      }
    }
    return {role:'duplicate'};
  }

  let reason = null, stop;
  const recoveryAbort=new AbortController(); let recoveryHandoff=false;
  const stopped = new Promise(resolve => { stop = why => {
    if (!reason) { reason = why; if(!recoveryHandoff)recoveryAbort.abort(); resolve(); }
  }; });
  ownerGone.then(why => stop(why==='quit'?'quit':'owner'));
  let app = null, reused = null, failures=0, tray=null, restarts=0, quitPoll=null, trayUnavailable=false;
  const clearQuitPoll=()=>{if(quitPoll!==null){clearInterval(quitPoll);quitPoll=null;}};
  const checkQuit=()=>{try{if(shouldQuit())stop('quit');}catch{stop('quit');}};
  const startTray = () => {
    if (!trayPath || reason || trayUnavailable) return;
    let child;
    try {child=tray=spawnTray(trayPath);}
    catch {trayUnavailable=true;log('Faravan could not start its menu bar icon.');return;}
    let finished=false,spawnFailure=null;
    child.once('error', error => {spawnFailure=error;log('Faravan could not start its menu bar icon.');});
    const ended = code => {
      if(finished)return;finished=true;
      if (reason || child !== tray) return;
      if (code === 0&&!spawnFailure) return stop('tray');
      tray=null;
      if (!['ENOENT','EACCES','EPERM','ENOEXEC','EINVAL','ENOTDIR','EISDIR'].includes(spawnFailure?.code)&&restarts++ < trayRestarts) {
        log('The menu bar icon stopped; starting it again.');
        sleep(Math.min(30000,1000*2**Math.min(restarts-1,5)),recoveryAbort.signal).then(()=>{if(!tray)startTray();});
      } else {
        trayUnavailable=true;
        log('The menu bar icon could not start. Open Faravan again to check it.');
        if(background&&(app||reused))Promise.resolve(app?app.handoffUrl():requestHandoff(reused)).then(openUrl)
          .catch(()=>log('Open Faravan again to use it in the browser.'));
      }
    };
    child.once('exit',ended);child.once('close',ended);
  };
  try {
    while(!reason) {
      if(managed&&failures){checkQuit();if(reason)break;}
      try {
        reused = await discover(home);
        if(reason)break;
        if(!reused) {
          try {
            // Quit does not wait for a slow start. The start keeps running; shutdown closes whatever it produces.
            const starting=Promise.resolve(startApp());
            const first=await Promise.race([starting.then(value=>({value}),error=>({error})),stopped.then(()=>null)]);
            if(first===null){app={close:()=>starting.then(late=>late?.close?.(),()=>{})};break;}
            if(first.error)throw first.error;
            app=first.value;
          }
          catch(error) {
            if(error.code!=='app_already_running')throw error;
            reused=await waitForApp();
            if(!reused)throw Object.assign(new Error('The running Faravan app is not responding.'),{code:'app_unavailable'});
          }
        }
        if(managed&&failures){checkQuit();if(reason)break;}
        try {await onStartReady();} catch {log('Faravan could not clear its startup diagnostic.');}
        break;
      } catch(error) {
        if(reason)break;
        const failure=launchFailure(error);
        try {await onStartFailure(failure);} catch {log('Faravan could not save its startup diagnostic.');}
        log('Faravan could not start: '+failure.code+' (step=supervision, class='+failure.kind+')');
        if(!managed)throw error;
        if(!tray)startTray();
        if(quitPoll===null){quitPoll=setInterval(checkQuit,quitPollMs);quitPoll.unref?.();}
        checkQuit();if(reason)break;
        await sleep(Math.min(300000,5000*2**Math.min(failures++,6)),recoveryAbort.signal);
      }
    }
  } catch(error) {clearQuitPoll();recoveryAbort.abort();tray?.stdin?.end();release();throw error;}
  clearQuitPoll();
  if (app) app.server?.once('close', () => stop('app'));
  if (!reason) {
    if (!background) openUrl(app ? app.handoffUrl() : await requestHandoff(reused));
    if(!tray)startTray();
    if(app && tray && typeof onOwnedReady==='function')
      void (async()=>{
        let failures=0;
        while(!reason&&!recoveryAbort.signal.aborted){
          try {await onOwnedReady({app,tray,getTray:()=>tray,signal:recoveryAbort.signal,markHandoff:()=>{if(reason||recoveryAbort.signal.aborted)return false;recoveryHandoff=true;return true;}});return;}
          catch(error){
            log('Faravan update recovery: '+(error.code??'unavailable'));
            if(error.reason==='lock_stale'||!['lock_busy','EIO','EAGAIN','EBUSY','EMFILE','ENFILE','ETIMEDOUT'].includes(error.code)||failures>=6){
              log('Automatic update recovery stopped. Check the Faravan log before opening Faravan again.');
              return;
            }
          }
          await sleep(Math.min(30000,1000*2**Math.min(failures++,5)),recoveryAbort.signal);
        }
      })();
  }
  await stopped;
  if(!recoveryHandoff)recoveryAbort.abort();
  tray?.stdin?.end(); // The owned tray quits on end of input; it is not signaled.
  // The production boundary owns the bounded tray/full-close sequence. Keep the default
  // await for standalone supervisors, and retain the launch lock until that sequence ends.
  let ownedCloseCompleted = false;
  if (finishShutdown) {
    const completed = await finishShutdown({app, reason});
    ownedCloseCompleted = Boolean(app) && completed === true;
  } else if (app && reason !== 'app') await app.close();
  // Without a boundary, 'app' close is still finishing; the caller lets the process drain.
  if (reason !== 'app') release();
  return {role:'primary', owned:Boolean(app), reason, ...(ownedCloseCompleted ? {ownedCloseCompleted} : {})};
}

/** Install before supervision so a second signal can escape even a stalled startup or close. */
export function createMacLaunchShutdown({
  stdin = process.stdin, signals = process, exit = code => process.exit(code),
  setExitCode = code => { process.exitCode = code; }, onQuit = () => {},
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
} = {}) {
  let explicit = false, signalCount = 0, exited = false;
  const forceExit = () => { if (!exited) { exited = true; exit(0); } };
  const ownerGone = new Promise(resolve => {
    stdin.on('data', chunk => {
      if (chunk.toString().includes('quit\n')) { explicit = true; onQuit(); }
    });
    const ended = () => resolve(explicit ? 'quit' : 'owner');
    stdin.once('end', ended); stdin.once('error', ended); stdin.once('close', ended);
    // Keep all three handlers installed after the first signal and after orderly shutdown.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.on(signal, () => {
      if (++signalCount > 1) forceExit();
      else resolve('owner');
    });
    stdin.resume();
  });
  const bounded = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const finish = async ({trayExits = [], appClosed = Promise.resolve()} = {}) => {
    // Observe rejection immediately, even while the tray is still being reaped.
    const closing = Promise.resolve(appClosed).then(
      result => ({ok:true, completed:result?.state === 'closed'}),
      error => ({ok:false, error}),
    );
    const traysClosed = await bounded(Promise.all(trayExits), 10000);
    stdin.pause(); stdin.destroy();
    // Server 'close' is not full app cleanup: discovery and locks can still be draining.
    // Start the existing 30-second allowance only after the bounded tray wait.
    const appDone = await bounded(closing.then(result => {
      if (!result.ok) throw result.error;
      return result.completed;
    }), 30000);
    if (exited) return false;
    if (traysClosed === null || appDone === null) {
      forceExit();
      return false;
    }
    setExitCode(0); // Cooperative shutdown drains naturally; do not orphan startup probes.
    return appDone;
  };
  return {ownerGone, finish};
}

export async function runMacLaunch({
  argv = process.argv.slice(2), platform = process.platform,
  loadConfig = () => import('../local-state.mjs'),
  loadSession = () => import('./macos-session.mjs'),
  stderr = process.stderr, exit = code => process.exit(code),
} = {}) {
  let log = null, home = null, step = 'arguments';
  try {
    let options;
    try { options = parseLaunchArgs(argv); }
    catch { try { stderr.write(USAGE + '\n'); } catch {} return exit(2); }
    step = 'data-home';
    const { configHome } = await loadConfig();
    home = configHome();
    log = createLaunchLogger(home, {stderr});
    step = 'startup-imports';
    const { acquireProcessLock } = await import('./lock.mjs');
    const { openUrl } = await import('./open-url.mjs');
    step = 'resident-intent';
    if(options.background&&residentQuit(home))return;
    if(!options.openOnly&&!options.background)setResidentQuit(false,home);
    if(platform==='darwin'&&!options.managed&&!options.openOnly){
      step = 'session-import';
      const {ensureMacSession}=await loadSession();
      step = 'session-registration';
      await ensureMacSession({home});
      step = 'session-readiness';
      if(!options.background){
        const found=await waitForLaunch(home);
        openUrl(await handoffFor(found));
      }
      return;
    }
    step = 'supervision';
    // End of input, or a signal (launchd at logout, a terminal), means stop. Both run the same orderly path.
    const shutdown = createMacLaunchShutdown({exit, onQuit:() => setResidentQuit(true,home)});
    const {ownerGone} = shutdown;
    const trayExits = [];
    const result = await superviseMacLaunch({
      ...options, home, ownerGone, log,
      onStartFailure:failure=>saveLaunchFailure(home,{code:failure.code,name:failure.kind}),
      onStartReady:()=>clearLaunchFailure(home),
      finishShutdown:({app, reason}) => {
        step = 'shutdown';
        if (reason === 'quit' || reason === 'tray') setResidentQuit(true,home);
        // This is only the app this supervisor owns. close() returns its in-flight
        // full cleanup promise, including when the app initiated shutdown itself.
        return shutdown.finish({trayExits, appClosed:app ? app.close() : Promise.resolve()});
      },
      acquireLock:async path => {
        await mkdir(join(home, 'v1'), {recursive:true, mode:0o700});
        const release = await acquireProcessLock(path, {timeoutMs:0});
        process.once('exit', release);
        return release;
      },
      onOwnedReady:options.managed&&process.platform==='darwin'?async ({app,getTray,signal,markHandoff})=>{
        const module=fileURLToPath(import.meta.url),suffix='/Contents/Resources/faravan/lib/v1/macos-launch.mjs';
        if(!module.endsWith(suffix))return;
        const appPath=module.slice(0,-suffix.length);
        if(options.trayPath!==join(appPath,'Contents/MacOS/faravan-tray'))return;
        const run=promisify(execFile), identityPath=join(appPath,'Contents/MacOS/faravan-process-identity');
        const snapshot=()=>{const parent=process.ppid;return managedProcessSnapshot({appPath,tray:getTray(),parentPid:parent,
          pipeOwned:async()=>{try{return process.ppid===parent&&parent>1&&fstatSync(0).isFIFO();}catch{return false;}},
          readBirth:async pid=>JSON.parse((await run(identityPath,[String(pid)],{timeout:2500,encoding:'utf8'})).stdout),
          readParentExecutable:async pid=>{const result=await run('/bin/ps',['-p',String(pid),'-o','comm='],{timeout:2500,encoding:'utf8'});return realpath(result.stdout.trim());}});};
        app.registerManagedUpdateContext?.({snapshot,signal,markHandoff});
        await app.recoverManagedUpdate?.({snapshot,signal,onHandoff:markHandoff});
      }:undefined,
      discover:found => discoverRunningApp(found),
      requestHandoff:found => handoffFor(found),
      openUrl:url => openUrl(url),
      startApp:async () => {
        // The same path as `faravan app`; the wrapper only keeps the start error (cli.mjs prints it instead of throwing).
        const [{ runV1Command }, { startApp }] = await Promise.all([import('./cli.mjs'), import('./app.mjs')]);
        let app = null, failure = null;
        const quiet = {isTTY:false, write:() => true};
        await runV1Command(['app'], {
          // A signal that never aborts keeps cli.mjs from installing its own exit-on-SIGTERM; this module closes the app.
          signal:new AbortController().signal, residentAutostart:options.background, openUrl:false, stdout:quiet, stderr:quiet, onApp:value => { app = value; },
          startApp:async options => { try { return await startApp(options); } catch (error) { failure = error; throw error; } },
        });
        if (!app) throw failure ?? Object.assign(new Error('Faravan could not start.'), {code:'app_start_failed'});
        return app;
      },
      spawnTray:path => {
        const child=spawn(path, [], {stdio:['pipe', 'ignore', 'inherit'], env:{...process.env, FARAVAN_TRAY_OWNER:'stdin'}});
        trayExits.push(new Promise(resolve=>{child.once('close',resolve);child.once('error',resolve);}));
        return child;
      },
    });
    step = 'shutdown';
    // Duplicates return before the stopping boundary: no owned app or tray exists.
    if (result.role === 'duplicate') await shutdown.finish();
  } catch (error) {
    // Error names, codes and messages can contain paths, prompts or credentials.
    // Only fixed categories cross this diagnostic boundary; never stringify errors.
    const failure=launchFailure(error),kind=failure.kind;
    let code='';
    try {if(launchFailure(error).code===error?.code)code=error.code;} catch {}
    if(home&&step==='supervision')try {saveLaunchFailure(home,{code:failure.code,name:kind});} catch {}
    const line = 'Faravan could not start: ' + (code || kind) + ' (step=' + step + ', class=' + kind + ')';
    if (log) log(line);
    else try { stderr.write(line + '\n'); } catch {}
    return exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runMacLaunch();
