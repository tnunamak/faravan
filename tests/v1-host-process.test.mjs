import './helpers/no-browser.mjs';
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {acquireCoordinatorProcessLock} from '../lib/v1/lock.mjs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {assertOwnedCoordinatorProcess,hostProcessExists, stopOwnedCoordinatorProcess} from '../lib/v1/host.mjs';

const executable=fileURLToPath(new URL('../bin/faravan-coordinator',import.meta.url));
const config='/disposable/host.json';
const stat=start=>'123 (node) '+['S',...Array(18).fill('0'),start].join(' ');
function fixture({args=['node',executable,'--host-config',config],starts=['42','42']}={}){
  let reads=0;const signals=[];
  return {platform:'linux',signals,readlink:path=>path.endsWith('/exe')?process.execPath:'pid:[test]',readFile:path=>path.endsWith('/cmdline')?args.join('\0')+'\0':path.endsWith('/boot_id')?'test-boot':stat(starts[reads++]??'42'),signal:(...args)=>signals.push(args)};
}

// Another install's entry is a real file under a path with spaces, so it resolves and is provably a different program.
// The missing path cannot be resolved, which is unverified and never a different install.
const olderRoot=mkdtempSync(path.join(tmpdir(),'older faravan-'));
const olderCopy=path.join(olderRoot,'rollback 1','bin','faravan-coordinator');
mkdirSync(path.dirname(olderCopy),{recursive:true});writeFileSync(olderCopy,'');
after(()=>rmSync(olderRoot,{recursive:true,force:true}));
const missingCopy='/old/faravan.rollback-1/bin/faravan-coordinator';
const otherInstall=error=>error.code==='previous_coordinator_other_install';
const copyNamed=error=>otherInstall(error)&&/^The recorded hosting process appears to use a different program path\./.test(error.message);
const generic=error=>error.code===undefined&&/cannot verify the previous coordinator process/.test(error.message);

test('automatic restart signals only the coordinator bound to this exact config',()=>{
  const f=fixture();stopOwnedCoordinatorProcess(123,config,f);assert.deepEqual(f.signals,[[123,'SIGTERM']]);
});
test('a stale status PID reused by another program or host cannot be signalled',()=>{
  for(const args of [['node','/unrelated/server.mjs'],['node',executable,'--host-config','/other/host.json']]){
    const f=fixture({args});assert.throws(()=>stopOwnedCoordinatorProcess(123,config,f),/cannot verify/);assert.deepEqual(f.signals,[]);
  }
});
test('a process incarnation change or unreadable identity refuses automatic restart',()=>{
  for(const f of [fixture({starts:['42','43']}),{platform:'linux',signals:[],readFile(){throw Error('unavailable');},signal(){assert.fail('must not signal');}}]){
    assert.throws(()=>stopOwnedCoordinatorProcess(123,config,f),/cannot verify/);assert.deepEqual(f.signals,[]);
  }
});
test('a relative config argument cannot establish ownership across process working directories',()=>{
  const f=fixture({args:['node',executable,'--host-config','host.json']});
  assert.throws(()=>stopOwnedCoordinatorProcess(123,'host.json',f),/cannot verify/);
  assert.deepEqual(f.signals,[]);
});

test('the liveness probe sends only signal 0 and treats only ESRCH as proof that a process is absent',()=>{
  const io=fixture(),owner=assertOwnedCoordinatorProcess(123,config,io);
  const status={protocol_version:1,pid:123,status:'listening',owner};
  const probes=[];
  const probe=code=>(pid,signal)=>{probes.push([pid,signal]);if(code)throw Object.assign(new Error(),{code});};
  assert.equal(hostProcessExists(status,{...io,configPath:config,processKill:probe('ESRCH')}),false);
  assert.equal(hostProcessExists(status,{...io,configPath:config,processKill:probe(undefined)}),true);
  for(const code of ['EPERM','EIO']){
    assert.throws(()=>hostProcessExists(status,{...io,configPath:config,processKill:probe(code)}),
      /cannot verify the previous coordinator process/);
  }
  assert.ok(probes.length>=4&&probes.every(([pid,signal])=>pid===123&&signal===0),'every liveness probe is signal 0 for the recorded pid');
  assert.deepEqual(io.signals,[],'no liveness check sends a signal');
});
test('macOS verifies the exact command, config and stable process start time',()=>{
  const command=`${process.execPath} ${executable} --host-config ${config}`;
  for(const [commands,starts,allowed] of [
    [[command,command],['Tue Oct 20 10:00:00 2026','Tue Oct 20 10:00:00 2026'],true],
    [['node /unrelated/server.mjs'],['Tue Oct 20 10:00:00 2026'],false],
    [[command,command],['Tue Oct 20 10:00:00 2026','Tue Oct 20 10:01:00 2026'],false],
  ]){
    let index=0;const signals=[];
    const options={platform:'darwin',execFile:file=>file.endsWith('faravan-process-identity')?
      JSON.stringify({boot:'darwin:test',start:String(Date.parse(starts[index]+' GMT')*1000),state:'live'}):`${commands[index++]}\n`,signal:(...args)=>signals.push(args)};
    if(allowed){stopOwnedCoordinatorProcess(123,config,options);assert.deepEqual(signals,[[123,'SIGTERM']]);}
    else {assert.throws(()=>stopOwnedCoordinatorProcess(123,config,options),/cannot verify/);assert.deepEqual(signals,[]);}
  }
});

test('Windows stops only a coordinator with a matching command and stable creation time',()=>{
  const configWithSpacesAndQuote=path.resolve('/disposable/My "Hosts"/host.json');
  const quote=value=>/\s|"/.test(value)?`"${value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`:value;
  const commandLine=[process.execPath,executable,'--host-config',configWithSpacesAndQuote]
    .map(quote).join(' ');
  const creationDate='638972640000000001';
  const record=(overrides={})=>JSON.stringify({ExecutablePath:process.execPath,CommandLine:commandLine,CreationDate:creationDate,Boot:'638970000000000000',...overrides});
  const run=outputs=>{
    let index=0;const signals=[];const calls=[];
    const options={platform:'win32',signals,signal:(...args)=>signals.push(args),execFile:(...args)=>{calls.push(args);const output=outputs[index++];if(output instanceof Error)throw output;return output;}};
    return {options,signals,calls};
  };
  const matching=run([record(),record()]);
  stopOwnedCoordinatorProcess(123,configWithSpacesAndQuote,matching.options);
  assert.deepEqual(matching.signals,[[123,'SIGTERM']]);
  assert.equal(matching.calls.length,2);
  assert.ok(matching.calls.every(([command,args,options])=>command==='powershell.exe'
    && args[0]==='-NoProfile' && args[1]==='-NonInteractive' && args.includes('-Command')
    && args.at(-1).includes('ProcessId=123') && args.at(-1).includes('CreationDate')
    && options.timeout===5000 && options.windowsHide===true && options.shell!==true));

  const retry=run([Object.assign(new Error('PowerShell cold start'),{code:'ETIMEDOUT'}),record(),record()]);
  stopOwnedCoordinatorProcess(123,configWithSpacesAndQuote,retry.options);
  assert.deepEqual(retry.signals,[[123,'SIGTERM']]);
  assert.equal(retry.calls.length,3,'one timeout retry plus the second identity read');

  for(const outputs of [
    [record({ExecutablePath:'C:\\other\\node.exe'})],
    [record({ExecutablePath:'C:\\other\\node.exe'}),record({ExecutablePath:'C:\\other\\node.exe'})],
    [new Error('PowerShell unavailable')],
    ['not JSON'],
    [record(),record({CreationDate:'638972640000000002'})],
    ['[]'],
    ['null'],
    [''],
    [JSON.stringify([{ExecutablePath:process.execPath,CommandLine:commandLine,CreationDate:creationDate}])],
    [record({CommandLine:null})],
  ]){
    const f=run(outputs);
    assert.throws(()=>stopOwnedCoordinatorProcess(123,configWithSpacesAndQuote,f.options),/cannot verify/);
    assert.deepEqual(f.signals,[]);
  }
});

test('matching recorded identity with an alternate coordinator pathname receives the refusal code', ()=>{
  const owner=assertOwnedCoordinatorProcess(123,config,fixture());
  const status={protocol_version:1,pid:123,status:'listening',owner};
  const probes=[];
  const older=fixture({args:['node',olderCopy,'--host-config',config]});
  assert.throws(()=>hostProcessExists(status,{...older,configPath:config,processKill:(pid,signal)=>{probes.push([pid,signal]);}}),otherInstall);
  assert.throws(()=>hostProcessExists(status,{...fixture({args:['node',olderCopy,'--host-config',config]}),configPath:config,processKill:()=>{}}),copyNamed);
  assert.ok(probes.length>0&&probes.every(([pid,signal])=>pid===123&&signal===0),'the liveness probe is signal 0 only');
  assert.deepEqual(older.signals,[]);
  assert.throws(()=>stopOwnedCoordinatorProcess(123,config,older),generic);
  assert.deepEqual(older.signals,[],'an alternate pathname is never signalled');
});

test('an alternate pathname that cannot be resolved is unverified, never named as another install', ()=>{
  const owner=assertOwnedCoordinatorProcess(123,config,fixture());
  const status={protocol_version:1,pid:123,status:'listening',owner};
  const missing=fixture({args:['node',missingCopy,'--host-config',config]});
  assert.throws(()=>hostProcessExists(status,{...missing,configPath:config,processKill:()=>{}}),generic);
  assert.deepEqual(missing.signals,[]);
});

test('a foreign copy whose incarnation differs from the recorded owner is retired, not named as another install', ()=>{
  const owner=assertOwnedCoordinatorProcess(123,config,fixture());
  const status={protocol_version:1,pid:123,status:'listening',owner};
  const replaced=fixture({args:['node',olderCopy,'--host-config',config],starts:['43','43','43']});
  assert.equal(hostProcessExists(status,{...replaced,configPath:config,processKill:()=>{}}),false);
  assert.deepEqual(replaced.signals,[]);
});

test('a Linux process with extra arguments is never named as another install', ()=>{
  const owner=assertOwnedCoordinatorProcess(123,config,fixture());
  const status={protocol_version:1,pid:123,status:'listening',owner};
  const extra=fixture({args:['node',olderCopy,'--host-config',config,'--extra']});
  assert.throws(()=>hostProcessExists(status,{...extra,configPath:config,processKill:()=>{}}),generic);
});

test('macOS names an older Faravan copy by reason code only for the same owner, config and exact command shape', ()=>{
  const own=`${process.execPath} ${executable} --host-config ${config}`;
  const older=`${process.execPath} ${olderCopy} --host-config ${config}`;
  const wrongConfig=`${process.execPath} ${olderCopy} --host-config /other/host.json`;
  const unrelated=`unrelated --input ${olderCopy} --host-config ${config}`;
  const extra=`${process.execPath} ${olderCopy} extra --host-config ${config}`;
  const start=String(Date.parse('Tue Oct 20 10:00:00 2026 GMT')*1000);
  const darwin=commands=>{let index=0;return {platform:'darwin',execFile:file=>file.endsWith('faravan-process-identity')?
    JSON.stringify({boot:'darwin:test',start,state:'live'}):`${commands[index++]}\n`};};
  const owner=assertOwnedCoordinatorProcess(123,config,darwin([own,own]));
  const status={protocol_version:1,pid:123,status:'listening',owner};
  assert.throws(()=>hostProcessExists(status,{...darwin([own,older,older]),configPath:config,processKill:()=>{}}),otherInstall);
  assert.throws(()=>hostProcessExists(status,{...darwin([own,wrongConfig,wrongConfig]),configPath:config,processKill:()=>{}}),generic);
  assert.throws(()=>hostProcessExists(status,{...darwin([own,unrelated,unrelated]),configPath:config,processKill:()=>{}}),generic);
  assert.throws(()=>hostProcessExists(status,{...darwin([own,extra,extra]),configPath:config,processKill:()=>{}}),generic);
});

test('Windows names an older Faravan copy by reason code only for the same config and exactly four decoded arguments', ()=>{
  const configPath=path.resolve('/disposable/My "Hosts"/host.json');
  const quote=value=>/\s|"/.test(value)?`"${value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`:value;
  const commandLine=(entry,cfg=configPath,extra=[])=>[process.execPath,entry,'--host-config',cfg,...extra].map(quote).join(' ');
  const record=line=>JSON.stringify({ExecutablePath:process.execPath,CommandLine:line,CreationDate:'638972640000000001',Boot:'638970000000000000'});
  const windows=outputs=>{let index=0;return {platform:'win32',execFile:()=>outputs[index++]};};
  const owner=assertOwnedCoordinatorProcess(123,configPath,windows([record(commandLine(executable)),record(commandLine(executable))]));
  const status={protocol_version:1,pid:123,status:'listening',owner};
  // The first output is this process's own identity; the next two are the observed copy.
  const observed=lines=>({...windows([record(commandLine(executable)),...lines]),configPath,processKill:()=>{}});
  assert.throws(()=>hostProcessExists(status,observed([record(commandLine(olderCopy)),record(commandLine(olderCopy))])),otherInstall);
  for(const lines of [
    [record(commandLine(olderCopy,'C:\\other\\host.json')),record(commandLine(olderCopy,'C:\\other\\host.json'))],
    [record(commandLine(olderCopy,configPath,['--extra'])),record(commandLine(olderCopy,configPath,['--extra']))],
    [record(['node',olderCopy,'--host-config',configPath].map(quote).join(' ')),record(['node',olderCopy,'--host-config',configPath].map(quote).join(' '))],
    [JSON.stringify({ExecutablePath:process.execPath,CreationDate:'638972640000000001',Boot:'638970000000000000'}),
      JSON.stringify({ExecutablePath:process.execPath,CreationDate:'638972640000000001',Boot:'638970000000000000'})],
  ]){
    assert.throws(()=>hostProcessExists(status,observed(lines)),generic);
  }
});

// The coordinator waits COORDINATOR_LOCK_WAIT_MS (10 s) for a live lock to be released before it refuses.
test('a second coordinator exits with a named error before any bind or status write', {timeout:30000}, async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'coordinator-duplicate-'));
  const release = acquireCoordinatorProcessLock(home);
  let child;
  t.after(() => { child?.kill(); release(); rmSync(home, {recursive:true, force:true}); });
  const configPath = path.join(home, 'host.json'), statusPath = path.join(home, 'status.json');
  writeFileSync(configPath, JSON.stringify({protocol_version:1, port:0, status_path:statusPath}));
  // A bind would leave direct evidence, regardless of which address/port it uses.
  const marker = path.join(home, 'bound'), guard = path.join(home, 'no-bind.cjs');
  writeFileSync(guard, `require('node:net').Server.prototype.listen = function () {
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bound');
    throw new Error('unexpected bind');
  };`);
  child = spawn(process.execPath, [executable, '--host-config', configPath], {
    stdio:['ignore','pipe','pipe'],
    env:{...process.env, NODE_OPTIONS:(process.env.NODE_OPTIONS ?? '') + ' --require ' + JSON.stringify(guard)},
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  assert.equal(code, 1, stderr);
  const refusal = stdout.trim().split('\n').map(line => JSON.parse(line)).find(value => value.type === 'host_error');
  assert.equal(refusal?.code, 'coordinator_already_running', stderr);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(statusPath), false);
});

test('coordinator gates are independent per home and reusable after release', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'coordinator-lock-'));
  let release, other;
  t.after(() => { release?.(); other?.(); rmSync(base, {recursive:true, force:true}); });
  const first = path.join(base, 'one'), second = path.join(base, 'two');
  release = acquireCoordinatorProcessLock(first); other = acquireCoordinatorProcessLock(second);
  assert.throws(() => acquireCoordinatorProcessLock(first), {code:'coordinator_already_running'});
  release();
  acquireCoordinatorProcessLock(first)();
});

test('coordinator ownership is recoverable after its process dies without cleanup', {timeout:10000}, async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'coordinator-crash-lock-'));
  const lockModule = new URL('../lib/v1/lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const {acquireCoordinatorProcessLock} = await import(${JSON.stringify(lockModule)});
    acquireCoordinatorProcessLock(${JSON.stringify(home)});
    process.send('locked');
    process.on('message', () => process.exit(0)); // intentionally no release handler
  `], {stdio:['ignore','ignore','pipe','ipc']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  closed.catch(() => {});
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; rmSync(home, {recursive:true, force:true}); });
  await new Promise((resolve, reject) => {
    child.once('message', value => value === 'locked' ? resolve() : reject(new Error('unexpected child message')));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('child exited before publishing its lock: ' + stderr)));
  });
  assert.throws(() => acquireCoordinatorProcessLock(home), {code:'coordinator_already_running'});
  child.send('exit');
  assert.equal(await closed, 0, stderr);
  acquireCoordinatorProcessLock(home)();
});

test('J4-1 previous local boot is stale without probing or signalling its PID',()=>{
  const io=fixture(),owner=assertOwnedCoordinatorProcess(123,config,io);
  owner.boot='previous-boot';
  assert.equal(hostProcessExists({protocol_version:1,pid:123,status:'listening',owner},
    {...io,configPath:config,processKill:()=>assert.fail('old PID must not be probed')}),false);
});

test('J4-1 foreign host and same-boot foreign namespace remain unknown',()=>{
  const io=fixture(),owner=assertOwnedCoordinatorProcess(123,config,io);
  for(const changed of [{host:'another-machine',boot:'old'},{namespace:'pid:[another]'}])
    assert.throws(()=>hostProcessExists({protocol_version:1,pid:123,status:'listening',owner:{...owner,...changed}},
      {...io,configPath:config,processKill:()=>assert.fail('must not probe')}),/cannot verify/);
});
