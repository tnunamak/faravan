#!/usr/bin/env node
// Headless bundle smoke: only a copy of the app and newly-created private state.
// No LaunchServices registration, login items, notifications or browser windows.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {gracefulShutdownProblems} from './macos-graceful-shutdown.mjs';
const run=promisify(execFile);
if(process.platform!=='darwin')throw new Error('This acceptance smoke requires macOS.');
const source=resolve(process.argv[2]??'');
assert.ok(source.endsWith('/Faravan.app'),'Pass the built Faravan.app');
const scratch=join(homedir(),'.tmp');await mkdir(scratch,{recursive:true});
const work=await mkdtemp(join(scratch,'faravan-mac-acceptance-'));
let child,ownedBackend,residentTarget;
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function waitUntil(check,label,tries=150){for(let i=0;i<tries;i++){if(await check())return;await new Promise(done=>setTimeout(done,100));}throw new Error(label);}
try {
  const parent=join(work,'relocated app with spaces'),app=join(parent,'Faravan.app');
  await mkdir(parent);await run('ditto',[source,app]);
  const home=join(work,'state'),userHome=join(work,'user');await mkdir(home);await mkdir(userHome);
  const cli=join(app,'Contents/MacOS/faravan'),node=join(app,'Contents/Resources/faravan/runtime/bin/node');
  const env={...process.env,HOME:userHome,FARAVAN_HOME:home,FARAVAN_NO_BROWSER:'1',FARAVAN_NO_UPDATE:'1',PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
  delete env.NODE_OPTIONS;delete env.NODE_PATH;
  const runtime=await run(node,['--version'],{env});assert.match(runtime.stdout,/^v\d+\./);
  // Resolve the production SDK from this relocated bundle, not the checkout.
  // Import/identity only: do not create a client or exercise a live provider.
  const runtimeRoot=join(app,'Contents/Resources/faravan');
  await run(node,['--input-type=module','--eval',String.raw`
    import assert from 'node:assert/strict';
    import {readFileSync,realpathSync} from 'node:fs';
    import {join,relative,isAbsolute,sep} from 'node:path';
    import {fileURLToPath,pathToFileURL} from 'node:url';
    const inside=(parent,candidate,label)=>{
      const actual=realpathSync(candidate),path=relative(parent,actual);
      assert.ok(path!==''&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path),
        label+' must remain inside '+parent);
      return actual;
    };
    const appRoot=realpathSync(process.argv[1]);
    const runtime=inside(appRoot,process.cwd(),'runtime root');
    const manifestPath=inside(runtime,join(runtime,'package.json'),'production manifest');
    const sdk=inside(runtime,join(runtime,'node_modules/@tnunamak/gozar'),'SDK directory');
    const metadata=inside(sdk,join(sdk,'package.json'),'SDK metadata');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    const pin=manifest.dependencies?.['@tnunamak/gozar'];
    const expected=typeof pin==='string'&&(/^file:vendor\/tnunamak-gozar-(\d+\.\d+\.\d+)\.tgz$/.exec(pin)?.[1]??pin);
    assert.equal(typeof expected,'string','production Gozar dependency is required');
    assert.match(expected,/^\d+\.\d+\.\d+$/,'production Gozar dependency must be an exact version pin');
    const installed=JSON.parse(readFileSync(metadata,'utf8'));
    assert.equal(installed.name,'@tnunamak/gozar','installed SDK package name');
    assert.equal(installed.version,expected,'installed SDK matches the production manifest pin');
    // Resolve without evaluation; then import only the checked real entry.
    const entry=inside(sdk,fileURLToPath(import.meta.resolve('@tnunamak/gozar')),'SDK import entry');
    const {createGozar}=await import(pathToFileURL(entry).href);
    assert.equal(typeof createGozar,'function','production createGozar export is callable');
  `,app],{cwd:runtimeRoot,env,timeout:15000,killSignal:'SIGKILL'});
  process.stdout.write('SDK CHECK: relocated bundled Node imports callable createGozar and installed package matches the production pin; no live provider or signing acceptance.\n');
  const help=await run(cli,['--help'],{env});assert.match(help.stdout,/Usage: faravan/);
  const login=await run(cli,['autostart','status','--json'],{env});assert.equal(JSON.parse(login.stdout).enabled,false);
  child=spawn(cli,['app','--json'],{env,stdio:'ignore'});
  const exited=once(child,'exit');
  let record;
  for(let i=0;i<150;i++) {
    record=await readFile(join(home,'v1/app.json'),'utf8').then(JSON.parse,()=>null);
    if(record)break;
    if(child.exitCode!==null)throw new Error('Installed app exited before readiness.');
    await new Promise(done=>setTimeout(done,100));
  }
  assert.ok(record,'installed app became ready');
  const origin='http://127.0.0.1:'+record.port,headers={'x-faravan-session-token':record.token};
  assert.equal((await fetch(origin+'/api/status',{signal:AbortSignal.timeout(5000)})).status,401);
  const response=await fetch(origin+'/api/status',{headers,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);
  const status=await response.json();assert.equal(status.desktop.platform,'mac');assert.equal(status.lending.enabled,false);
  child.kill('SIGTERM');
  const [exitCode,exitSignal]=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('App did not stop gracefully.')),15000);timer.unref();})]);
  child=null;
  const recordRemoved=await readFile(join(home,'v1/app.json'),'utf8').then(()=>false,()=>true);
  const shutdownProblems=gracefulShutdownProblems({exitCode,exitSignal,recordRemoved});
  if(shutdownProblems.length)throw new Error('Graceful shutdown failed: '+shutdownProblems.join('; '));
  if(process.argv.includes('--with-launcher')) {
    // On macOS an unmanaged --background registers a session LaunchAgent and returns (lib/v1/macos-session.mjs).
    // launchd then starts the resident launcher with --managed. That launcher owns the backend, and launchd restarts it after a crash.
    const launcher=join(app,'Contents/MacOS/faravan-launch');
    const record=()=>readFile(join(home,'v1/app.json'),'utf8').then(JSON.parse,()=>null);
    const trays=async backend=>(await run('pgrep',['-P',String(backend),'-f','faravan-tray']).catch(()=>({stdout:''}))).stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    const residentPid=async()=>{const result=await run('launchctl',['print',residentTarget]).catch(()=>({stdout:''}));const pid=Number(result.stdout.match(/^\s*pid = (\d+)$/m)?.[1]);return pid>1?pid:null;};
    const parentOf=async pid=>Number((await run('ps',['-o','ppid=','-p',String(pid)]).catch(()=>({stdout:''}))).stdout.trim())||null;
    const readyAfter=async (previous,label)=>{let found,trayPids=[];await waitUntil(async()=>{found=await record();if(!found||found.pid===previous)return false;trayPids=await trays(found.pid);return trayPids.length===1;},label,300);return {backend:found.pid,trayPids};};
    await run(launcher,['--background'],{env,timeout:30000});
    const label=(await readFile(join(home,'v1/resident.plist'),'utf8')).match(/<key>Label<\/key><string>([^<]+)<\/string>/)?.[1];
    assert.ok(label,'the session LaunchAgent names its label');
    residentTarget='gui/'+process.getuid()+'/'+label;
    const first=await readyAfter(null,'Native launcher did not become ready with exactly one tray.');
    assert.ok(Number.isSafeInteger(first.backend)&&first.backend>1,'native backend has a valid owned PID');
    ownedBackend=first.backend;
    const resident=await residentPid();
    assert.ok(resident,'launchd runs the resident launcher');
    assert.match((await run('ps',['-o','command=','-p',String(resident)])).stdout,/faravan-launch --background --managed/,'launchd started the launcher with --managed');
    let ancestor=first.backend;
    for(let i=0;i<4&&ancestor&&ancestor!==resident;i++)ancestor=await parentOf(ancestor);
    assert.equal(ancestor,resident,'the managed launcher owns the backend');
    await run(launcher,['--background'],{env,timeout:15000});
    assert.equal((await record())?.pid,first.backend,'duplicate native launch reused the backend');
    assert.equal(await residentPid(),resident,'duplicate native launch reused the resident launcher');
    process.kill(resident,'SIGKILL');
    await waitUntil(async()=>!alive(first.backend)&&first.trayPids.every(pid=>!alive(pid)),'Force Quit left an owned backend or tray running.');
    const second=await readyAfter(first.backend,'launchd did not restart Faravan after Force Quit.');
    ownedBackend=second.backend;
    assert.notEqual(await residentPid(),resident,'launchd started a new resident launcher');
    await run('launchctl',['bootout',residentTarget],{timeout:30000});residentTarget=null;
    await waitUntil(async()=>!alive(second.backend)&&second.trayPids.every(pid=>!alive(pid)),'launchd bootout left an owned backend or tray running.');
    assert.equal(await record(),null,'launchd bootout removed the app record');
    ownedBackend=null;
    process.stdout.write('PASS: unmanaged background launch hands off to launchd, managed launcher owns backend/tray, duplicate reuse, Force Quit removes backend/tray and launchd restarts it, launchd bootout (the logout signal) stops it cleanly.\n');
  }
  process.stdout.write('PASS: relocated bundle, CLI without system Node, authenticated readiness, lending off, graceful shutdown.\n');
  process.stdout.write('UNPROVEN: Finder/Gatekeeper approval, notification permission/click, login/logout, sandbox VM and first borrowed job.\n');
} finally {
  if(child&&child.exitCode===null){child.kill('SIGKILL');await once(child,'exit').catch(()=>{});}
  if(residentTarget)await run('launchctl',['bootout',residentTarget],{timeout:30000}).catch(()=>{});
  try {
    if(ownedBackend&&alive(ownedBackend)){
      process.kill(ownedBackend,'SIGTERM');
      await waitUntil(()=>!alive(ownedBackend),'Owned backend did not clean up.').catch(async()=>{if(alive(ownedBackend))process.kill(ownedBackend,'SIGKILL');await waitUntil(()=>!alive(ownedBackend),'Owned backend survived cleanup.');});
    }
  }finally{await rm(work,{recursive:true,force:true});}
}
