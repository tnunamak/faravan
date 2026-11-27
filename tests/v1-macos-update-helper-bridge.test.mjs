import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareMacUpdateHelper} from '../lib/v1/macos-update-helper-bridge.mjs';

const fixtureCode = `
import {readFileSync} from 'node:fs';
let nonce,controlPath;
process.on('message', message => {
  if (message.type === 'prepare') {
    nonce = message.nonce;
    controlPath = message.controlPath;
    if (message.spec.expectedHome && (process.env.HOME !== message.spec.expectedHome || process.env.FARAVAN_HOME !== message.spec.expectedProfile)) return process.exit(7);
    process.send({type:'fixture-prepared',nonce});
    if (message.spec.mode === 'exit') return process.exit(0);
    if (message.spec.mode === 'silent') return;
    process.send({protocol:message.protocol,type:'ready',nonce:message.spec.mode === 'wrong' ? 'wrong' : nonce});
  }
  if (message.type === 'cancel' && message.nonce === nonce) {
    const control=JSON.parse(readFileSync(controlPath,'utf8'));
    if(control.nonce!==nonce || control.state!=='cancelled')return process.exit(11);
    process.send({protocol:message.protocol,type:'cancelled',nonce}, () => process.exit(0));
  }
});
process.on('disconnect', () => process.exit(0));
`;
async function fixture(t, mode='ready') {
  const root=await mkdtemp(join(tmpdir(),'mac-bridge-')); const sourceRoot=join(root,'Faravan.app'), capsuleRoot=join(root,'capsules');
  await mkdir(sourceRoot); await mkdir(capsuleRoot,{mode:0o700});
  await writeFile(join(sourceRoot,'runtime'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, {mode:0o700});
  await writeFile(join(sourceRoot,'helper.mjs'),fixtureCode);
  await mkdir(join(sourceRoot,'lib')); await writeFile(join(sourceRoot,'lib','dependency.mjs'),'export const value=1;');
  let released=0, spawned=0, child, preparedResolve;
  const prepared = new Promise(resolve => { preparedResolve = resolve; });
  const options={appPath:sourceRoot,sourceRoot,capsuleRoot,runtime:'runtime',entrypoint:'helper.mjs',
    files:[{source:'runtime',destination:'runtime'},{source:'helper.mjs',destination:'helper.mjs'},
      {source:'lib/dependency.mjs',destination:'lib/dependency.mjs'}],spec:{mode},
    exclusive:async()=>async()=>{released++;},spawnProcess:(...args)=>{spawned++;child=spawn(...args);child.on('message',m=>{if(m?.type==='fixture-prepared')preparedResolve(m);});return child;}};
  t.after(async()=>{if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));} await rm(root,{recursive:true,force:true});});
  return {root,sourceRoot,capsuleRoot,options,prepared,counts:()=>({released,spawned}),child:()=>child};
}

test('real child ready, explicit copied inventory, source rename, and cancellation',async t=>{
  const f=await fixture(t); const ticket=await prepareMacUpdateHelper(f.options);
  assert.equal(ticket.ready,true); assert.deepEqual(f.counts(),{released:0,spawned:1});
  const [dir]=await readdir(f.capsuleRoot); const capsule=join(f.capsuleRoot,dir);
  assert.equal((await stat(capsule)).mode & 0o777,0o700);
  assert.deepEqual((await readdir(capsule)).sort(),['.handoff-control.json','helper.mjs','lib','runtime']);
  assert.deepEqual(await readdir(join(capsule,'lib')),['dependency.mjs']);
  await rename(f.sourceRoot,f.sourceRoot+'.old');
  await ticket.cancel(); await ticket.cancel();
  assert.deepEqual(await readdir(f.capsuleRoot),[]); assert.deepEqual(f.counts(),{released:1,spawned:1});
});

test('wrong nonce and early exit never yield a ticket',async t=>{
  for(const mode of ['wrong','exit']) {
    const f=await fixture(t,mode);
    await assert.rejects(prepareMacUpdateHelper(f.options), error => mode==='wrong' ? error.code==='helper_timeout' : ['helper_exited','helper_disconnected'].includes(error.code));
    assert.deepEqual(await readdir(f.capsuleRoot),[]); assert.equal(f.counts().released,1);
  }
});

test('silent helper times out and cancellation reaps it',async t=>{
  const f=await fixture(t,'silent');
  await assert.rejects(prepareMacUpdateHelper(f.options),{code:'helper_timeout'});
  assert.deepEqual(await readdir(f.capsuleRoot),[]); assert.equal(f.counts().released,1);
});

function controlledHelperTimers() {
  const records = [];
  return {
    records,
    setTimeout(fn, ms) { const timer = {fn, ms, cleared:false}; records.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  };
}

test('abort before and after ready cancels only the owned child',{timeout:10000},async t=>{
  const f=await fixture(t,'silent'), controller=new AbortController(), beforeTimers=controlledHelperTimers();
  const pending=prepareMacUpdateHelper({...f.options,timeoutMs:250,cancelTimeoutMs:500,signal:controller.signal,timers:beforeTimers});
  const rejected=assert.rejects(pending,{code:'aborted'});
  await f.prepared; // Actual prepare receipt, while this fixture deliberately withholds ready.
  controller.abort();
  await rejected; assert.equal(f.counts().released,1);
  assert.deepEqual(await readdir(f.capsuleRoot),[]);
  assert.deepEqual(beforeTimers.records.map(({ms,cleared})=>({ms,cleared})),[
    {ms:250,cleared:true},{ms:500,cleared:true},
  ]);
  const g=await fixture(t), second=new AbortController(), afterTimers=controlledHelperTimers();
  const ticket=await prepareMacUpdateHelper({...g.options,timeoutMs:250,cancelTimeoutMs:500,signal:second.signal,timers:afterTimers});
  second.abort(); await ticket.cancel();
  assert.deepEqual(await readdir(g.capsuleRoot),[]); assert.equal(g.counts().released,1);
  assert.deepEqual(afterTimers.records.map(({ms,cleared})=>({ms,cleared})),[
    {ms:250,cleared:true},{ms:500,cleared:true},
  ]);
  assert.equal(f.counts().spawned,1); assert.equal(g.counts().spawned,1);
});

test('abort cancellation waits for gated owned-child exit, not its acknowledgement',{timeout:10000},async t=>{
  const f=await fixture(t), controller=new AbortController(), timers=controlledHelperTimers();
  await writeFile(join(f.sourceRoot,'helper.mjs'),fixtureCode.replace(
    "process.send({protocol:message.protocol,type:'cancelled',nonce}, () => process.exit(0));",
    "process.send({protocol:message.protocol,type:'cancelled',nonce});"
  ) + "\nprocess.on('message', m => { if(m.type==='fixture-exit-after-cancel' && m.nonce===nonce) process.exit(0); });\n");
  const ticket=await prepareMacUpdateHelper({...f.options,timeoutMs:250,cancelTimeoutMs:500,signal:controller.signal,timers});
  assert.deepEqual(timers.records.map(({ms,cleared})=>({ms,cleared})),[{ms:250,cleared:true}]);
  let acknowledge;
  const acknowledged=new Promise(resolve=>{acknowledge=resolve;});
  f.child().on('message',m=>{if(m?.type==='cancelled')acknowledge(m);});
  let settled=false;
  controller.abort();
  const cancelling=ticket.cancel().then(()=>{settled=true;});
  const message=await acknowledged;
  assert.equal(settled,false,'acknowledgement is not proof of exit');
  assert.equal(f.counts().released,0,'admission remains excluded while the owned child runs');
  assert.equal((await readdir(f.capsuleRoot)).length,1,'capsule remains owned until exit');
  assert.deepEqual(timers.records.map(({ms,cleared})=>({ms,cleared})),[
    {ms:250,cleared:true},{ms:500,cleared:false},
  ]);
  f.child().send({type:'fixture-exit-after-cancel',nonce:message.nonce});
  await cancelling;
  assert.equal(f.child().exitCode,0);
  assert.deepEqual(await readdir(f.capsuleRoot),[]);
  assert.equal(f.counts().released,1);
  assert.equal(timers.records[1].cleared,true);
});

test('busy exclusion starts no child',async t=>{
  const f=await fixture(t); await assert.rejects(prepareMacUpdateHelper({...f.options,exclusive:async()=>null}),{code:'busy'});
  assert.equal(f.counts().spawned,0); assert.deepEqual(await readdir(f.capsuleRoot),[]);
});

test('symlink, untrusted destination and duplicate files are refused',async t=>{
  const f=await fixture(t); await symlink(join(f.sourceRoot,'helper.mjs'),join(f.sourceRoot,'link'));
  await assert.rejects(prepareMacUpdateHelper({...f.options,files:[...f.options.files,{source:'link',destination:'link'}]}),{code:'invalid_path'});
  await assert.rejects(prepareMacUpdateHelper({...f.options,files:[...f.options.files,{source:'runtime',destination:'runtime'}]}),{code:'invalid_manifest'});
  await assert.rejects(prepareMacUpdateHelper({...f.options,files:[...f.options.files,{source:'runtime',destination:'../escape'}]}),{code:'invalid_manifest'});
  await assert.rejects(prepareMacUpdateHelper({...f.options,capsuleRoot:f.sourceRoot}),{code:'invalid_path'});
  assert.equal(f.counts().spawned,0);
});

test('unknown cessation retains capsule and reports ownership_unknown',async t=>{
  const f=await fixture(t); await writeFile(join(f.sourceRoot,'helper.mjs'),fixtureCode.replace("process.send({protocol:message.protocol,type:'cancelled',nonce}, () => process.exit(0));", "return;"));
  const ticket=await prepareMacUpdateHelper({...f.options,cancelTimeoutMs:80});
  await assert.rejects(ticket.cancel(),{code:'ownership_unknown'});
  const [dir]=await readdir(f.capsuleRoot);assert.ok(dir);assert.equal(f.counts().released,1);
  const control=JSON.parse(await readFile(join(f.capsuleRoot,dir,'.handoff-control.json'),'utf8'));
  assert.equal(control.state,'cancelled','a later parent disconnect cannot revive the cancelled update');
  assert.match(control.nonce,/^[a-f0-9]{64}$/);
});

test('parent exit disconnects the child without cancelling or deleting its capsule',async t=>{
  const f=await fixture(t), marker=join(f.root,'disconnected'), driver=join(f.root,'driver.mjs');
  await writeFile(join(f.sourceRoot,'helper.mjs'), `
    import {writeFileSync} from 'node:fs';
    let spec;
    process.on('message', m => { if(m.type==='prepare'){spec=m.spec;process.send({protocol:m.protocol,type:'ready',nonce:m.nonce});} if(m.type==='cancel')process.exit(4); });
    process.on('disconnect',()=>{writeFileSync(spec.marker,String(process.pid));process.exit(0);});
  `);
  const options={...f.options,spec:{marker}}; delete options.exclusive; delete options.spawnProcess;
  const bridgeUrl=new URL('../lib/v1/macos-update-helper-bridge.mjs',import.meta.url).href;
  await writeFile(driver, `import {prepareMacUpdateHelper} from ${JSON.stringify(bridgeUrl)};\nconst ticket=await prepareMacUpdateHelper({...${JSON.stringify(options)},exclusive:async()=>()=>{}});\nif(!ticket.ready)process.exit(2);\nprocess.exit(0);\n`);
  const child=spawn(process.execPath,[driver],{stdio:'ignore'});
  const result=await new Promise(resolve=>child.once('exit',code=>resolve(code)));
  assert.equal(result,0);
  let value;
  for(let i=0;i<100;i++) {try {value=await stat(marker);break;} catch {await new Promise(r=>setTimeout(r,20));}}
  assert.ok(value); assert.equal((await readdir(f.capsuleRoot)).length,1);
  const pid=Number(await readFile(marker,'utf8')); let gone=false;
  for(let i=0;i<100;i++) {try {process.kill(pid,0);} catch(e) {if(e.code==='ESRCH'){gone=true;break;} throw e;} await new Promise(r=>setTimeout(r,20));}
  assert.equal(gone,true,'owned helper must exit before fixture cleanup');
});


test('the child inherits the genuine HOME and explicit profile selectors without argv secrets',async t=>{
  const f=await fixture(t); let invocation;
  const env={...process.env,HOME:'/real-home',FARAVAN_HOME:'/real-profile'};
  const ticket=await prepareMacUpdateHelper({...f.options,env,spec:{mode:'ready',expectedHome:env.HOME,expectedProfile:env.FARAVAN_HOME},
    spawnProcess:(command,args,options)=>{invocation={command,args}; return f.options.spawnProcess(command,args,options);}});
  assert.equal(ticket.ready,true); assert.equal(invocation.args.length,1);
  assert.ok(invocation.command.startsWith(f.capsuleRoot+'/')); assert.ok(invocation.args[0].startsWith(f.capsuleRoot+'/'));
  assert.ok(!JSON.stringify(invocation).includes('/real-profile'));
  await ticket.cancel();
});

test('explicitly marked native helper remains executable inside capsule',async t=>{
  const f=await fixture(t);await writeFile(join(f.sourceRoot,'native'), '#!/bin/sh\nexit 0\n',{mode:0o700});
  const ticket=await prepareMacUpdateHelper({...f.options,files:[...f.options.files,{source:'native',destination:'native',executable:true}]});
  const [dir]=await readdir(f.capsuleRoot),file=join(f.capsuleRoot,dir,'native');
  assert.equal((await stat(file)).mode&0o777,0o700);
  const child=spawn(file,[],{stdio:'ignore'});assert.equal((await new Promise(r=>child.once('exit',r))),0);await ticket.cancel();
  await assert.rejects(prepareMacUpdateHelper({...f.options,files:[...f.options.files,{source:'native',destination:'native',executable:'yes'}]}),{code:'invalid_manifest'});
});
