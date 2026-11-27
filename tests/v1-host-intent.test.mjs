import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {resumeWantedHost,retryableHostStart} from '../lib/v1/host-intent.mjs';
import {hostStatusVM} from '../ui/v1/src/view-models.mjs';
import {stopV1Host} from '../lib/v1/host.mjs';
import {startApp} from '../lib/v1/app.mjs';
import {syntheticBackend} from './helpers/v1-app-fixture.mjs';

// Bug: a host the app started did not come back after the app restarted or the computer rebooted.
async function appHome(t, config) {
  const root = await mkdtemp(join(tmpdir(), 'spk-host-intent-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'Faravan Preview'), coordinator = join(home, 'coordinator');
  await mkdir(coordinator, {recursive: true});
  if (config) await writeFile(join(coordinator, 'host.json'), JSON.stringify({schema_version: 1, protocol_version: 1, port: 8787,
    status_path: join(coordinator, 'status.json'), circle_id: 'c1', reachability: {kind: 'url', publicUrl: 'https://circle.example'}, ...config}));
  return {root, home, coordinator};
}

test('a wanted host that is not running is started; a running, unknown or unwanted one is not', async t => {
  const {coordinator} = await appHome(t, {host_wanted: true});
  let starts = 0;
  const start = async () => { starts++; };
  assert.deepEqual(await resumeWantedHost({coordinatorHome: coordinator, start, processExists: () => false}), {resumed: true, reason: 'started'});
  assert.deepEqual(await resumeWantedHost({coordinatorHome: coordinator, start, processExists: () => true}), {resumed: false, reason: 'running'});
  assert.deepEqual(await resumeWantedHost({coordinatorHome: coordinator, start, processExists: () => { throw new Error('cannot verify'); }}), {resumed: false, reason: 'unknown'});
  assert.equal(starts, 1);
  const unwanted = await appHome(t, {host_wanted: false});
  assert.equal((await resumeWantedHost({coordinatorHome: unwanted.coordinator, start, processExists: () => false})).reason, 'not_wanted');
  const legacy = await appHome(t, {});
  assert.equal((await resumeWantedHost({coordinatorHome: legacy.coordinator, start, processExists: () => false})).reason, 'not_wanted');
  const none = await appHome(t, null);
  assert.equal((await resumeWantedHost({coordinatorHome: none.coordinator, start, processExists: () => false})).reason, 'not_configured');
  assert.equal(starts, 1);
});

test('the owner\'s stop clears the intent, so the host does not come back', async t => {
  const {coordinator} = await appHome(t, {host_wanted: true});
  await stopV1Host({home: coordinator}, {clearIntent: true, sleep: async () => {}, portAnswers: async () => false});
  assert.equal(JSON.parse(await readFile(join(coordinator, 'host.json'), 'utf8')).host_wanted, false);
  let starts = 0;
  assert.equal((await resumeWantedHost({coordinatorHome: coordinator, start: async () => { starts++; }, processExists: () => false})).resumed, false);
  assert.equal(starts, 0);
});

const envNames = ['FARAVAN_COORDINATOR_HOME', 'FARAVAN_COORDINATOR_HOME'];
function clearCoordinatorEnv(t) {
  const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  t.after(() => { for (const name of envNames) if (saved[name] !== undefined) process.env[name] = saved[name]; });
}
async function bootApp(t, f) {
  const calls = [];
  let called;
  const once = new Promise(resolve => { called = resolve; });
  const app = await startApp({home: f.home, origin: null, port: 0, freshLending: 'off', adapters: [], updater: null, env: {},
    backendFactory: () => syntheticBackend(f.root), fetch: async () => { throw new Error('offline'); },
    startHost: async (ctx, args, type) => { calls.push({ctx, args, type}); called(); return {status: 'ready', circle_id: 'c1'}; }});
  return {app, calls, once};
}

test('app start brings a wanted host back from the app\'s own coordinator home', {timeout: 60000}, async t => {
  clearCoordinatorEnv(t);
  const f = await appHome(t, {host_wanted: true});
  const {app, calls, once} = await bootApp(t, f);
  try {
    await Promise.race([once, new Promise((_, reject) => setTimeout(() => reject(new Error('host was not started')), 20000).unref())]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.coordinatorHome, f.coordinator);
    assert.equal(calls[0].ctx.home, f.home);
    assert.deepEqual(calls[0].args, ['--resume', 'initial'], 'an automatic restart, not an owner\'s start');
    assert.equal(calls[0].type, 'host_ready');
  } finally { await app.close(); }
});

// A reboot leaves the host's last status file behind, still saying it listens, and its PID can now belong to another
// program. The recorded boot differs from this boot, so the old record cannot own a live process.
test('after a reboot the app brings the wanted host back, even when its old PID now belongs to another program', {timeout: 60000, skip: process.platform !== 'linux' && 'boot identity is read from /proc'}, async t => {
  clearCoordinatorEnv(t);
  const f = await appHome(t, {host_wanted: true});
  const config = join(f.coordinator, 'host.json');
  await writeFile(join(f.coordinator, 'status.json'), JSON.stringify({protocol_version: 1, status: 'public_listening', pid: process.pid, port: 8787,
    owner: {version: 1, platform: process.platform, host: hostname(), pid: process.pid, boot: 'boot-before-the-restart', namespace: null, start: '1', config}}));
  const {app, calls, once} = await bootApp(t, f);
  try {
    await Promise.race([once, new Promise((_, reject) => setTimeout(() => reject(new Error('host was not started after the reboot')), 20000).unref())]);
    assert.deepEqual(calls.map(call => call.args), [['--resume', 'initial']]);
  } finally { await app.close(); }
});

test('app start does not bring back a host the owner stopped', {timeout: 60000}, async t => {
  clearCoordinatorEnv(t);
  const f = await appHome(t, {host_wanted: false});
  const {app, calls} = await bootApp(t, f);
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});


test('J4-2 app retries a transient automatic host failure while hosting is wanted', {timeout:60000}, async t=>{
  clearCoordinatorEnv(t);const f=await appHome(t,{host_wanted:true});let starts=0;
  const app=await startApp({home:f.home,origin:null,port:0,freshLending:'off',adapters:[],updater:null,env:{},blockerRecheckMs:10,
    backendFactory:()=>syntheticBackend(f.root),fetch:async()=>{throw Error('offline');},
    startHost:async()=>{if(++starts===1)throw Object.assign(Error('network unavailable'),{code:'EIO'});return {};}});
  try {for(let i=0;i<100&&starts<2;i++)await new Promise(r=>setTimeout(r,10));assert.ok(starts>=2,'automatic hosting must retry');}
  finally {await app.close();}
});

for(const permanent of [true,false])test('R2 hosting '+(permanent?'stops on permanent failure':'has a total retry bound')+' and preserves wanted blocker',{timeout:60000},async t=>{
  clearCoordinatorEnv(t);const f=await appHome(t,{host_wanted:true});let starts=0,clock=0;
  const app=await startApp({home:f.home,origin:null,port:0,freshLending:'off',adapters:[],updater:null,env:{},blockerRecheckMs:1,monotonic:()=>clock,
    backendFactory:()=>syntheticBackend(f.root),fetch:async()=>{throw Error('offline');},
    startHost:async()=>{starts++;throw Object.assign(Error('cannot start hosting'),{code:permanent?'EACCES':'EIO'});}});
  try {
    for(let i=0;i<100;i++){clock+=1000000;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(starts,permanent?1:7);
    const response=await fetch(app.origin+'/api/hosting',{headers:{'x-faravan-session-token':app.token,'faravan-surface':'ui'}});
    assert.equal(response.status,200);const state=await response.json();assert.equal(state.wanted,true);assert.equal(state.resumeBlocker.code,permanent?'hosting_resume_failed':'hosting_resume_limit');
    assert.equal(hostStatusVM({...state,circle:'friends'}).banner.text,state.resumeBlocker.message);
    assert.equal(JSON.parse(await readFile(join(f.coordinator,'host.json'),'utf8')).host_wanted,true);
  } finally {await app.close();}
});

test('R2 host retry classification preserves stale ownership and unsafe cleanup refusals',()=>{
  for(const error of [{code:'lock_busy',reason:'lock_stale'},{code:'EIO',cleanup_verified:false},{code:'EACCES'},{code:'ENOENT'},{code:'previous_coordinator_other_install'},{code:'host_home_conflict'},Error('unknown')])
    assert.equal(retryableHostStart(error),false);
  for(const code of ['lock_busy','EIO','EAGAIN','device_busy','timeout','host_failed'])assert.equal(retryableHostStart({code}),true);
});
