import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeepAwake, inhibitorCommand, readPower } from '../lib/v1/keep-awake.mjs';
import { hostingView, setKeepAwake } from '../lib/v1/hosting-view.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

for (const release of ['stop', 'switch off', 'battery']) test('keep-awake releases its whole helper tree on ' + release, {skip:!['linux','darwin'].includes(process.platform),timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'spk-awake-tree-')), file = join(dir, 'pids.json');
  let enabled = true, powered = true, helper, pids;
  t.after(async () => {
    if (helper?.pid) { try { process.kill(-helper.pid, 'SIGKILL'); } catch {} }
    for (const pid of [pids?.descendant, helper?.pid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(dir, {recursive:true,force:true});
  });
  const awake = createKeepAwake({platform:process.platform, enabled:()=>enabled, power:()=>powered,
    spawn:(_command,_args,options) => helper = nodeSpawn(process.execPath, ['-e', `
      const {spawn}=require('node:child_process');
      const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('node:fs').writeFileSync(process.argv[1],JSON.stringify({descendant:descendant.pid}));
      setInterval(()=>{},1000);
    `, file], options)});
  awake.tick();
  for (let i=0;i<200;i++) { try { pids=JSON.parse(await readFile(file,'utf8')); break; } catch { await delay(10); } }
  assert.ok(pids?.descendant, 'the helper has a real descendant before release');
  if (release === 'stop') await awake.stop();
  else { if (release === 'switch off') enabled=false; else powered=false; awake.tick(); await awake.stop(); }
  for (const pid of [helper.pid,pids.descendant]) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'no helper or descendant remains');
  assert.equal(awake.state().active,false);
});

// H2: the host stays awake while it hosts and is on power, unless the person says no; a sleep that happened anyway is reported.
function fakeSpawn() {
  const children = [];
  const spawn = (command, args, options) => {
    const stdin = { destroyed: false, unreferenced: false, handlers: {}, once(event, fn) { this.handlers[event] = fn; }, unref() { this.unreferenced = true; }, destroy() { this.destroyed = true; } };
    const child = { command, args, options, stdin, killed: false, handlers: {}, once(event, fn) { this.handlers[event] = fn; return this; }, unref() {}, kill() { this.killed = true; this.handlers.exit?.(); } };
    children.push(child); return child;
  };
  return { spawn, children };
}

test('the right assertion per platform, tied to the host process so it cannot outlive it', () => {
  assert.deepEqual(inhibitorCommand('darwin', 4242), ['caffeinate', ['-i', '-w', '4242']]);
  const [command, args] = inhibitorCommand('linux', 4242);
  assert.equal(command, 'systemd-inhibit'); assert.ok(args.includes('--what=idle:sleep') && args.at(-1).includes('read'));
  assert.equal(inhibitorCommand('win32', 1), null);
  assert.deepEqual(inhibitorCommand('linux', 4242), inhibitorCommand('linux', 9876));
  assert.doesNotMatch(args.at(-1), /kill|sleep|&/);
});

test('only explicit true power permits one helper; temporary suspension is reversible', async () => {
  const {spawn, children} = fakeSpawn();
  let on = true, powered = true;
  const awake = createKeepAwake({platform:'linux', spawn, enabled:()=>on, power:()=>powered});
  const released = async () => { for(let i=0;i<100&&awake.state().reason==='stopping';i++) await delay(1); };
  for(const unknown of [false,null,undefined,'unknown',1]) {
    powered=unknown; awake.tick(); assert.equal(children.length,0);
  }
  powered=true; awake.tick(); awake.tick(); assert.equal(children.length,1);
  assert.equal(awake.state().reason,'on');
  powered=false; awake.tick(); assert.equal(awake.state().reason,'stopping');
  powered=true; awake.tick(); assert.equal(children.length,1);
  await released(); awake.tick(); assert.equal(children.length,2);
  on=false; awake.tick(); await released();
  assert.equal(awake.state().reason,'off_by_choice');
  on=true; powered=null; awake.tick(); assert.equal(children.length,2);
  assert.equal(awake.state().reason,'power_unknown');
  powered=true; awake.tick(); assert.equal(children.length,3);
  const stopping=awake.stop(); assert.equal(awake.stop(),stopping);
  awake.tick(); queueMicrotask(()=>awake.tick()); await stopping; awake.tick();
  assert.equal(children.length,3); assert.equal(awake.state().reason,'stopped');
  assert.equal(awake.state().active,false);
});

test('terminal stop seals an instance even before its first tick', async () => {
  const {spawn,children}=fakeSpawn(), awake=createKeepAwake({platform:'linux',spawn,power:()=>true});
  const stopped=awake.stop(); awake.tick(); await stopped; awake.tick();
  assert.equal(children.length,0);
});

test('failed teardown remains visible and repeated stop preserves the same rejection', async () => {
  const failure=new Error('private helper teardown failed');
  let spawns=0, writerClosed=false;
  const awake=createKeepAwake({platform:'linux',power:()=>true,spawn:()=>{
    spawns++;return {stdin:{once(){},unref(){},destroy(){writerClosed=true;}},once(){return this;},unref(){},kill(){throw failure;}};
  }});
  awake.tick(); const stopped=awake.stop();
  assert.equal(awake.stop(),stopped);
  await assert.rejects(stopped,error=>error===failure);
  assert.equal(writerClosed,true,'EOF still released when signalling fails');
  awake.tick(); assert.equal(spawns,1);
  assert.equal(awake.state().reason,'stop_failed');
  assert.equal(awake.state().active,true,'release was not confirmed');
  await assert.rejects(awake.stop(),error=>error===failure);
});

test('power returning cannot overlap real helper groups during delayed teardown', {skip:!['linux','darwin'].includes(process.platform),timeout:10000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'spk-awake-pending-')), ready=join(dir,'ready'), term=join(dir,'term');
  const children=[]; let powered=true;
  t.after(async()=>{for(const child of children)if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}await rm(dir,{recursive:true,force:true});});
  const awake=createKeepAwake({platform:process.platform,power:()=>powered,spawn:(_cmd,_args,options)=>{
    const child=nodeSpawn(process.execPath,['-e',`
      const fs=require('node:fs');setInterval(()=>{},1000);
      process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[2],'term');setTimeout(()=>process.exit(0),300);});
      fs.writeFileSync(process.argv[1],'ready');
    `,ready,term],options);children.push(child);return child;
  }});
  const waitFile=async file=>{for(let i=0;i<200;i++){try{await readFile(file);return;}catch{await delay(10);}}assert.fail('helper did not reach expected phase');};
  awake.tick();await waitFile(ready);
  powered=false;awake.tick();await waitFile(term);
  assert.equal(awake.state().reason,'stopping');assert.equal(awake.state().active,true);
  powered=true;awake.tick();awake.tick();assert.equal(children.length,1);
  for(let i=0;i<300&&awake.state().reason==='stopping';i++)await delay(10);
  assert.throws(()=>process.kill(-children[0].pid,0),{code:'ESRCH'});
  awake.tick();assert.equal(children.length,2);
  const stopped=awake.stop();assert.equal(awake.stop(),stopped);
  awake.tick();await stopped;awake.tick();assert.equal(children.length,2);
  assert.equal(awake.state().active,false);
});

test('a platform without a tool, or a missing tool, is "unsupported" and never throws', () => {
  const none = createKeepAwake({ platform: 'win32', spawn: () => { throw new Error('no'); }, power: () => true });
  none.tick(); assert.equal(none.state().reason, 'unsupported');
  const missing = createKeepAwake({ platform: 'linux', power: () => true, spawn: () => { const child = { once(event, fn) { if (event === 'error') queueMicrotask(fn); return this; }, unref() {}, kill() {} }; return child; } });
  missing.tick();
  return new Promise(resolve => setImmediate(() => { missing.tick(); assert.equal(missing.state().reason, 'unsupported'); resolve(); }));
});

test('a long gap between ticks is recorded as a wake, with how long the computer was asleep', () => {
  let clock = Date.parse('2026-10-19T10:00:00Z');
  const awake = createKeepAwake({ platform: 'linux', spawn: fakeSpawn().spawn, now: () => clock, power: () => true });
  clock += 5000; awake.tick();
  assert.equal(awake.state().last_wake, null, 'normal ticks are not wakes');
  clock += 3 * 3600 * 1000 + 12000; awake.tick();
  assert.deepEqual(awake.state().last_wake, { at: '2026-10-19T13:00:17.000Z', gap_seconds: 10812 });
});

for (const [name, supplies, expected] of [
  ['Mains online', [['Mains', '1\n']], true],
  ['Mains offline', [['Mains', '0\n']], false],
  ['USB online', [['USB', '1\n']], true],
  ['USB offline', [['USB', '0\n']], false],
  ['missing online', [['Mains', undefined]], null],
  ['empty online', [['Mains', '']], null],
  ['whitespace online', [['USB', ' \n']], null],
  ['malformed online', [['Mains', 'garbage\n']], null],
  ['noncanonical online', [['USB', '01\n']], null],
  ['unknown online', [['USB', '2\n']], null],
  ['offline plus missing', [['Mains', '0\n'], ['USB', undefined]], null],
  ['offline plus malformed', [['USB', '0\n'], ['Mains', 'garbage\n']], null],
  ['online plus missing', [['USB', '1\n'], ['Mains', undefined]], true],
  ['online plus malformed', [['Mains', '1\n'], ['USB', 'garbage\n']], true],
  ['missing supply type', [[undefined, '1\n']], null],
  ['empty supply type', [['', '1\n']], null],
  ['offline mains plus missing type', [['Mains', '0\n'], [undefined, '1\n']], null],
  ['online mains plus missing type', [['Mains', '1\n'], [undefined, '0\n']], true],
  ['all offline', [['Mains', '0\n'], ['USB', '0\n']], false],
  ['desktop', [], true],
  ['battery only', [['Battery', undefined]], null],
]) test('readPower preserves Linux evidence: ' + name, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'spk-power-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [index, [type, online]] of supplies.entries()) {
    const entry = join(dir, String(index));
    await mkdir(entry);
    // Missing file is a deterministic failed read, even when tests run as root.
    if (type !== undefined) await writeFile(join(entry, 'type'), type + '\n');
    if (online !== undefined) await writeFile(join(entry, 'online'), online);
  }
  const power = () => readPower({ platform: 'linux', powerSupplyDir: dir });
  assert.equal(power(), expected);
  const { spawn, children } = fakeSpawn();
  const awake = createKeepAwake({ platform: 'linux', spawn, power });
  try {
    awake.tick();
    assert.equal(children.length, expected === true ? 1 : 0);
    assert.equal(awake.state().active, expected === true);
    assert.equal(awake.state().reason, expected === true ? 'on' : expected === false ? 'on_battery' : 'power_unknown');
  } finally {
    await awake.stop();
  }
});

test('readPower returns unknown for an unavailable owned supply directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'spk-power-unavailable-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(readPower({ platform: 'linux', powerSupplyDir: join(dir, 'missing') }), null);
});

test('readPower reads mains and battery from the system, and a desktop as on power', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'spk-power-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const supply = async (name, type, online) => { await mkdir(join(dir, name)); await writeFile(join(dir, name, 'type'), type + '\n'); if (online !== undefined) await writeFile(join(dir, name, 'online'), online + '\n'); };
  assert.equal(readPower({ platform: 'linux', powerSupplyDir: dir }), true, 'no battery, no mains entry: a desktop');
  const desktop=fakeSpawn(), awake=createKeepAwake({platform:'linux',spawn:desktop.spawn,power:()=>readPower({platform:'linux',powerSupplyDir:dir})});
  awake.tick();assert.equal(desktop.children.length,1,'battery-free explicit true still permits an assertion');
  await awake.stop();
  await supply('BAT0', 'Battery'); assert.equal(readPower({ platform: 'linux', powerSupplyDir: dir }), null);
  await supply('AC', 'Mains', 0); assert.equal(readPower({ platform: 'linux', powerSupplyDir: dir }), false);
  await writeFile(join(dir, 'AC', 'online'), '1\n'); assert.equal(readPower({ platform: 'linux', powerSupplyDir: dir }), true);
  assert.equal(readPower({ platform: 'darwin', run: () => "Now drawing from 'Battery Power'" }), false);
  assert.equal(readPower({ platform: 'darwin', run: () => "Now drawing from 'AC Power'" }), true);
});

test('the hosting view reports the switch, what the host does, and the last wake; the switch writes the host config', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'spk-hosting-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { schema_version: 1, protocol_version: 1, port: 8787, collective_name: 'Weekend projects', status_path: join(dir, 'status.json'), circle_id: 'c1',
    v1_origin: 'https://x.example', reachability: { kind: 'url', publicUrl: 'https://x.example' } };
  await writeFile(join(dir, 'host.json'), JSON.stringify(config));
  await writeFile(join(dir, 'status.json'), JSON.stringify({ protocol_version: 1, pid: process.pid, port: 8787, status: 'public_listening', public_url: 'https://x.example',
    keep_awake: { enabled: true, active: true, reason: 'on' }, last_wake: { at: '2026-10-19T13:00:17.000Z', gap_seconds: 10812 } }));
  const device = { keyId: 'me', listCircles: async () => [{ id: 'c1', name: 'Weekend projects' }], rosterCache: () => ({ get: async () => ({ current: { payload: { members: [] } } }) }) };
  const view = () => hostingView({ home: dir, device, presence: async () => ({ devices: [] }), processExists:status=>status?.pid===process.pid });
  let out = await view();
  assert.deepEqual(out.keepAwake, { enabled: true, active: true, reason: 'on' });
  assert.deepEqual(out.lastWake, { at: '2026-10-19T13:00:17.000Z', gapSeconds: 10812 });
  assert.equal(setKeepAwake({ home: dir, on: false }), true);
  assert.equal(JSON.parse(await readFile(join(dir, 'host.json'), 'utf8')).keep_awake, false);
  assert.equal(JSON.parse(await readFile(join(dir, 'host.json'), 'utf8')).collective_name, 'Weekend projects', 'nothing else in the config changed');
  out = await view();
  assert.equal(out.keepAwake.enabled, false);
  assert.equal(setKeepAwake({ home: join(dir, 'nowhere'), on: true }), false, 'a computer that hosts nothing has no switch');
});

test('the app serves the switch: POST /api/hosting/keep-awake', { timeout: 120000 }, async t => {
  const { appFixture, api } = await import('./helpers/v1-app-fixture.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-hosting-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'host.json'), JSON.stringify({ schema_version: 1, protocol_version: 1, port: 8787, collective_name: 'W', status_path: join(dir, 'status.json') }));
  const f = await appFixture(t);
  const { app } = await f.start('hosting', { coordinatorHome: dir });
  const view = await api(app, '/api/hosting/keep-awake', { method: 'POST', body: { on: false } });
  assert.equal(view.keepAwake.enabled, false);
  await api(app, '/api/hosting/keep-awake', { method: 'POST', body: { on: 'yes' }, status: 400 });
  await api(app, '/api/hosting/keep-awake', { method: 'POST', body: {}, status: 400 });
  const nobody = await f.start('nobody', { coordinatorHome: join(dir, 'empty') });
  await api(nobody.app, '/api/hosting/keep-awake', { method: 'POST', body: { on: true }, status: 404 });
});

test('Linux owns one unreferenced writer and closes it before signalling', async () => {
  const {spawn,children}=fakeSpawn();let powered=true;
  const awake=createKeepAwake({platform:'linux',power:()=>powered,spawn});
  awake.tick();const first=children[0];
  assert.deepEqual(first.options.stdio,['pipe','ignore','ignore']);
  assert.equal(first.stdin.unreferenced,true);
  first.kill=function(){assert.equal(this.stdin.destroyed,true);awake.tick();assert.equal(children.length,1,'reentry cannot spawn during cessation');this.handlers.exit?.();};
  powered=false;awake.tick();await new Promise(resolve=>setImmediate(resolve));
  powered=true;awake.tick();assert.equal(children.length,2);
  assert.notEqual(children[1].stdin,first.stdin);assert.equal(children[1].stdin.destroyed,false);
  await awake.stop();assert.equal(children[1].stdin.destroyed,true);
});
test('unavailable writer and spawn errors never fall back to PID watching', async () => {
  for(const kind of ['missing','destroyed','throw','async-error']){
    const {spawn,children}=fakeSpawn();let calls=0;
    const awake=createKeepAwake({platform:'linux',power:()=>true,spawn:(...args)=>{
      calls++;if(kind==='throw')throw new Error('pipe creation failed');
      const child=spawn(...args);
      if(kind==='missing')child.stdin=null;
      if(kind==='destroyed')child.stdin.destroyed=true;
      if(kind==='async-error')queueMicrotask(()=>child.handlers.error(new Error('ENOENT')));
      return child;
    }});
    awake.tick();await new Promise(resolve=>setImmediate(resolve));awake.tick();
    assert.equal(calls,1,kind);assert.equal(awake.state().reason,'unsupported',kind);
    assert.equal(awake.state().active,false,kind);
    for(const child of children)if(child.stdin)assert.equal(child.stdin.destroyed,true,kind);
    await awake.stop();
  }
});

// No real inhibitor: wrapper executes and reaps the actual generated watched command.
// This proves pipe lifetime, not systemd installation compatibility or instantaneous release.
for(const release of ['SIGKILL','EOF','natural exit']) test('owned writer '+release+' ends Linux watcher while numeric PID stays alive',
  {skip:process.platform!=='linux',timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'spk-awake-eof-'));
  const ready=join(dir,'ready.json'),done=join(dir,'done.json');
  const wrapper=join(dir,'wrapper.cjs'),ownerFile=join(dir,'owner.mjs');
  let owner,info,finished=false;
  const waitJson=async file=>{
    for(let i=0;i<500;i++){try{return JSON.parse(await readFile(file,'utf8'));}catch{await delay(10);}}
    assert.fail('fixture did not produce '+file);
  };
  t.after(async()=>{
    if(owner&&owner.exitCode===null&&owner.signalCode===null){
      const exited=new Promise(resolve=>owner.once('exit',resolve));owner.kill('SIGKILL');await exited;
    }
    if(!info){try{info=JSON.parse(await readFile(ready,'utf8'));}catch{}}
    if(info&&!finished){
      // Killing the sole writer normally lets the wrapper reap its shell even after assertion failure.
      try { await waitJson(done); finished=true; } catch {}
    }
    if(info&&!finished){try{process.kill(-info.wrapper,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    owner?.stdin?.destroy();owner?.stdout?.destroy();owner?.stderr?.destroy();
    await rm(dir,{recursive:true,force:true});
  });
  await writeFile(wrapper, [
    "const fs=require('node:fs'),{spawn}=require('node:child_process');",
    "const args=JSON.parse(process.argv[2]),ready=process.argv[3],done=process.argv[4];",
    "const index=args.indexOf('sh');if(index<0)throw new Error('missing watched command');",
    "const watched=spawn(args[index],args.slice(index+1),{stdio:['inherit','ignore','ignore']});",
    "watched.once('error',error=>{fs.writeFileSync(done,JSON.stringify({error:error.message}));process.exitCode=1;});",
    "watched.once('spawn',()=>fs.writeFileSync(ready,JSON.stringify({wrapper:process.pid,watched:watched.pid})));",
    "watched.once('close',(code,signal)=>{process.once('exit',()=>fs.writeFileSync(done,JSON.stringify({code,signal})));});",
  ].join('\n'));
  const moduleURL=new URL('../lib/v1/keep-awake.mjs',import.meta.url).href;
  await writeFile(ownerFile, [
    "import {spawn} from 'node:child_process';",
    "import {createKeepAwake} from "+JSON.stringify(moduleURL)+";",
    "let helper;",
    "const awake=createKeepAwake({platform:'linux',pid:"+process.pid+",power:()=>true,",
    "spawn:(command,args,options)=>{",
    "if(command!=='systemd-inhibit')throw new Error('wrong command');",
    "helper=spawn(process.execPath,["+JSON.stringify(wrapper)+",JSON.stringify(args),"+JSON.stringify(ready)+","+JSON.stringify(done)+"],options);return helper;}});",
    "awake.tick();process.on('SIGUSR1',()=>helper.stdin.destroy());"+(release==='natural exit'?'':"setInterval(()=>{},1000);"),
  ].join('\n'));
  owner=nodeSpawn(process.execPath,[ownerFile],{stdio:'ignore'});
  const ownerExited=new Promise(resolve=>owner.once('exit',resolve));
  info=await waitJson(ready);
  if(release!=='natural exit')await assert.rejects(readFile(done),{code:'ENOENT'},'live sole writer keeps command waiting');
  process.kill(process.pid,0);
  if(release!=='natural exit')owner.kill(release==='SIGKILL'?'SIGKILL':'SIGUSR1');
  if(release!=='EOF')await ownerExited;
  const result=await waitJson(done);
  assert.deepEqual(result,{code:0,signal:null},'EOF rather than PID death ends watched command');
  assert.throws(()=>process.kill(info.watched,0),{code:'ESRCH'},'wrapper reaped watched shell');
  process.kill(process.pid,0);
  finished=true;
  if(release==='EOF'){owner.kill('SIGKILL');await ownerExited;}
});

test('unexpected helper exit closes its writer before retry', async () => {
  const {spawn,children}=fakeSpawn();
  const awake=createKeepAwake({platform:'linux',power:()=>true,spawn});
  awake.tick();children[0].handlers.exit();
  assert.equal(children[0].stdin.destroyed,true);
  awake.tick();assert.equal(children.length,1,'no replacement inside cessation fence');
  await new Promise(resolve=>setImmediate(resolve));
  awake.tick();assert.equal(children.length,2);
  assert.equal(children[1].stdin.destroyed,false);
  await awake.stop();
});

test('writer errors close the channel and fence further admission', async () => {
  const {spawn,children}=fakeSpawn();
  const awake=createKeepAwake({platform:'linux',power:()=>true,spawn});
  awake.tick();children[0].stdin.handlers.error(new Error('EPIPE'));
  assert.equal(children[0].stdin.destroyed,true);
  await new Promise(resolve=>setImmediate(resolve));
  awake.tick();assert.equal(children.length,1);
  assert.equal(awake.state().reason,'unsupported');await awake.stop();
});
