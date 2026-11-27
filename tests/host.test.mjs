import './helpers/no-browser.mjs';
import {channelDataHome} from '../lib/channel-identity.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os, {tmpdir} from 'node:os';
import {join} from 'node:path';
import {coordinatorHome, hostPaths, resolveLanUrl} from '../lib/host.mjs';
import {routeSelector} from '../lib/hosting-cli.mjs';

test('coordinator home uses the product data folder and explicit overrides', t => {
  const home = os.homedir();
  const names = ['FARAVAN_HOME','FARAVAN_COORDINATOR_HOME','FARAVAN_DATA_HOME'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  assert.equal(coordinatorHome(), join(channelDataHome({home}), 'coordinator'));
  process.env.FARAVAN_HOME = join(home, 'fixture-app');
  assert.equal(coordinatorHome(), join(home, 'fixture-app', 'coordinator'));
  process.env.FARAVAN_COORDINATOR_HOME = join(home, 'fixture-host');
  assert.equal(coordinatorHome(), join(home, 'fixture-host'));
});

test('host reachability selects an audience or opaque offer and binds LAN to a private IPv4 address', () => {
  assert.deepEqual(routeSelector('public'),{reach:'internet'});
  assert.deepEqual(routeSelector('private'),{reach:'tailnet'});
  assert.deepEqual(routeSelector('offer:never-seen-before'),{reach:'internet',providerId:'never-seen-before'});
  assert.throws(()=>routeSelector('http://public.example'),/Choose public, private/);
  assert.equal(resolveLanUrl({port:8787,networkInterfaces:{eth0:[{family:'IPv4',internal:false,address:'10.23.4.10'}]}}),
    'http://10.23.4.10:8787');
});

test('v1 host creates locally, provisions, starts and publishes through injected seams; rerun keeps identity', async () => {
  const {hostV1} = await import('../lib/v1/host.mjs');
  const {openDevice} = await import('../lib/v1/device.mjs');
  const home = await mkdtemp(join(tmpdir(), 'faravan-v1-host-'));
  const ownerHome = await mkdtemp(join(tmpdir(), 'faravan-v1-owner-'));
  const events = [];
  let device, inviteNumber = 0, starts = 0, occupied = false, provisioned;
  const seams = {
    portInUse:async () => occupied,
    freePort:async () => { throw new Error('unexpected port change'); },
    processExists:() => true,
    networkInterfaces:() => ({vpn:[{family:'IPv4', internal:false, address:'203.0.113.4'}],
      lan:[{family:'IPv4', internal:false, address:'10.23.4.10'}]}),
    openDevice:async options => {
      device = await openDevice({...options, home:ownerHome, fetch:async () => { throw new Error('unexpected network'); }});
      return {...device,
        publishRoster:async id => { events.push('publish'); assert.equal(device.selectCircle(id).id, id); },
        createInviteLinks:async () => { events.push('invite'); const short = 'stub-invite-' + (++inviteNumber); return {short, long:short + '-long', note:null}; },
      };
    },
    provision:async ({circle}) => {
      events.push('provision');
      provisioned = JSON.parse(await readFile(circle.provisioningPath, 'utf8'));
      assert.equal(provisioned.lan_mode, true);
      assert.equal(provisioned.roster.payload.lan_mode, true);
      assert.equal(provisioned.roster.payload.coordinator, 'http://10.23.4.10:8787');
    },
    startServer:async config => {
      starts++; events.push('start');
      await writeFile(config.status_path, JSON.stringify({status:'listening', protocol_version:1,
        pid:123, port:config.port, public_url:config.v1_origin}));
      return {stop:async () => events.push('stop')};
    },
    waitReady:async config => { events.push('ready'); return JSON.parse(await readFile(config.status_path, 'utf8')); },
  };
  try {
    const first = await hostV1({home, name:'Friends', tunnel:'lan'}, seams);
    assert.equal(first.origin, 'http://10.23.4.10:8787');
    assert.equal(first.circle.lanMode, true);
    assert.deepEqual(events, ['provision','start','ready','publish','invite']);
    assert.equal(first.invite, 'stub-invite-1', 'host prints the short link when there is one');
    assert.equal(first.inviteNote, null);
    const key = await readFile(join(ownerHome, 'v1', 'roots', first.circle.id + '.pem'), 'utf8');
    occupied = true; events.length = 0;
    const second = await hostV1({home}, seams);
    assert.equal(second.circle.id, first.circle.id);
    assert.equal(second.circle.pinnedRootFingerprint, first.circle.pinnedRootFingerprint);
    assert.equal(await readFile(join(ownerHome, 'v1', 'roots', first.circle.id + '.pem'), 'utf8'), key);
    assert.notEqual(second.invite, first.invite);
    assert.equal(starts, 1);
    assert.deepEqual(events, ['provision','publish','invite']);
    const config = JSON.parse(await readFile(join(home, 'host.json'), 'utf8'));
    assert.equal(config.protocol_version, 1);
    assert.equal(config.host_wanted, true, 'a ready host records that the owner wants it hosted');
    assert.equal(config.collective_token_path, undefined);
    assert.equal(config.roster_path, undefined);
    await assert.rejects(hostV1({home, tunnel:'public'}, seams), /signed circle hosting method cannot change/);
  } finally {
    await rm(home, {recursive:true, force:true});
    await rm(ownerHome, {recursive:true, force:true});
  }
});

test('v1 host rejects public HTTP, refuses legacy state and stops a failed local startup', async () => {
  const {hostV1, ensureV1HostState} = await import('../lib/v1/host.mjs');
  assert.throws(() => resolveLanUrl({port:8787, networkInterfaces:{
    public:[{family:'IPv4', internal:false, address:'203.0.113.4'}],
  }}), /could not find/);
  const home = await mkdtemp(join(tmpdir(), 'faravan-v1-host-failure-'));
  let stopped = false;
  try {
    const seams = {portInUse:async () => false, networkInterfaces:()=>({test:[{family:'IPv4',internal:false,address:'10.23.4.10'}]}),
      openDevice:async () => ({createCircle:async origin => ({id:'circle', origin, pinnedRootFingerprint:'root'})}),
      provision:async () => {}, startServer:async () => ({stop:async () => { stopped = true; }}),
      waitReady:async () => null};
    await assert.rejects(hostV1({home,tunnel:'lan',origin:'http://internet.example'},seams),/requires public reach/);
    await assert.rejects(hostV1({home, tunnel:'lan'}, seams), /did not become ready/);
    assert.equal(stopped, true);
    await writeFile(join(home, 'host.json'), JSON.stringify({schema_version:1}));
    assert.throws(() => ensureV1HostState({home}), /already hosts v0/);
  } finally { await rm(home, {recursive:true, force:true}); }
});

test('local v1 host reopens an existing store after epoch-one provisioning expires without resetting it', async () => {
  const {provisionLocalCircle} = await import('../lib/v1/host.mjs');
  const {openDevice} = await import('../lib/v1/device.mjs');
  const {provisionV1Store, openV1Store} = await import('../lib/v1/store.mjs');
  const home = await mkdtemp(join(tmpdir(), 'faravan-v1-host-expired-'));
  const ownerHome = await mkdtemp(join(tmpdir(), 'faravan-v1-owner-expired-'));
  const then = Math.floor(Date.now() / 1000) - 8 * 86400;
  try {
    const device = await openDevice({home:ownerHome, origin:null, ensureDefault:false, clock:() => then,
      fetch:async () => { throw new Error('unexpected network'); }});
    const circle = await device.createCircle('https://queue.example', {name:'Friends', publish:false});
    const provisioning = JSON.parse(await readFile(circle.provisioningPath, 'utf8'));
    const dbPath = join(home, 'v1', 'coordinator.sqlite');
    provisionV1Store({path:dbPath, provisioning, clock:() => then});
    const config = await provisionLocalCircle({home, circle});
    assert.equal(config.circle, circle.id);
    assert.equal(config.rootFingerprint, circle.pinnedRootFingerprint);
    assert.equal(config.epoch, 1);
    const reopened = openV1Store({path:dbPath});
    try { assert.equal(reopened.configuration().epoch, 1); } finally { reopened.close(); }
    await assert.rejects(provisionLocalCircle({home, circle:{...circle, origin:'https://changed.example'}}));
    // Fresh provisioning still enforces freshness; rerun does not weaken it.
    assert.throws(() => provisionV1Store({path:join(home, 'new', 'coordinator.sqlite'), provisioning}));
  } finally {
    await rm(home, {recursive:true, force:true});
    await rm(ownerHome, {recursive:true, force:true});
  }
});

test('an occupied explicitly requested port cannot reserve an exposure or sign a circle', async () => {
  const {hostV1}=await import('../lib/v1/host.mjs');
  const home=await mkdtemp(join(tmpdir(),'faravan-v1-host-race-'));
  try {
    await assert.rejects(hostV1({home,tunnel:'public',port:9001},{
      portInUse:async()=>true, freePort:()=>assert.fail('an explicit target must not move'),
      openDevice:async()=>({createCircle:()=>assert.fail('must refuse before signing')}),
      startServer:()=>assert.fail('must refuse before any launch'),
    }),/port 9001 is already in use/);
  } finally {await rm(home,{recursive:true,force:true});}
});
