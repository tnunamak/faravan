import fs from 'node:fs';
import {spawnSbxChild} from '../../lib/docker-backend.mjs';
import {hostDefaultSbxRuntime} from '../../lib/sbx-runtime.mjs';
export const sbxSync=(binary,args,options)=>{const result=spawnSbxChild(hostDefaultSbxRuntime({binary,env:options.env,currentEnv:()=>options.env}),args,{...options,mode:'sync'});if(result.error)throw result.error;if(result.status!==0)throw Object.assign(new Error('Sandbox command failed'),{status:result.status});return result.stdout;};
import {isDeepStrictEqual} from 'node:util';
import {activeSandboxNames,parseSbxListing} from '../../lib/docker-backend.mjs';

export const OWNER_SBX_HOME='/home/example/.fsbx/29a653';
export const MIN_FREE_BYTES=16n*1024n**3n;
export function recordRefusal(file,args) {
  const known=new Set(['daemon','login','logout','secret','secrets','policy','start','stop','restart','set','set-custom','import','rm','ls','allow','deny','init','reset']);
  if(file)fs.appendFileSync(file,JSON.stringify(args.slice(0,2).map(v=>known.has(v)?v:'other'))+'\n',{mode:0o600});
}
export async function loginStatus({realSbx,env,browserOpener,browserMarker,timeoutMs=30000}) {
  // Leave time to reap the login child before the product's outer 30 s CLI timeout.
  const deadline=Date.now()+Math.min(timeoutMs,28000);
  let diagnosis;
  try {diagnosis=sbxSync(realSbx,['diagnose'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:Math.min(timeoutMs,28000),killSignal:'SIGKILL'});}
  catch(error){throw Error(error.code==='ETIMEDOUT'||Date.now()>=deadline?'login_status_timeout':'login_status_diagnose_failed');}
  if(!/\bAuthentication\b[^\n]*\bauthenticated\b/i.test(diagnosis)||/\bnot authenticated\b/i.test(diagnosis))throw Error('login_status_not_authenticated');
  return new Promise((resolve,reject)=>{
    let output='',reason=null,timer,watch;
    const child=spawnSbxChild(hostDefaultSbxRuntime({binary:realSbx,env,currentEnv:()=>env}),['login'],{mode:'spawn',env:{...env,BROWSER:browserOpener,DISPLAY:'',WAYLAND_DISPLAY:''},stdio:['ignore','pipe','pipe']});
    const stop=why=>{reason??=why;child.kill('SIGKILL');};
    const collect=data=>{
      output+=data.toString();
      if(/http|\bopen\b|\bcode\b|\b(?:visit|browse|verification|authorize)\b/i.test(output))stop('login_status_interactive_output');
      if(output.length>1024*1024)stop('login_status_output_limit');
    };
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    timer=setTimeout(()=>stop('login_status_timeout'),Math.max(1,deadline-Date.now()));
    watch=setInterval(()=>{if(fs.existsSync(browserMarker))stop('login_status_browser_called');},20);
    child.once('error',()=>{reason??='login_status_spawn_failed';});
    child.once('close',code=>{
      clearTimeout(timer);clearInterval(watch);
      if(fs.existsSync(browserMarker))reason='login_status_browser_called';
      if(reason)return reject(Error(reason));
      if(code!==0||!/(?:You are signed in|Signed in as)/i.test(output))return reject(Error('login_status_unconfirmed'));
      resolve(output);
    });
  });
}
export async function waitForAgents(read,{now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=10*60*1000}={}) {
  const end=now()+timeoutMs;
  for(;;){
    const rows=await read();
    if(['claude-code-subscription','codex'].every(id=>{const row=rows.find(r=>r.id===id);return row&&row.signInState!=='Checking';}))return rows;
    if(now()>=end)throw Error('Agent checks still Checking after 10 minutes');
    await pause(Math.min(1000,end-now()));
  }
}
export function daemonEnvironment(home,{read=fs.readFileSync,pid=3230418}={}) {
  const argv=read(`/proc/${pid}/cmdline`,'utf8').split('\0');
  if(!argv[0]?.endsWith('/sbx')||argv[1]!=='daemon'||argv[2]!=='start')throw Error('Expected owner sbx daemon is not running; no daemon started');
  const all=Object.fromEntries(read(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
  const env=Object.fromEntries(Object.entries(all).filter(([k])=>k==='HOME'||k.startsWith('XDG_')||k==='DBUS_SESSION_BUS_ADDRESS'));
  if(env.HOME!==home)throw Error('Owner home differs from running daemon');
  return env;
}
export function requireDisk(home,statfs=fs.statfsSync) {
  const disk=statfs(home,{bigint:true}),free=disk.bavail*disk.bsize;
  if(free<MIN_FREE_BYTES)throw Error('Owner sbx filesystem has less than 16 GiB free');
  return Number(free);
}
export async function waitForIdle(list,{now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=30*60*1000,report=()=>{}}={}) {
  const end=now()+timeoutMs;
  for(;;){
    const result=list(),active=activeSandboxNames(result);
    if(active===null)throw Error('Cannot verify running sandboxes');
    if(!active.length)return parseSbxListing(result).sort();
    if(now()>=end)throw Error('Owner sbx home did not become idle within 30 minutes');
    report(active.length);await pause(Math.min(5000,end-now()));
  }
}
export function policyRules(output) {
  const rows=JSON.parse(output).rules;
  if(!Array.isArray(rows)||rows.some(r=>typeof r?.id!=='string'||!r.id)||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('Cannot verify policy snapshot');
  return rows;
}
export function policyDiff(before,after) {
  const old=new Map(before.map(r=>[r.id,r])),current=new Map(after.map(r=>[r.id,r]));
  for(const [id,row] of old)if(!isDeepStrictEqual(row,current.get(id)))throw Error('An older policy rule changed');
  return after.filter(r=>!old.has(r.id));
}
// Deny unknown secret verbs too. Global flags cannot hide a forbidden command.
export function commandAllowed(args,before=[],after=[],ownedNames=[]) {
  const a=args.filter(x=>!['--no-input','--debug','-D'].includes(x));
  if(!a[0]||a[0].startsWith('-')||['daemon','login','logout'].includes(a[0]))return false;
  if(['secret','secrets'].includes(a[0]))return a[1]==='ls';
  if(a[0]==='policy') {
    if(['allow','deny'].includes(a[1]))return a.length===6&&a[2]==='network'&&a[3]==='--sandbox'&&ownedNames.includes(a[4]);
    if(a[1]==='rm') {
      if(a.length!==8||a[2]!=='network'||a[3]!=='--sandbox'||a[5]!=='--id'||a[7]!=='--force')return false;
      return policyDiff(before,after).some(r=>r.id===a[6]&&r.scope==='sandbox:'+a[4]&&r.applies_to===r.scope&&r.resource_type==='network');
    }
    return ['ls','check','log','inspect'].includes(a[1]);
  }
  return true;
}
// Executed as the run's sbx wrapper. Never echo command arguments or CLI output here.
if(process.argv[2]==='--wrapper') {
  const [configFile,...args]=process.argv.slice(3),cfg=JSON.parse(fs.readFileSync(configFile,'utf8'));
  const env={...process.env,...cfg.env};
  if(args.length===1&&args[0]==='login') {
    try {process.stdout.write(await loginStatus({...cfg,env}));process.exit(0);}
    catch(e){recordRefusal(cfg.refusalLog,args);if(cfg.stopFile)fs.writeFileSync(cfg.stopFile,e.message,{mode:0o600});console.error(e.message);process.exit(125);}
  }
  let allowed=false;
  try {
    const ownedNames=(cfg.ownedJournals??[]).flatMap(dir=>{
      try{return fs.readdirSync(dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(dir+'/'+n,'utf8')).sandbox_id).filter(n=>/^wf-[a-f0-9]{16}$/.test(n)&&!cfg.beforeSandboxes.includes(n));}
      catch(e){if(e.code==='ENOENT')return [];throw e;}
    });
    if(cfg.ownedNamesDir){
      fs.mkdirSync(cfg.ownedNamesDir,{recursive:true,mode:0o700});
      for(const name of ownedNames)fs.writeFileSync(cfg.ownedNamesDir+'/'+name,'',{mode:0o600});
    }
    const after=args.includes('rm')&&args.includes('policy') ? policyRules(sbxSync(cfg.realSbx,['policy','ls','--json','--include-inactive'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000})) : [];
    allowed=commandAllowed(args,cfg.before,after,ownedNames);
  }catch{}
  if(!allowed){recordRefusal(cfg.refusalLog,args);console.error('Runner forbids this sandbox command');process.exit(125);}
  try {sbxSync(cfg.realSbx,args,{env,stdio:'inherit'});}catch(e){process.exit(typeof e.status==='number'?e.status:1);}
}
