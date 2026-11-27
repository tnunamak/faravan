import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCoordinator, createCoordinatorServer, COORDINATOR_SCHEMA_VERSION } from '../lib/coordinator.mjs';
import { provisionV1Store } from '../lib/v1/store.mjs';
import { strictParse } from '../lib/protocol/index.mjs';
import { openDevice } from '../lib/v1/device.mjs';
import { readPower } from '../lib/v1/keep-awake.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const ORIGIN = 'https://coordinator.example';
const EXECUTABLE = new URL('../bin/faravan-coordinator', import.meta.url).pathname;
const V0_GUIDANCE = /separate FARAVAN_COORDINATOR_HOME.*FARAVAN_COORDINATOR_HOME remains supported/;

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// A real offline circle: signed roster and root, no network, no sandbox/provider.
async function circleFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-coordinator-test-'));
  const cleanups = [];
  t.after(async () => {
    const errors=[];
    for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch(error) { errors.push(error); }
    if(errors.length)throw new AggregateError(errors,'Fixture cleanup unconfirmed; retained '+dir);
    rmSync(dir, {recursive:true, force:true});
  });
  const device = await openDevice({ home: join(dir, 'device'), origin: null, ensureDefault: false,
    fetch: async () => { throw new Error('test must not use network'); } });
  const created = await device.createCircle(ORIGIN, { name: 'Test-only circle', publish: false });
  const provisioning = strictParse(readFileSync(created.provisioningPath, 'utf8'), { canonical: false });
  return { dir, circle: created, provisioning, after: cleanup => cleanups.push(cleanup),
    provision: (path) => provisionV1Store({ path, provisioning }) };
}

const capabilities = (f) => `/v1/circles/${f.circle.id}/capabilities`;
// Like the real layout, <home>/v1 exists before the server starts (the
// provisioning command and the host flow create it); the database does not.
function v1Settings(dir, name = 'coordinator') {
  mkdirSync(join(dir, name), { recursive: true });
  return { dbPath: join(dir, name, 'coordinator.sqlite'), blobDir: join(dir, name, 'blobs'), origin: ORIGIN };
}

test('startCoordinator serves 404 problem until local provisioning, then the v1 handler', async (t) => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  const server = await startCoordinator({ port: 0, v1 });
  f.after(() => closeServer(server));
  const bound = `http://127.0.0.1:${server.address().port}`;

  const before = await fetch(`${bound}${capabilities(f)}`);
  assert.equal(before.status, 404);
  assert.equal((await before.json()).code, 'circle_not_provisioned');
  assert.equal(existsSync(v1.dbPath), false, 'HTTP must never allocate a circle');

  f.provision(v1.dbPath);
  const unauthenticated = await fetch(`${bound}${capabilities(f)}`);
  assert.equal(unauthenticated.status, 401, 'the provisioned store is picked up without a restart');
  assert.equal((await unauthenticated.json()).code, 'unauthenticated');
});

test('startCoordinator reopens an already provisioned circle and releases it on close', async (t) => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  f.provision(v1.dbPath);
  for (let round = 0; round < 2; round += 1) {
    const server = await startCoordinator({ port: 0, v1 });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${capabilities(f)}`);
    assert.equal(response.status, 401, `round ${round}`);
    await response.arrayBuffer();
    await closeServer(server);
  }
});

test('invite landing paths belong to v1 and no other path does', async (t) => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  f.provision(v1.dbPath);
  const server = await startCoordinator({ port: 0, v1 });
  f.after(() => closeServer(server));
  const bound = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/join', '/i/abcdef']) {
    const response = await fetch(bound + path, { headers: { accept: 'text/html' } });
    assert.notEqual(response.headers.get('x-faravan-coordinator-schema'), String(COORDINATOR_SCHEMA_VERSION), path);
    await response.arrayBuffer();
  }
});

test('coordinator serves the join page icon assets with image content types', async t => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  f.provision(v1.dbPath);
  const server = await startCoordinator({ port: 0, v1 });
  f.after(() => closeServer(server));
  const bound = `http://127.0.0.1:${server.address().port}`;
  for (const [path, type] of [['/favicon.svg','image/svg+xml'],['/favicon.ico','image/vnd.microsoft.icon'],
    ['/manifest.webmanifest','application/manifest+json']]) {
    const response = await fetch(bound + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
});

test('removed v0 routes and the old landing page are a JSON 404 with or without credentials', async (t) => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  f.provision(v1.dbPath);
  const server = await startCoordinator({ port: 0, v1 });
  f.after(() => closeServer(server));
  const bound = `http://127.0.0.1:${server.address().port}`;
  const routes = [['GET', '/'], ['GET', '/missing'], ['GET', '/tasks'], ['GET', '/tasks/next'],
    ['GET', '/tasks/' + 'a'.repeat(64)], ['POST', '/tasks'], ['POST', `/tasks/${'a'.repeat(64)}/claim`],
    ['POST', `/tasks/${'a'.repeat(64)}/submit`], ['GET', '/requests'], ['GET', '/activity'],
    ['GET', '/roster'], ['PUT', '/artifacts/' + 'a'.repeat(64)], ['GET', '/artifacts/' + 'a'.repeat(64)]];
  for (const [method, path] of routes) {
    for (const headers of [{}, { accept: 'text/html' }, { authorization: 'Bearer test-only-ignored' }]) {
      const response = await fetch(bound + path, { method, headers,
        ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      assert.equal(response.headers.get('x-faravan-coordinator-schema'), String(COORDINATOR_SCHEMA_VERSION));
      assert.deepEqual(await response.json(), { error: 'not found' });
    }
  }
});

test('v0 token/roster settings and incomplete v1 settings are rejected before any state is created', async (t) => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  const roster = new Map([['key', 'test-only']]);
  await assert.rejects(startCoordinator({ port: 0, v1, token: 'test-only' }), /token\/roster.*no longer supported/);
  await assert.rejects(startCoordinator({ port: 0, v1, roster }), /token\/roster.*no longer supported/);
  await assert.rejects(startCoordinator({ port: 0 }), /v1 settings are required/);
  await assert.rejects(startCoordinator({ port: 0, v1: { ...v1, origin: 'http://example.com' } }), /origin/);
  await assert.rejects(startCoordinator({ port: 0, v1: { ...v1, blobDir: '' } }), /blobDir/);
  assert.throws(() => createCoordinatorServer(), /v1 coordinator settings are required/);
  assert.equal(existsSync(v1.dbPath), false);
});

test('a failed listen disposes the opened store so the circle can be served again', async (t) => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  f.provision(v1.dbPath);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  f.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(startCoordinator({ port: blocker.address().port, v1 }), { code: 'EADDRINUSE' });
  const server = await startCoordinator({ port: 0, v1 });
  const response = await fetch(`http://127.0.0.1:${server.address().port}${capabilities(f)}`);
  assert.equal(response.status, 401);
  await response.arrayBuffer();
  await closeServer(server);
});

test('close aborts nothing twice: repeated close and dispose after provisioning are safe', async (t) => {
  const f = await circleFixture(t);
  const v1 = v1Settings(f.dir);
  const server = await startCoordinator({ port: 0, v1 });
  f.provision(v1.dbPath);
  const response = await fetch(`http://127.0.0.1:${server.address().port}${capabilities(f)}`);
  await response.arrayBuffer();
  await closeServer(server);
  assert.equal(server.listening, false);
  assert.doesNotThrow(() => server.close(() => {}));
});

// --- executable --------------------------------------------------------

function run(args, { env = {}, home } = {}) {
  return spawnSync(process.execPath, [EXECUTABLE, ...args], { encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, HOME: home, FARAVAN_COORDINATOR_HOME: home, ...env } });
}

async function startExecutable(f, { args = [], env = {}, home }) {
  const child = spawn(process.execPath, [EXECUTABLE, ...args], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, FARAVAN_COORDINATOR_HOME: home,
      FARAVAN_COORDINATOR_PORT: '0', ...env } });
  f.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) {
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`executable exited ${code}: ${stderr}`)));
  });
  return { child, status };
}

test('executable rejects a v0 host configuration without modifying it', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'faravan-coordinator-v0-host-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const body of ['{"protocol_version":0,"data_dir":"old-jobs","roster_path":"r","collective_token_path":"t"}',
    '{"data_dir":"old-jobs","roster_path":"r"}']) {
    const configFile = join(home, 'host.json');
    writeFileSync(configFile, body, { mode: 0o600 });
    const result = run(['--host-config', configFile], { home });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a v1 host/);
    assert.match(result.stderr, V0_GUIDANCE);
    assert.equal(readFileSync(configFile, 'utf8'), body);
    assert.equal(existsSync(join(home, 'status.json')), false);
    assert.equal(existsSync(join(home, 'tasks')), false);
    assert.equal(existsSync(join(home, 'v1')), false);
  }
});

test('executable rejects v0 environment credentials and requires an explicit v1 origin', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'faravan-coordinator-v0-env-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const env of [{ FARAVAN_COLLECTIVE_TOKEN: 'test-only' },
    { FARAVAN_COORDINATOR_ROSTER_FILE: join(home, 'roster.json') },
    { FARAVAN_COORDINATOR_V1: '1', FARAVAN_COLLECTIVE_TOKEN: 'test-only', FARAVAN_COORDINATOR_V1_ORIGIN: ORIGIN }]) {
    const result = run([], { home, env: { FARAVAN_COORDINATOR_PORT: '0', ...env } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /v0 settings/);
    assert.match(result.stderr, V0_GUIDANCE);
  }
  const missing = run([], { home, env: { FARAVAN_COORDINATOR_PORT: '0' } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /FARAVAN_COORDINATOR_V1_ORIGIN is required/);
  const badPort = run([], { home, env: { FARAVAN_COORDINATOR_PORT: 'nope', FARAVAN_COORDINATOR_V1_ORIGIN: ORIGIN } });
  assert.notEqual(badPort.status, 0);
  assert.match(badPort.stderr, /valid port/);
  assert.notEqual(run(['--bogus'], { home }).status, 0);
});

for (const managed of [false, true]) {
  test(`executable serves v1 only from a provisioned home (${managed ? 'host config' : 'environment'})`, async (t) => {
    const f = await circleFixture(t);
    const home = join(f.dir, 'home');
    const provision = run(['--v1-provision', f.circle.provisioningPath], { home });
    assert.equal(provision.status, 0, provision.stderr);
    assert.equal(JSON.parse(provision.stdout).status, 'provisioned');
    assert.notEqual(run(['--v1-provision', f.circle.provisioningPath], { home }).status, 0, 'provisioning is one-shot');

    const statusFile = join(home, 'status.json');
    let args = [], env = { FARAVAN_COORDINATOR_V1_ORIGIN: ORIGIN };
    if (managed) {
      const configFile = join(home, 'host.json');
      writeFileSync(configFile, JSON.stringify({ schema_version: 1, protocol_version: 1, port: 0,
        keep_awake:false, // Protocol fixtures must not start the machine's native sleep inhibitor.
        collective_name: 'Test-only circle', v1_origin: ORIGIN, status_path: statusFile,
      }), {mode:0o600});
      args = ['--host-config', configFile]; env = {};
    }
    const { child, status } = await startExecutable(f, { args, env, home });
    assert.equal(status.status, 'listening');
    assert.equal(status.protocol_version, 1);
    assert.equal(status.pid, child.pid);
    assert.ok(status.port > 0);
    assert.equal(status.roster_size, 0);
    assert.equal(status.data_dir, join(home, 'tasks'));
    const bound = `http://127.0.0.1:${status.port}`;
    assert.equal((await fetch(`${bound}${capabilities(f)}`)).status, 401);
    assert.equal((await fetch(`${bound}/tasks`, { headers: { authorization: 'Bearer test-only' } })).status, 404);
    assert.equal(existsSync(join(home, 'tasks')), false, 'no v0 state directory');
    if (managed) {
      assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).status, 'listening');
      assert.equal(status.collective_name, 'Test-only circle');
      assert.equal(status.public_url, undefined, 'an operator-configured origin is not proof of a published route');
    }
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
    if (managed) assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).status, 'stopped');
  });
}

test('managed coordinator stops its entire keep-awake tree before exiting', {skip:process.platform !== 'linux',timeout:15000}, async t => {
  if (readPower() === false) { t.skip('the host intentionally does not inhibit sleep on battery'); return; }
  const f = await circleFixture(t), home = join(f.dir,'host'), bin = join(f.dir,'bin'), pidsFile = join(f.dir,'pids.json');
  let pids;
  f.after(() => { for (const pid of [pids?.helper,pids?.descendant]) if (pid) { try { process.kill(pid,'SIGKILL'); } catch {} } });
  mkdirSync(bin);
  // Exercise the real coordinator lifecycle without invoking the computer's power manager.
  writeFileSync(join(bin,'systemd-inhibit'), `#!${process.execPath}\n
    const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({helper:process.pid,descendant:descendant.pid}));
    setInterval(()=>{},1000);
  `, {mode:0o755});
  assert.equal(run(['--v1-provision',f.circle.provisioningPath],{home}).status,0);
  const configFile = join(home,'host.json');
  writeFileSync(configFile,JSON.stringify({schema_version:1,protocol_version:1,port:0,collective_name:'Test-only circle',v1_origin:ORIGIN,
    status_path:join(home,'status.json'),keep_awake:true}));
  const {child} = await startExecutable(f,{home,args:['--host-config',configFile],env:{PATH:bin+':'+process.env.PATH}});
  for (let i=0;i<200;i++) { try { pids=JSON.parse(readFileSync(pidsFile,'utf8')); break; } catch { await delay(10); } }
  assert.ok(pids?.descendant,'the fake inhibitor owns a real child');
  const exited = once(child,'exit'); child.kill('SIGTERM');
  assert.equal((await exited)[0],0);
  for (const pid of [pids.helper,pids.descendant]) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'shutdown leaves no inhibitor or descendant');
});


// Failure injection stays in the owned managed child. NODE_OPTIONS preserves
// the exact four-argument OS identity required by captureCoordinatorOwner.
async function shutdownWait(predicate, message) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail(message);
}
async function shutdownClose(closed, message) {
  let timer;
  try {
    return await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
for (const [stopMode,signal] of [
  ['resolve','SIGTERM'],['reject','SIGINT'],['throw','SIGHUP'],
]) test('managed shutdown '+stopMode, {timeout:45000}, async t => {
  const f=await circleFixture(t),home=join(f.dir,'managed shutdown home');
  const parentOptions=process.env.NODE_OPTIONS;
  assert.equal(run(['--v1-provision',f.circle.provisioningPath],{home}).status,0);
  const statusFile=join(home,'status.json'),configFile=join(home,'host.json');
  const events=join(home,'cleanup-events.jsonl'),awakeRelease=join(home,'release-awake');
  const loader=join(home,'owned preload.mjs');
  const config={schema_version:1,protocol_version:1,port:0,keep_awake:true,
    collective_name:'Test-only circle',v1_origin:ORIGIN,status_path:statusFile};
  writeFileSync(configFile,JSON.stringify(config));
  const fixturePrelude = `
    import {appendFileSync,existsSync} from 'node:fs';
    const event=name=>appendFileSync(${JSON.stringify(events)},JSON.stringify({name})+'\\n');
    const wait=()=>new Promise(resolve=>{const check=()=>existsSync(${JSON.stringify(awakeRelease)})?resolve():setTimeout(check,10);check();});
  `;
  const awakeSource = fixturePrelude + `
    export function createKeepAwake({enabled}) {
      let active=false,sealed=false,reason='starting',terminal;
      const tick=()=>{if(sealed){event('tick-sealed');return;}active=true;reason='on';event('active');};
      globalThis.__ownedAwakeTick=tick;
      return {tick,tickMs:60000,state:()=>({enabled:enabled(),active,reason}),stop(){
        if(sealed){event('stop-repeat');if(${JSON.stringify(stopMode)}==='throw')throw Error('PRIVATE_AWAKE_DIAGNOSTIC');return terminal;}
        sealed=true;globalThis.__ownedAwakeSealed=true;event('stop-seal');
        if(${JSON.stringify(stopMode)}==='throw'){reason='stop_failed';event('awake-failed');throw Error('PRIVATE_AWAKE_DIAGNOSTIC');}
        terminal=wait().then(()=>{
          if(${JSON.stringify(stopMode)}==='reject'){reason='stop_failed';event('awake-failed');throw Error('PRIVATE_AWAKE_DIAGNOSTIC');}
          active=false;reason='stopped';event('awake-stopped');
        });
        return terminal;
      }};
    }
  `;
  writeFileSync(loader,`
    import {registerHooks} from 'node:module';
    const target=${JSON.stringify(new URL('../lib/v1/keep-awake.mjs',import.meta.url).href)};
    const source=${JSON.stringify(awakeSource)};
    registerHooks({load(url,context,nextLoad){
      if(url===target)return {format:'module',source,shortCircuit:true};
      return nextLoad(url,context);
    }});
  `);
  const names=()=>existsSync(events)?readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).name):[];
  const child=spawn(process.execPath,[EXECUTABLE,'--host-config',configFile],{
    stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH,HOME:home,FARAVAN_COORDINATOR_HOME:home,
      NODE_OPTIONS:'--import='+JSON.stringify(pathToFileURL(loader).href)},
  });
  let stdout='',stderr='',didClose=false;
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const closed=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>{didClose=true;resolve({code,signal});});
  });
  // Observe spawn errors immediately, but never mistake them for joined close.
  void closed.catch(()=>{});
  f.after(async()=>{
    writeFileSync(awakeRelease,'release');
    if(!didClose)child.kill('SIGKILL');
    await shutdownClose(closed,'owned coordinator close unconfirmed; retain '+home);
    assert.equal(process.env.NODE_OPTIONS,parentOptions);
  });
  const running=await shutdownWait(()=>{
    assert.equal(didClose,false,'managed startup failed: '+stderr);
    if(!existsSync(statusFile))return null;
    const status=JSON.parse(readFileSync(statusFile,'utf8'));
    return status.keep_awake?.active===true?status:null;
  },'managed coordinator never reached active startup: '+stderr);
  assert.equal(running.status,'listening');
  assert.equal(running.owner.pid,child.pid);
  assert.equal(running.owner.config,configFile);
  assert.equal(running.owner.version,1);
  assert.equal(running.protocol_version,1);
  assert.ok(running.port>0);
  await shutdownWait(()=>stdout.includes('"listening"'),'startup stdout was not published');
  child.kill(signal);
  await shutdownWait(()=>names().includes('stop-seal'),'shutdown did not seal the helper');
  if(stopMode!=='throw') {
    assert.equal(didClose,false,'the process must wait for helper cleanup');
    child.kill('SIGTERM');child.kill('SIGHUP');
    assert.equal(names().includes('awake-stopped')||names().includes('awake-failed'),false);
  }
  writeFileSync(awakeRelease,'release');
  const result=await shutdownClose(closed,'managed shutdown did not close');
  const failed=stopMode!=='resolve';
  assert.deepEqual(result,{code:failed?1:0,signal:null},stderr);
  const finalText=readFileSync(statusFile,'utf8'),final=JSON.parse(finalText);
  assert.equal(final.status,failed?'stop_failed':'stopped');
  assert.equal(final.reason,failed?'cleanup_failed':undefined);
  assert.equal(final.port,running.port);
  assert.equal(final.collective_name,'Test-only circle');
  assert.deepEqual(final.keep_awake,{enabled:true,active:stopMode!=='resolve',
    reason:stopMode==='resolve'?'stopped':'stop_failed'});
  assert.equal(final.public_url,undefined);
  assert.doesNotMatch(finalText,/PRIVATE_|synthetic-not-a-provider-credential/);
  if(stopMode!=='resolve')assert.match(stderr,/PRIVATE_AWAKE_DIAGNOSTIC/);
  assert.equal(names().filter(n=>n==='stop-seal').length,1);
  assert.ok(names().includes(stopMode==='resolve'?'awake-stopped':'awake-failed'));
  const rebound=createServer();
  try {
    await new Promise((resolve,reject)=>{rebound.once('error',reject);rebound.listen(running.port,'127.0.0.1',resolve);});
  } finally {if(rebound.listening)await new Promise(resolve=>rebound.close(resolve));}
  assert.equal(process.env.NODE_OPTIONS,parentOptions);
});
