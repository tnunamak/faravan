// Source-only companion to smoke.mjs. No sign-in operations are exposed here.
import fs from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork, execFileSync} from 'node:child_process';
import {resolveSbxExecutable} from '../../lib/sbx-daemon-owner.mjs';
import {randomUUID} from 'node:crypto';
import {readPace50Attempts} from './evidence.mjs';
import {createSpendMonitor} from './local-lend-spend.mjs';
import {closeOwnedApp} from './local-lend-process.mjs';
import {sbxSync,OWNER_SBX_HOME,daemonEnvironment,requireDisk,waitForIdle,waitForAgents,policyRules,policyDiff} from './local-lend-safety.mjs';

const [source, mode] = process.argv.slice(2);
if (!source || !['--synthetic', '--preflight', '--live'].includes(mode)) throw Error('usage: node local-lend.mjs <source> --synthetic|--preflight|--live');
const src = resolve(source), live = mode !== '--synthetic', preflight = mode === '--preflight';
if (mode === '--live' && process.env.LOCAL_LEND_CONFIRM !== '1') throw Error('Set LOCAL_LEND_CONFIRM=1 to authorize three paid jobs');
const here = dirname(fileURLToPath(import.meta.url));
const run = fs.mkdtempSync(join(process.env.HOME, '.tmp', 'local-lend-'));
fs.chmodSync(run, 0o700);
// Fence product auto-repair: the journey may use an existing daemon, never control it.
const sbxBinDir=join(run,'bin');
fs.mkdirSync(sbxBinDir,{mode:0o700});
const realSbx=live ? resolveSbxExecutable('sbx',process.env) : '';
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const stopFile=join(run,'safety-stop');
function checkSafetyStop(){if(fs.existsSync(stopFile))throw Error('Sandbox status safety stop: '+fs.readFileSync(stopFile,'utf8'));}
const sbxHome = process.env.SMOKE_OWNER_SBX_HOME || process.env.LOCAL_LEND_SBX_HOME || OWNER_SBX_HOME;
let sbxEnv,beforePolicies,beforeSandboxes;
const sbxRead=args=>sbxSync(realSbx,args,{env:{...process.env,...sbxEnv},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
const listSandboxes=()=>({code:0,stdout:sbxRead(['ls','--json'])});
const listPolicies=()=>policyRules(sbxRead(['policy','ls','--json','--include-inactive']));
const CLAUDE = 'claude-code-subscription', HAIKU = 'claude-haiku-5-5';
const summary = {harnessVersion:1, jobsSubmitted:0, modelExecutions:0, mode, source: src, head: execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), pass:false, jobs:[], cleanup:[], caps:{perJobUsd:1.5,totalUsd:4}};
const apps = {}, observeSpend = createSpendMonitor();
let interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=true;});
let circle, timer, activeAttempt, totalSynthetic = 0;
const delay = ms => new Promise(r => {const t=setTimeout(r, ms);t.unref();});
async function until(label, fn, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if(interrupted)throw Error('Interrupted'); const value = await fn(); if (value) return value; await delay(500); }
  throw Error('Timed out: ' + label);
}
async function start(role) {
  const root = join(run, role), home = join(root, 'home');
  console.error(role+' app data: '+join(home,'.faravan'));
  for (const d of [root, home, join(root,'tmp'), join(root,'run'), join(root,'claude'), join(root,'codex')]) fs.mkdirSync(d,{recursive:true,mode:0o700});
  const log = fs.openSync(join(root,'app.log'),'a',0o600);
  const child = fork(join(here,'smoke-child.mjs'), [JSON.stringify({src,installRoot:src,role,lender:'owner',live,localLend:true,costUsd:0.1,tokens:{input:1200,output:300}})], {
    cwd:root, env:{PATH:live ? sbxBinDir+':'+process.env.PATH : process.env.PATH,...(live?{FARAVAN_SBX_BIN:join(sbxBinDir,'sbx')}:{}),HOME:home,TMPDIR:join(root,'tmp'),LANG:'C.UTF-8',
      CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),XDG_RUNTIME_DIR:join(root,'run'),
      FARAVAN_COORDINATOR_HOME:join(root,'coordinator'),FARAVAN_SBX_HOME:live ? sbxHome : join(root,'sbx'),
      FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:'',
      FARAVAN_NO_AUTOSTART:'1',FARAVAN_NO_UPDATE:'1',DBUS_SESSION_BUS_ADDRESS:'disabled:'},
    stdio:['ignore',log,log,'ipc']});
  fs.closeSync(log);
  const pending = new Map(); let next = 0;
  const app = {child,home,exited:false}; apps[role] = app;
  app.exit = new Promise(r => child.once('exit',(code,signal) => {app.exited=true;app.exitCode=code;app.signal=signal;r();}));
  child.on('message',m => {if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error('child control failed')):p.resolve(m.value);}});
  app.control = command => new Promise((resolve,reject) => {const id=++next;pending.set(id,{resolve,reject});child.send({id,command});});
  const ready = await Promise.race([new Promise(r => child.on('message',m => {if(m.ready)r(m.ready);})), app.exit.then(()=>{throw Error(role+' exited at startup');}), delay(90000).then(()=>{throw Error(role+' startup timeout');})]);
  Object.assign(app,{origin:ready.origin,token:ready.token});
  if (ready.installedAppModule !== join(src,'lib/v1/app.mjs')) throw Error('App did not load requested source');
}
async function op(role,id,input={},confirm=false) {
  const cleanup=['lending.off','hosting.stop','lending.stop_job'].includes(id);
  if(!cleanup)checkSafetyStop();
  if(preflight && id==='jobs.submit') throw Error('Preflight cannot submit jobs');
  const a=apps[role];
  const response=await fetch(a.origin+'/api/ops/'+id,{method:'POST',headers:{'content-type':'application/json','x-faravan-session-token':a.token,'faravan-confirm':confirm?'yes':'no','idempotency-key':randomUUID()},body:JSON.stringify(input),signal:AbortSignal.timeout(id==='agents.check'?180000:60000)});
  const data=await response.json();
  if(!cleanup)checkSafetyStop();
  // Do not copy server error bodies: they can include circle addresses or private inputs.
  if(!response.ok)throw Error(role+' '+id+' HTTP '+response.status+' '+(data?.error?.code??data?.code??''));
  return data;
}
function cap(digest, terminal=false, executionStarted=false) {
  return observeSpend({digest, terminal, executionStarted,
    read: readPace50Attempts(join(apps.owner.home,'.faravan'),digest)});
}

try {
  if(live) {
    sbxEnv=daemonEnvironment(sbxHome);
    console.error('Daemon environment variable names: '+Object.keys(sbxEnv).sort().join(', '));
    summary.freeBytes=requireDisk(sbxHome);
    beforeSandboxes=await waitForIdle(listSandboxes,{report:n=>console.error('Waiting for '+n+' running sandbox(es) to become idle')});
    summary.freeBytes=requireDisk(sbxHome);
    beforePolicies=listPolicies();
    summary.sandboxesBefore=beforeSandboxes;
    console.error('sbx ls before: '+JSON.stringify(beforeSandboxes));
    console.error('sbx policy ls before rule ids: '+JSON.stringify(beforePolicies.map(r=>r.id).sort()));
    const configFile=join(run,'sbx-fence.json');
    const browserOpener=join(run,'no-browser'),browserMarker=join(run,'browser-called');
    fs.writeFileSync(browserOpener,'#!/bin/sh\n: > '+quote(browserMarker)+'\nexit 1\n',{mode:0o700});
    fs.writeFileSync(configFile,JSON.stringify({realSbx,env:sbxEnv,before:beforePolicies,beforeSandboxes,
      browserOpener,browserMarker,stopFile,refusalLog:join(run,'refused-verbs.jsonl'),
      ownedNamesDir:join(run,'owned-sandboxes'),ownedJournals:['owner','friend'].map(role=>join(run,role,'home','.faravan','v1','sandbox-cleanup'))}),{mode:0o600});
    fs.writeFileSync(join(sbxBinDir,'sbx'),'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(join(here,'local-lend-safety.mjs'))+' --wrapper '+quote(configFile)+' "$@"\n',{mode:0o700});
  }
  await start('owner'); await start('friend');
  console.error('Both source app homes started');
  const checked=await op('owner','agents.check',{agents:[CLAUDE,'codex']});
  const agents=await waitForAgents(()=>op('owner','agents.list'));
  summary.agents=agents.filter(a=>[CLAUDE,'codex'].includes(a.id)).map(a=>({id:a.id,installed:a.installed,signedIn:a.signedIn,proxySignedIn:a.proxySignedIn,signInState:a.signInState,signInReason:a.signInReason,models:a.models}));
  for(const id of [CLAUDE,'codex']) {
    const a=agents.find(a=>a.id===id);
    if(a?.installed!==true||a?.signedIn!==true||(live&&a?.proxySignedIn!==true))throw Error('Existing sandbox/provider sign-in not ready for '+id+'; no sign-in attempted');
    await op('owner','agents.select',{id,useForLending:true},true);
  }
  const prices=JSON.parse(fs.readFileSync(join(src,'lib/v1/lending-prices.json'),'utf8')).codex_credits;
  const candidates=agents.find(a=>a.id==='codex').models.map(model=>({model,price:prices.models[model]})).filter(p=>p.price);
  candidates.sort((a,b)=>(a.price.fresh_input_per_m+a.price.output_per_m)-(b.price.fresh_input_per_m+b.price.output_per_m));
  const codex=candidates[0]?.model;if(!codex)throw Error('No priced allowed Codex model');summary.codexModel=codex;
  await op('owner','agents.set_run',{id:CLAUDE,model:HAIKU,effort:null});
  await op('owner','agents.set_run',{id:'codex',model:codex,effort:'low'});
  const hosted=await op('owner','hosting.start',{tunnel:'lan',name:'Local lending check'},true);
  circle=hosted.circle_id;
  const invite=await op('owner','circles.invite',{circle,preset:'person'});
  await op('friend','circles.join',{link:invite.invite,acknowledgedWarning:true},true);
  await op('owner','circles.approve_device',{circle},true);
  await until('friend membership',async()=> (await op('friend','circles.check',{circle})).membershipProjection?.phase==='approved');
  const limits=await op('owner','limits.get');
  await op('owner','limits.set',{version:limits.configVersion,dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false,
    lendingPolicy:{...limits.limits.lendingPolicy,providerConsent:{claude:true,codex:true},accountPlans:{claude:'max20',codex:'pro'}}});
  await op('owner','lending.set_owner_settings',{maxJobUsd:1.5,reason:'Local source lending check'},true);
  await op('owner','lending.set_mode',{circle,mode:'auto'},true);
  await op('owner','lending.on',{circle},true);
  const lending=await op('owner','lending.get');
  if(!lending.enabled||lending.mode!=='auto')throw Error('Lending did not turn on automatically');
  summary.circleFormed=true;summary.lendingOn=true;
  console.error('Circle formed; both kits ready; automatic lending on');
  const presence=()=>fetch(apps.owner.origin+'/api/desktop/presence',{method:'POST',headers:{'content-type':'application/json','x-faravan-session-token':apps.owner.token},body:JSON.stringify({idleSeconds:900})}).catch(()=>{});
  await presence(); timer=setInterval(presence,20000);
  if(!preflight) {
    // Small public repository, immutable commit. The real executor clones and validates it in the guest.
    const git={url:'https://github.com/octocat/Hello-World.git',commit:'7fd1a60b01f91b314f59955a4e4d4e80d8edf11d'};
    for(const [label,harness,model,sourceInput] of [['claude-plain',CLAUDE,HAIKU,{noSource:true}],['codex-plain','codex',codex,{noSource:true}],['git-source',CLAUDE,HAIKU,{git}]]) {
      if(live){await waitForIdle(listSandboxes,{report:n=>console.error('Waiting for '+n+' running sandbox(es) before job')});requireDisk(sbxHome);}
      const before=live?null:await apps.owner.control('meter');
      const {jobDigest:digest}=await op('friend','jobs.submit',{circle,harness,model,...sourceInput,result:{kind:'message'},prompt:label==='git-source'?'Read README in the repository. Reply with its first line only.':'Reply with exactly: local lending works',title:label},true);
      summary.jobsSubmitted++;
      let owner;
      await until(label+' completion',async()=>{
        owner=await op('owner','jobs.get',{circle,digest});
        const a=owner.current_attempt;if(a?.attempt_id)activeAttempt=a.attempt_id;
        cap(digest,false,Boolean(a?.execution_started_at));
        const friend=await op('friend','jobs.get',{circle,digest});
        if(['failed','stopped','rejected','expired'].includes(friend.state))throw Error(label+' ended '+friend.state);
        return friend.state==='result-accepted';
      },300000);
      const receipt=await op('friend','jobs.receipt',{circle,digest});
      const transcript=await op('friend','jobs.transcript',{circle,digest});
      owner=await op('owner','jobs.get',{circle,digest});
      const finalCap=cap(digest,true);
      if(owner.ranHere!==true||owner.current_attempt?.state!=='completed'||!owner.current_attempt?.execution_started_at||owner.attempts_started!==1||!finalCap.processCeased||!finalCap.launchStarted||finalCap.guardModels.length!==1||finalCap.guardModels[0]?.requested!==model||finalCap.guardModels[0]?.served!==model||finalCap.guardModels[0]?.source!=='guard')throw Error(label+' lacks owner execution/cleanup proof');
      if(receipt.receipt?.harness!==harness||(receipt.receipt?.model!==null && receipt.receipt?.model!==model))throw Error(label+' receipt harness/model mismatch');
      const changes=await op('friend','jobs.changes',{circle,digest});
      if(!transcript?.text?.trim() || !changes.message?.markdown?.trim())throw Error(label+' missing friend result');
      if(label==='git-source'&&(receipt.receipt?.source?.kind!=='git'||receipt.receipt?.source?.commit!==git.commit || receipt.receipt?.verified_commit!==git.commit))throw Error('Git source receipt mismatch');
      if(live&&label==='git-source'&&!changes.message.markdown.includes('Hello World!'))throw Error('Git job did not return pinned README content');
      if(!live){const after=await apps.owner.control('meter');const costs=after.runs.slice(before.runs.length).map(r=>r.cost_usd);if(!costs.length||costs.some(c=>!Number.isFinite(c)||c>1.5))throw Error('Synthetic cost missing');totalSynthetic+=costs.reduce((a,b)=>a+b,0);if(totalSynthetic>4)throw Error('Synthetic run cap');}
      summary.modelExecutions++;
      summary.jobs.push({label,synthetic:!live,harness,model,ownerExecuted:true,friendReceived:true,isolationPassed:live?'required-before-execution':'fixture',guardPassed:live?'durable-guard-model-and-spend':'fixture',gitSourcePassed:label==='git-source',points:finalCap});
      activeAttempt=null;console.error('PASS '+label);
    }
  } else if((await op('friend','jobs.list',{circle})).length)throw Error('Preflight unexpectedly has jobs');
  summary.pass=true;
} catch(error) {
  summary.error=error.message;console.error(error.message);
} finally {
  clearInterval(timer);
  if(activeAttempt)await op('owner','lending.stop_job',{attemptId:activeAttempt},true).catch(()=>{summary.pass=false;});
  if(apps.owner?.token){await op('owner','lending.off').catch(()=>{});if(circle)await op('owner','hosting.stop',{},true).catch(()=>{summary.pass=false;});}
  for(const [role,a] of Object.entries(apps)) {
    const closed=await closeOwnedApp(a);
    summary.cleanup.push({role,...closed});
    if(!closed.stopped || closed.forcedTermination || closed.code!==0)summary.pass=false;
  }
  if(live&&beforePolicies)try {
    const after=listPolicies(),added=policyDiff(beforePolicies,after);
    summary.policyAdded=added.map(r=>r.id).sort();
    console.error('Policy diff added rule ids: '+JSON.stringify(summary.policyAdded));
    for(const rule of added) {
      // Only new network rules scoped to a sandbox created since the baseline.
      const sandbox=rule.scope?.slice('sandbox:'.length);
      if(!rule.scope?.startsWith('sandbox:')||rule.applies_to!==rule.scope||rule.resource_type!=='network'||beforeSandboxes.includes(sandbox)||!/^wf-[a-f0-9]{16}$/.test(sandbox)||!fs.existsSync(join(run,'owned-sandboxes',sandbox)))throw Error('New policy rule is not attributable to a disposable sandbox');
      sbxSync(join(sbxBinDir,'sbx'),['policy','rm','network','--sandbox',sandbox,'--id',rule.id,'--force'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
    }
    if(policyDiff(beforePolicies,listPolicies()).length)throw Error('Run-added policy rules remain');
    const afterSandboxes=JSON.parse(listSandboxes().stdout).map(r=>r.name).sort();
    summary.sandboxesAfter=afterSandboxes;
    console.error('sbx ls after: '+JSON.stringify(afterSandboxes));
    console.error('sbx policy ls after rule ids: '+JSON.stringify(listPolicies().map(r=>r.id).sort()));
    if(JSON.stringify(beforeSandboxes)!==JSON.stringify(afterSandboxes))throw Error('Sandbox set changed');
  }catch{summary.pass=false;summary.cleanupError='Sandbox or policy cleanup verification failed';}
  if(fs.existsSync(stopFile)){summary.pass=false;summary.safetyStop=fs.readFileSync(stopFile,'utf8');}
  const refusalLog=join(run,'refused-verbs.jsonl');
  if(fs.existsSync(refusalLog))summary.refusedVerbs=fs.readFileSync(refusalLog,'utf8').trim().split('\n').map(JSON.parse);
  // Retain only a nonsecret summary; credentials, app data, logs and scratch homes are disposable.
  if(summary.pass && summary.cleanup.every(c=>c.stopped)){fs.rmSync(run,{recursive:true,force:true});summary.cleaned=true;}else summary.retainedRun=run;
  console.log(JSON.stringify(summary));
  process.exitCode=summary.pass?0:1;
}
