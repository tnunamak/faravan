import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
const module=await import('../lib/sandbox-deadline-supervisor.mjs').catch(()=>({}));
const row={sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',binary:'/fake/sbx',deadline_at:60000,deadline_clock:{version:1,boot_id:'boot',boot_at:60000}};
// Legacy fixtures omit binding fields; supply an explicit trusted startup snapshot.
const supervise=(target,options)=>module.superviseSandboxDeadline(target,{
 ...options,originalRecord:{...target},
 readRecord:()=>({...target,...options.readRecord()}),
});
test('observed materialization and verified removal discharge an unfinished create',async()=>{
 let present=true,pauses=0;const states=[],commands=[];
 await supervise(row,{clock:()=>({wall:60000,boot_id:'boot',boot_ms:60000}),
  readRecord:()=>({create:'dispatched',create_settled:false}),publish:state=>states.push(state),
  pause:async()=>{assert.ok(++pauses<3,'an observed removal must finish without the dead app');},
  run:async args=>{commands.push(args[0]);if(args[0]==='rm'){assert.equal(states.at(-1).observed,true,'observation precedes removal');present=false;return {code:0};}return {code:0,stdout:JSON.stringify(present?[{name:row.sandbox_id}]:[])};}});
 assert.deepEqual(commands,['ls','rm','ls']);assert.equal(states.at(-1).state,'removed');assert.equal(states.at(-1).observed,true);
});
test('a never-seen target keeps the unfinished create watch',async()=>{
 let pauses=0;const states=[];const end=Error('bounded control complete');
 await assert.rejects(supervise(row,{clock:()=>({wall:60000,boot_id:'boot',boot_ms:60000}),
  readRecord:()=>({create:'dispatched',create_settled:false}),publish:state=>states.push(state),
  pause:async()=>{if(++pauses===3)throw end;},run:async()=>({code:0,stdout:'[]'})}),error=>error===end);
 assert.equal(states.some(state=>state.state==='removed'),false);assert.equal(states.some(state=>state.observed===true),false);
 assert.equal(states.at(-1).reason,'creation_pending');
});
for(const evidence of ['exact','initial-absence','different-create'])test('unreadable row requires its exact materialized proof: '+evidence,async()=>{
 const target={...row,sandbox_id:'wf-0123456789abcdef'};
 const original={...target,_cleanupId:'create-a',watch_generation:'generation-a',owner_scope:'owner-a'};
 const proof={name:target.sandbox_id,create_incarnation:evidence==='different-create'?'create-b':'create-a',
  watch_generation:'generation-a',state:evidence==='initial-absence'?'watching':'gone'};
 const states=[],end=Error('still supervising');let pauses=0;
 const proofStore=({home,owner})=>{
  assert.equal(home,target.sbx_home);assert.equal(owner,original.owner_scope);
  return {gone:binding=>proof.state==='gone'&&binding.sandbox_id===proof.name&&
   binding._cleanupId===proof.create_incarnation&&binding.watch_generation===proof.watch_generation?proof:null};
 };
 const control=module.superviseSandboxDeadline(target,{originalRecord:original,readRecord:()=>null,proofStore,
  publish:status=>states.push(status),
  pause:async()=>{pauses++;throw end;},
  run:async()=>assert.fail('an unreadable row must not issue any command')});
 if(evidence==='exact'){
  await control;
  assert.deepEqual(states,[{state:'removed'}]);assert.equal(pauses,0);
 }else{
  await assert.rejects(control,error=>error===end);
  assert.deepEqual(states,[{state:'failed',failures:1,reason:'record_unreadable'}]);assert.equal(pauses,1);
 }
});

for(const mode of ['failed-first-removal','hung-removal','success-still-present','late-create','suspend-and-rollback'])test('independent supervisor: '+mode,async()=>{
 assert.equal(typeof module.superviseSandboxDeadline,'function');
 let clock={wall:60000,boot_id:'boot',boot_ms:60000},present=mode!=='late-create',calls=[],sleeps=0,removed=0,settled=mode!=='late-create';const reports=[];
 if(mode==='suspend-and-rollback')clock={wall:-3600000,boot_id:'boot',boot_ms:120000};
 await supervise(row,{clock:()=>clock,readRecord:()=>({create:'dispatched',compute_created:settled,create_settled:settled}),publish:value=>reports.push(value),pause:async()=>{sleeps++;if(mode==='late-create'){present=true;settled=true;}assert.ok(sleeps<8);},run:async(args,options)=>{
   calls.push(args);assert.ok(options.timeout>0&&options.timeout<=15000);
   if(args[0]==='rm'){removed++;if(removed===1&&mode==='failed-first-removal')return {code:1};if(removed===1&&mode==='hung-removal')throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});if(!(removed===1&&mode==='success-still-present'))present=false;return {code:0};}
   return {code:0,stdout:JSON.stringify(present?[{name:row.sandbox_id}]:[])};
 }});
 assert.ok(removed>0);assert.equal(present,false);if(['failed-first-removal','hung-removal','success-still-present'].includes(mode))assert.ok(removed>=2);
 if(mode==='late-create')assert.ok(sleeps>=1,'absence before create resolves cannot discharge protection');
 assert.equal(reports.at(-1).state,'removed');
});
test('a failed status write cannot abandon removal supervision',async()=>{
 let present=true,removals=0;
 await supervise(row,{clock:()=>({wall:60000,boot_id:'boot',boot_ms:60000}),readRecord:()=>({create_settled:true}),pause:async()=>{},publish:state=>{if(state.state==='failed')throw Error('disk full');},run:async args=>{if(args[0]==='rm'){if(++removals===2)present=false;return {code:1};}return {code:0,stdout:JSON.stringify(present?[{name:row.sandbox_id}]:[])};}});
 assert.equal(present,false);assert.equal(removals,2);
});
test('crossing the boot deadline cannot be undone by a later wall rollback',async()=>{
 let wall=60000,present=true,removals=0,pauses=0;
 await supervise(row,{clock:()=>({wall,boot_id:'boot',boot_ms:60000}),readRecord:()=>({create_settled:true}),publish:()=>{},pause:async()=>{assert.equal(++pauses,1,'an expired deadline must not return to waiting');wall=0;},run:async args=>{if(args[0]==='rm'){if(++removals===2)present=false;return {code:1};}return {code:0,stdout:JSON.stringify(present?[{name:row.sandbox_id}]:[])};}});
 assert.equal(removals,2);
});
test('an unavailable clock expires conservatively instead of abandoning cleanup',async()=>{
 let removed=false;
 await supervise(row,{clock:()=>{throw Error('clock unavailable');},readRecord:()=>({create_settled:true}),publish:()=>{},run:async args=>{if(args[0]==='rm')removed=true;return {code:0,stdout:'[]'};}});assert.equal(removed,true);
});

test('a create dispatched during removal cannot discharge a reserved snapshot',async()=>{
 let record={create:'reserved'},moves=0,checks=0;const states=[];
 await supervise(row,{clock:()=>({wall:60000,boot_id:'boot',boot_ms:60000}),readRecord:()=>({...record}),publish:s=>states.push(s),pause:async()=>{record={create:'dispatched',create_settled:true};},run:async args=>{
  if(args[0]==='rm'){moves++;record={create:'dispatched'};if(moves>1)record.create_settled=true;}else checks++;
  return {code:0,stdout:'[]'};
 }});
 assert.equal(moves,2);assert.ok(checks>=2*moves,'each removal has a before and after inventory');assert.equal(states[0].reason,'creation_pending');assert.equal(states.at(-1).state,'removed');
});

test('an unresolved reservation retains protection until journal completion',async()=>{
 let complete=false,removals=0;
 await supervise(row,{clock:()=>({wall:60000,boot_id:'boot',boot_ms:60000}),readRecord:()=>complete?{create_settled:true}:{create:'reserved'},publish:()=>{},pause:async()=>{assert.equal(removals,0,'never-seen creation keeps the watch');complete=true;},run:async args=>{if(args[0]==='rm')removals++;return {code:0,stdout:'[]'};}});
 assert.equal(removals,1);
});

// At its deadline the guard may remove the name bound to its own row even when the listing failed and it never saw the name:
// every create gets its own random name, and removal can be repeated. It removes no other name, and it never reports the
// record removed without a receipt (the name was seen, or the create settled).
test('at the deadline a failed listing still removes the row\'s own name, never another, and never reports removal without a receipt',async()=>{
 let pauses=0;const states=[],removed=[],end=Error('bounded control complete');
 await assert.rejects(supervise(row,{clock:()=>({wall:60000,boot_id:'boot',boot_ms:60000}),
  readRecord:()=>({create:'dispatched',create_settled:false}),publish:state=>states.push(state),
  pause:async()=>{if(++pauses===2)throw end;},
  run:async args=>{if(args[0]==='rm'){removed.push(args.slice(1));return {code:0};}return {code:1,stdout:'',stderr:'daemon unavailable'};}}),error=>error===end);
 assert.ok(removed.length>=1,'compute is stopped at the deadline even though listing is down');
 assert.ok(removed.every(args=>args.length===2&&args[0]==='--force'&&args[1]===row.sandbox_id),'only the row\'s own name is removed');
 assert.equal(states.some(state=>state.state==='removed'),false,'no removal is reported without a receipt');
 assert.equal(states.at(-1).state,'failed');
});

const watchRow={...row,sandbox_id:'wf-0123456789abcdef'};
const original={...watchRow,_cleanupId:'11111111-1111-1111-1111-111111111111',owner_scope:'owner',watch_generation:'g1',create_settled:true};
const replacement={...original,_cleanupId:'22222222-2222-2222-2222-222222222222'};
for(const mode of ['replacement-before-reads','replacement-under-fence','missing','corrupt','later-original','same-create','handoff','timeout-absence'])test('immutable deadline binding: '+mode,async()=>{
 const states=[],commands=[],end=Error('bounded fixture complete');
 let current={...original},held=false,pauses=0,present=true,rm=0,inconclusive=false;
 if(mode==='replacement-before-reads')current={...replacement};
 if(mode==='missing')current=null;
 if(mode==='corrupt'||mode==='later-original')current='corrupt';
 const invoke=()=>module.superviseSandboxDeadline(watchRow,{
  originalRecord:original,clock:()=>({wall:60000,boot_id:'boot',boot_ms:60000}),
  readRecord:()=>{if(current===null)throw Object.assign(Error('missing'),{code:'ENOENT'});if(current==='corrupt')throw Error('corrupt');return {...current};},
  publish:s=>states.push(s),
  beforeRemove:async()=>{if(mode==='handoff')current={...original,watch_generation:'g2'};},
  fence:record=>{assert.equal(held,false);held=true;if(mode==='replacement-under-fence')current={...replacement};return {
   assertCurrent:()=>{assert.equal(held,true);assert.equal(record.watch_generation,current.watch_generation);},
   release:()=>{held=false;},
  };},
  pause:async()=>{assert.equal(held,false);pauses++;if(pauses>3)throw end;if(mode==='later-original'){current={...original};return;}
   if(mode==='timeout-absence'){inconclusive=false;return;}if(pauses===2)throw end;},
  run:async(args,options)=>{commands.push(args[0]);assert.equal(options.timeout,module.DEADLINE_COMMAND_MS);
   if(args[0]==='rm'){assert.equal(held,true);assert.equal(current._cleanupId,original._cleanupId);rm++;
    if(mode==='timeout-absence'&&rm===1){present=false;inconclusive=true;return {code:1};}present=false;return {code:0};}
   return inconclusive?{code:1,stdout:''}:{code:0,stdout:JSON.stringify(present?[{name:watchRow.sandbox_id}]:[])};
  },
 });
 const refuses=['replacement-before-reads','replacement-under-fence','missing','corrupt'].includes(mode);
 if(refuses){await assert.rejects(invoke(),e=>e===end);assert.equal(rm,0);assert.equal(states.some(s=>s.state==='removed'),false);}
 else {await invoke();assert.equal(states.at(-1).state,'removed');assert.ok(rm>=1);if(mode==='timeout-absence')assert.ok(pauses>=1);}
 assert.equal(held,false);
});
test('supervisor refuses absent startup authority rather than adopting a later record',async()=>{
 let reads=0,commands=0;
 await assert.rejects(module.superviseSandboxDeadline(watchRow,{
  readRecord:()=>{reads++;return original;},run:async()=>{commands++;return {code:0,stdout:'[]'};},
 }),/startup binding/);
 assert.equal(reads,0);assert.equal(commands,0);
});

test('startup corruption refuses readiness before creating supervisor state',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-startup-'));
 const recordPath=path.join(directory,'record.json'),payload={...row,recordPath,statusPath:recordPath+'.deadline'};
 try{
  for(const bytes of ['{','null','[]','{}']){
   fs.writeFileSync(recordPath,bytes);
   await assert.rejects(module.startDeadlineSupervisor(payload));
   assert.equal(fs.existsSync(payload.statusPath),false);
  }
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});


// Real CLI boundary: capture before standby wait, then validate the same create after acquisition.
for(const change of ['replacement','missing','unchanged','restored'])test('actual standby startup preserves original binding: '+change,{timeout:30000},async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {spawn}=await import('node:child_process'),{fileURLToPath,pathToFileURL}=await import('node:url');
 const {acquireProcessLock}=await import('../lib/v1/lock.mjs');
 const {sandboxDeadlineClock,deadlineBinding,deadlineSuccessorPath,deadlineProcessStart}=await import('../lib/sandbox-deadline.mjs');
 const clock=sandboxDeadlineClock();
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-standby-binding-'));
 const recordPath=path.join(directory,'11111111-1111-1111-1111-111111111111.json');
 const heldRecord=recordPath+'.held';
 const binary=path.join(directory,'fake-sbx'),log=path.join(directory,'commands.jsonl'),present=path.join(directory,'present');
 const name='wf-0123456789abcdef';
 const payload={sandbox_id:name,sbx_home:directory,binary,recordPath,statusPath:recordPath+'.deadline',
  deadline_at:clock.wall,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms}};
 const initial={...payload,_cleanupId:'11111111-1111-1111-1111-111111111111',
  owner_scope:'a'.repeat(64),watch_generation:'original-generation',create:'dispatched',create_settled:true,compute_created:true};
 const readJSON=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const commands=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const publicationLog=path.join(directory,'publications.jsonl'),preload=path.join(directory,'observe-publications.mjs');
 const failureReason=change==='missing'||change==='restored'?'record_unreadable':'record_changed';
 const failuresBeforeCheck=change==='restored'?[1]:[1,2,3,4];
 let child,release,watchdog,exit,spawnError,stderr='',ready=false,stopping=false,work,identity;
 const publications=()=>fs.readFileSync(publicationLog,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 const assertPublications=()=>{
  const entries=publications();
  assert.ok(entries.length>0,'successful status publications were captured');
  for(const status of entries){
   assert.equal(status.pid,child.pid);assert.equal(status.binding,deadlineBinding(payload));
   assert.equal(status.start,identity.start,'every publication has the original child identity');
  }
  if(change==='unchanged'){
   assert.equal(entries[0].state,'armed');assert.equal(entries.at(-1).state,'removed');
   assert.ok(entries.findIndex(s=>s.state==='removed')>entries.findIndex(s=>s.state==='armed'));
  }else{
   const armed=entries.findIndex(status=>status.state==='armed');
   if(change==='restored'&&armed>=0)assert.deepEqual(entries.slice(armed).map(status=>status.state),['armed','removed']);
   const failedEntries=change==='restored'&&armed>=0?entries.slice(0,armed):entries;
   for(const status of failedEntries){
    assert.equal(status.state,'failed','the original duty stays failed through the joined publication log');
    assert.equal(status.reason,failureReason,'each original-duty publication gives the same reason');
   }
   assert.deepEqual(failedEntries.filter(status=>Number.isInteger(status.failures)).slice(0,failuresBeforeCheck.length).map(status=>status.failures),
    failuresBeforeCheck,'numbered failed attempts were published');
  }
 };
 const waitFor=async(check,label,{allowExit=false,timeoutMs=8000}={})=>{
  const deadline=Date.now()+timeoutMs;
  for(;;){
   if(stopping)throw Error('Fixture observation cancelled');
   if(spawnError)throw spawnError;
   const result=check();if(result)return result;
   assert.ok(allowExit||!exit,'supervisor exited before '+label+': '+JSON.stringify(exit)+' '+stderr);
   assert.ok(Date.now()<deadline,'Timed out: '+label+' '+stderr);
   await new Promise(resolve=>setTimeout(resolve,10));
  }
 };
 let closed;
 try{
  fs.writeFileSync(recordPath,JSON.stringify(initial));
  fs.writeFileSync(present,'owned synthetic sandbox');
  // Absolute owned executable; it only changes this fixture's marker, never invokes sbx.
  fs.writeFileSync(binary,'#!'+process.execPath+'\n'+
   'const fs=require("node:fs");const args=process.argv.slice(2);'+
   'const log='+JSON.stringify(log)+',marker='+JSON.stringify(present)+',status='+JSON.stringify(payload.statusPath)+';'+
   'fs.appendFileSync(log,JSON.stringify({args,status:JSON.parse(fs.readFileSync(status,"utf8"))})+"\\n");'+
   'if(args[0]==="ls")process.stdout.write(JSON.stringify(fs.existsSync(marker)?[{name:'+JSON.stringify(name)+'}]:[]));'+
   'else if(args[0]==="rm"&&args[1]==="--force"&&args[2]==='+JSON.stringify(name)+')fs.rmSync(marker,{force:true});'+
   'else process.exitCode=2;\n',{mode:0o700});
  fs.writeFileSync(publicationLog,'',{flag:'wx',mode:0o600});
  // Child-only observation, after the real rename and before the next publication.
  // Unrelated renames and every production durability barrier remain unchanged.
  fs.writeFileSync(preload,
   'import fs from "node:fs";\n'+
   'const statusPath='+JSON.stringify(payload.statusPath)+',log='+JSON.stringify(publicationLog)+';\n'+
   'if(JSON.parse(process.argv[2]).statusPath!==statusPath)throw Error("Observer target mismatch");\n'+
   'const rename=fs.renameSync;fs.renameSync=function(from,to){\n'+
   ' const result=rename.apply(this,arguments);if(to!==statusPath)return result;\n'+
   ' try{const status=JSON.parse(fs.readFileSync(statusPath,"utf8"));'+
   'fs.appendFileSync(log,JSON.stringify(status)+"\\n");}catch(error){'+
   'try{fs.writeSync(2,"Publication observer failed: "+String(error)+"\\n");}finally{process.exit(86);}}\n'+
   ' return result;};\n',{flag:'wx',mode:0o600});
  release=await acquireProcessLock(payload.statusPath+'.lock',{timeoutMs:250});
  child=spawn(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url)),JSON.stringify(payload),'--standby'],
   {env:{HOME:directory,PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
  child.on('message',message=>{if(message?.ready===true&&message.waiting===true)ready=true;});
  child.on('error',error=>{spawnError=error;});
  closed=new Promise(resolve=>child.once('close',(code,signal)=>{exit={code,signal};resolve(exit);}));
  const watchdogFailure=new Promise((_,reject)=>{watchdog=setTimeout(()=>{
   if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   reject(Error('External standby fixture watchdog expired'));
  },20000);});
  work=(async()=>{
   const waiting=await waitFor(()=>ready&&readJSON(deadlineSuccessorPath(payload)),'actual waiting readiness');
   identity=waiting;
   assert.equal(waiting.state,'waiting');assert.equal(waiting.pid,child.pid);
   assert.equal(waiting.binding,deadlineBinding(payload));
   assert.equal(waiting.start,await deadlineProcessStart(child.pid),'real process/boot identity');
   assert.equal(fs.existsSync(payload.statusPath),false,'predecessor lock prevents status ownership');
   assert.deepEqual(commands(),[]);
   if(change==='replacement')fs.writeFileSync(recordPath,JSON.stringify({...initial,
    _cleanupId:'22222222-2222-2222-2222-222222222222',watch_generation:'replacement-generation'}));
   if(change==='missing')fs.unlinkSync(recordPath);
   if(change==='restored')fs.renameSync(recordPath,heldRecord);
   release();release=null;
   if(change!=='unchanged'){
    const requiredFailures=failuresBeforeCheck.at(-1);
    const failed=await waitFor(()=>{
     const status=readJSON(payload.statusPath);
     return status?.state==='failed'&&status.failures>=requiredFailures&&publications().some(row=>row.failures>=requiredFailures)&&status;
    },'repeated unresolved original duty',{timeoutMs:14000});
    assert.equal(failed.reason,failureReason);
    assert.equal(failed.binding,deadlineBinding(payload));
    assert.equal(failed.pid,child.pid);
    assert.equal(failed.start,waiting.start);
    assert.equal(await deadlineProcessStart(child.pid),waiting.start);
    assert.equal(exit,undefined,'missing/replaced metadata never implies cessation');
    assertPublications();
    assert.deepEqual(commands(),[],'no inventory or destructive command for replacement/missing record');
    assert.equal(fs.readFileSync(present,'utf8'),'owned synthetic sandbox','owned marker bytes remain unchanged');
    if(change!=='restored')return;
    assert.equal(fs.readFileSync(heldRecord,'utf8'),JSON.stringify(initial));
    fs.renameSync(heldRecord,recordPath);
   }
   const final=await waitFor(()=>{const s=readJSON(payload.statusPath);return s?.state==='removed'&&s;},'original record settled',{allowExit:true});
   await waitFor(()=>exit,'successful supervisor exit',{allowExit:true});
   assert.deepEqual(exit,{code:0,signal:null});
   assert.equal(final.binding,deadlineBinding(payload));assert.equal(final.pid,child.pid);
   assert.equal(final.observed,true);assert.equal(fs.existsSync(present),false);
   const calls=commands();
   assert.deepEqual(calls.map(c=>c.args[0]),['ls','rm','ls']);
   if(change==='unchanged')assert.equal(calls[0].status.state,'armed','actual acquisition arms before first command');
   else assert.equal(calls[0].status.state,'failed','initial inventory must verify the restored record');
   assert.deepEqual(calls[1].args,['rm','--force',name]);
   assert.equal(calls[1].status.state,'armed','owned removal follows a published observation');
   assertPublications();
  })();
  await Promise.race([work,watchdogFailure]);
 }finally{
  stopping=true;clearTimeout(watchdog);
  try{
   if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
   if(closed){
    let killTimer;
    try{await Promise.race([closed,new Promise((_,reject)=>{killTimer=setTimeout(()=>{
     if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
     reject(Error('Owned supervisor did not stop during cleanup'));
    },3000);})]);}
    finally{clearTimeout(killTimer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
   }
  }finally{
   await work?.catch(()=>{});
   try{
    if(identity){
     assert.deepEqual(exit,{code:0,signal:null},'observer errors cannot be swallowed by production: '+stderr);
     assertPublications(); // Final joined log, including publications during shutdown.
     if(change==='missing'||change==='replacement'){
      assert.deepEqual(commands(),[]);
      assert.equal(fs.readFileSync(present,'utf8'),'owned synthetic sandbox');
     }
    }
   }finally{release?.();fs.rmSync(directory,{recursive:true,force:true});}
  }
 }
});
