import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureV1HostState, hostV1, stopV1Host } from '../lib/v1/host.mjs';
import {captureCoordinatorOwner} from '../lib/v1/coordinator-owner.mjs';
import {portAnswers} from '../lib/v1/port-listeners.mjs';

// A coordinator home whose status file names a process, so there is something to signal. Nothing here is real.
async function coordinatorHome(t, platform='linux') {
  const home = await mkdtemp(join(tmpdir(), 'spk-host-stop-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const status = join(home, 'status.json');
  await writeFile(status, JSON.stringify({protocol_version: 1, pid: 424242}));
  await writeFile(join(home, 'host.json'), JSON.stringify({protocol_version: 1, status_path: status}));
  const identityOptions={platform,readlink:file=>file.endsWith('/exe')?process.execPath:'pid:[test]',readFile:file=>file.endsWith('/cmdline')?
    ['node',new URL('../bin/faravan-coordinator',import.meta.url).pathname,'--host-config',join(home,'host.json')].join('\0')+'\0':
    file.endsWith('/boot_id')?'test-boot':'424242 (node) '+['S',...Array(18).fill('0'),'42'].join(' '),execFile:()=>JSON.stringify({Boot:'638970000000000000',CreationDate:'638972640000000001',ExecutablePath:process.execPath,
      CommandLine:'"'+process.execPath+'" "'+new URL('../bin/faravan-coordinator',import.meta.url).pathname+'" --host-config "'+join(home,'host.json')+'"'})};
  const owner=captureCoordinatorOwner(424242,join(home,'host.json'),identityOptions);
  await writeFile(status,JSON.stringify({protocol_version:1,pid:424242,status:'listening',owner}));
  return {home,identityOptions};
}

test('stopping the coordinator fails when its process is still running after the signal', async t => {
  const {home,identityOptions} = await coordinatorHome(t);
  let signalled = 0;
  await assert.rejects(stopV1Host({home}, {processExists: () => true, identityOptions,
    stopServer: async () => { signalled++; }, sleep: async () => {}}),
    /did not stop after its signal/);
  assert.equal(signalled, 1, 'the coordinator was signalled once');
});

test('a coordinator that exits after its signal counts as stopped', async t => {
  const {home,identityOptions} = await coordinatorHome(t);
  let running = true;
  await stopV1Host({home}, {processExists: () => running, identityOptions,
    stopServer: async () => { running = false; }, sleep: async () => {}});
  assert.equal(running, false);
});

test('an unverified coordinator PID is never signalled by the real stop function', async t => {
  const {home} = await coordinatorHome(t);
  const signals = [];
  await assert.rejects(stopV1Host({home}, {
    platform: 'win32',
    processExists: () => true,
    identityExecFile: () => { throw Error('CIM unavailable'); },
    signal: (...args) => signals.push(args),
    sleep: async () => {},
  }), /cannot verify the previous coordinator process/);
  assert.deepEqual(signals, []);
});

test('explicit stop callback is not called when Windows identity is unknown', async t => {
  const {home} = await coordinatorHome(t);
  let stopped = 0;
  await assert.rejects(stopV1Host({home}, {
    platform: 'win32',
    processExists: () => true,
    identityExecFile: () => { throw Error('CIM unavailable'); },
    stopServer: async () => { stopped++; },
  }), /cannot verify the previous coordinator process/);
  assert.equal(stopped, 0, 'an unverified coordinator is not passed to the stop callback');
});

test('legacy replacement does not call its stop callback when Windows identity is unknown', async t => {
  const home = await mkdtemp(join(tmpdir(), 'spk-host-legacy-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const {paths, config} = ensureV1HostState({home});
  const origin = 'http://127.0.0.1:'+config.port;
  const primary = {id: 'original', name: 'Original', origin, pinnedRootFingerprint: 'root'};
  await writeFile(paths.config, JSON.stringify({...config, circle_id: primary.id,
    circle_name: primary.name, root_fingerprint: 'root', v1_origin: origin,
    reachability: {kind: 'url', publicUrl: origin}}));
  await writeFile(paths.status, JSON.stringify({protocol_version: 1, pid: 424242, port: config.port,
    status: 'listening', public_url: origin}));
  let stopped = 0;
  await assert.rejects(hostV1({home, name: 'Second'}, {
    platform: 'win32',
    portInUse: async () => true,
    processExists: () => true,
    identityExecFile: () => { throw Error('CIM unavailable'); },
    openDevice: async () => ({
      selectCircle: () => primary,
      createCircle: async () => ({id: 'second', name: 'Second', origin, pinnedRootFingerprint: 'root'}),
      publishRoster: async () => {},
      createInviteLinks: async () => ({short: 'invite'}),
    }),
    provision: async () => {},
    stopServer: async () => { stopped++; },
    startServer: async () => assert.fail('unknown identity must not start a replacement'),
    waitReady: async () => assert.fail('unknown identity must not report success'),
  }), /cannot verify the previous coordinator process/);
  assert.equal(stopped, 0, 'an unverified legacy coordinator is not passed to the stop callback');
});

test('an indeterminate pre-signal liveness probe rejects without signalling', async t => {
  const {home,identityOptions} = await coordinatorHome(t,'win32');
  const signals = [];
  await assert.rejects(stopV1Host({home}, {
    platform: 'win32',
    processKill: () => { throw Object.assign(new Error(), {code: 'EPERM'}); },
    identityOptions,
    signal: (...args) => signals.push(args),
  }), /cannot verify the previous coordinator process/);
  assert.deepEqual(signals, []);
});

test('an indeterminate post-signal liveness probe rejects instead of reporting success', async t => {
  const {home,identityOptions} = await coordinatorHome(t,'win32');
  let probes = 0;
  const signals = [];
  await assert.rejects(stopV1Host({home}, {
    platform: 'win32',
    processKill: () => {
      probes++;
      if (probes === 1) return;
      throw Object.assign(new Error(), {code: 'EPERM'});
    },
    identityOptions,
    signal: (...args) => signals.push(args),
    sleep: async () => {},
  }), /could not verify that the coordinator stopped; check the host status and try again/);
  assert.deepEqual(signals, [[424242, 'SIGTERM']]);
  assert.equal(probes, 2, 'one initial liveness probe and one post-signal verification probe');
});

test('host Stop withdraws its listener before reconciling failed exposure cleanup', async t => {
  for (const outcome of ['unconfirmed', 'throws']) await t.test(outcome, async t => {
    const {home,identityOptions} = await coordinatorHome(t);
    const listen = async (host, port) => {
      const server = createServer(socket => socket.destroy());
      await new Promise((resolve,reject) => {
        server.once('error',reject);
        server.listen(port,host,resolve);
      });
      t.after(() => { if (server.listening) server.close(); });
      return server;
    };
    const owned = await listen('127.0.0.1',0);
    const port = owned.address().port;
    const foreign = await listen('::1',port);
    const handle = {id:'saved-route',generation:1};
    const exposurePath = join(home,'exposure.json');
    const savedExposure = {spec:{target:'127.0.0.1:'+port},handle};
    await writeFile(join(home,'host.json'),JSON.stringify({protocol_version:1,status_path:join(home,'status.json'),
      port,v1_origin:'https://host.invalid',reachability:{kind:'gozar'}}));
    await writeFile(exposurePath,JSON.stringify(savedExposure));

    const ownedListener = {pid:424243};
    const foreignListener = {pid:424244};
    const signals = [];
    const route = {handle,cleanup:{state:'unconfirmed'}};
    const remoteError = Object.assign(new Error('controlled provider failure'),{route});
    let closeCalls = 0;
    await assert.rejects(stopV1Host({home},{
      platform:'linux',
      processExists:status=>{ assert.equal(status.pid,424242); return false; },
      identityOptions:{...identityOptions,readFile:file=>file===`/proc/${foreignListener.pid}/cmdline`
        ? 'foreign\0' : identityOptions.readFile(file)},
      portAnswers,
      portListeners:async()=>[...(owned.listening?[ownedListener]:[]),...(foreign.listening?[foreignListener]:[])],
      networkInterfaces:()=>({}),
      signal:(pid,signal)=>{
        signals.push([pid,signal]);
        if(pid===ownedListener.pid) owned.close();
      },
      sleep:async()=>{},
      hostingApi:{closeRoute:async args=>{
        closeCalls++;
        assert.deepEqual(args.handle,handle);
        assert.equal(args.mode,'remove');
        assert.deepEqual(signals,[[ownedListener.pid,'SIGTERM']], 'local withdrawal precedes remote cleanup');
        assert.equal(await portAnswers(port,'127.0.0.1'),false);
        assert.equal(await portAnswers(port,'::1'),true);
        if(outcome==='throws') throw remoteError;
        return route;
      }},
    }), error=>{
      assert.equal(error.code,'host_still_running');
      const [local,remote] = error.errors;
      assert.equal(error.errors.length,2);
      assert.equal(local.code,'host_still_running');
      assert.strictEqual(error.running,local.running);
      assert.deepEqual(local.running,[foreignListener]);
      if(outcome==='throws') assert.strictEqual(remote,remoteError);
      else assert.equal(remote.code,'cleanup_debt');
      assert.strictEqual(error.route,route);
      assert.strictEqual(remote.route,route);
      return true;
    });
    assert.equal(closeCalls,1);
    assert.deepEqual(signals,[[ownedListener.pid,'SIGTERM']]);
    assert.equal(await portAnswers(port,'::1'),true,'foreign listener still accepts connections');
    assert.deepEqual(JSON.parse(await readFile(exposurePath,'utf8')),savedExposure);
  });
});

test('a failed launch reconciles its exact exposure even if local stop rejects', async t => {
  const home = await mkdtemp(join(tmpdir(), 'spk-host-launch-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const launchError = new Error('controlled readiness failure');
  const localError = new Error('controlled process stop refusal');
  const handle = {id:'launch-route', generation:1};
  const closed = [];
  const stateFile = join(home,'exposure.json');
  await assert.rejects(hostV1({home,port:17734,tunnel:'public'},{
    openDevice:async()=>({}),
    portInUse:async()=>false,
    interaction:{choose:async offers=>offers.find(offer=>offer.usage==='attached'),
      driveSetup:async(_controller,operation)=>operation,approve:async()=>true},
    hostingApi:{
      catalogRoutes:async()=>({candidates:[{eligible:true,providerId:'fixture',
        candidateToken:'offer',consentFactsDigest:'facts',disclosure:{revision:1},
        setup:{state:'ready'},consent:{consentFactsDigest:'facts'}}]}),
      closeRoute:async input=>{closed.push(input.handle);return {cleanup:{state:'confirmed'}};},
    },
    startServer:async()=>{
      const state=JSON.parse(await readFile(stateFile,'utf8'));
      await writeFile(stateFile,JSON.stringify({...state,handle}));
      return {stop:async()=>{throw localError;}};
    },
    waitReady:async()=>{throw launchError;},
  }),error=>{
    assert.equal(error,launchError);
    assert.equal(error.cleanupVerified,false);
    assert.equal(error.cleanupError,localError);
    return true;
  });
  assert.deepEqual(closed,[handle]);
  assert.equal(JSON.parse(await readFile(stateFile,'utf8')).handle,undefined);
});

for (const listed of [false,true]) {
  test('a failed durable launch requires a cleanup receipt when its child stops: '+listed, async t => {
    const home=await mkdtemp(join(tmpdir(),'spk-host-durable-launch-'));
    t.after(()=>rm(home,{recursive:true,force:true}));
    const {paths,config}=ensureV1HostState({home,port:17734});
    await writeFile(paths.config,JSON.stringify({...config,host_wanted:true,reachability:{kind:'gozar'}}));
    const file=join(home,'exposure.json');
    const saved={spec:{target:'127.0.0.1:17734',reach:'internet',usage:'durable',providerId:'fixture'},
      routeOperationId:'owned-operation',setupOperationId:'keep-setup'};
    await writeFile(file,JSON.stringify(saved));
    const handle={id:'owned-route',generation:5};
    const failure=new Error('controlled readiness failure');
    const events=[];
    await assert.rejects(hostV1({home,resume:{stopGeneration:null}},{
      openDevice:async()=>({}),portInUse:async()=>false,
      startServer:async()=>({stop:async()=>events.push('local-stop')}),
      waitReady:async()=>{throw failure;},
      hostingApi:{
        listRoutes:async()=>({routes:[{operationId:'someone-else',handle:{id:'foreign',generation:1}},
          ...(listed?[{operationId:saved.routeOperationId,handle}]:[])]}),
        closeRoute:async request=>{
          assert.deepEqual(events,['local-stop']);
          assert.deepEqual(request,{home:join(home,'gz'),handle,mode:'remove'});
          events.push('remote-close');
          return {cleanup:{state:'confirmed'}};
        },
      },
    }),error=>{
      assert.strictEqual(error,failure);
      assert.equal(error.cleanupVerified,listed);
      return true;
    });
    assert.deepEqual(events,listed?['local-stop','remote-close']:['local-stop']);
    const state=JSON.parse(await readFile(file,'utf8'));
    if(listed){
      assert.equal(state.setupOperationId,saved.setupOperationId);
      assert.notEqual(state.routeOperationId,saved.routeOperationId);
    }else assert.deepEqual(state,saved);
  });
}

for (const outcome of ['confirmed', 'unconfirmed', 'throws']) {
  test('internal expectedOwner stop retires exposure but keeps setup intent: '+outcome, async t => {
    const {home,identityOptions}=await coordinatorHome(t);
    const configPath=join(home,'host.json'), exposurePath=join(home,'exposure.json');
    const owner=captureCoordinatorOwner(424242,configPath,identityOptions);
    const config={protocol_version:1,status_path:join(home,'status.json'),
      host_wanted:true,stop_generation:'before-stop',reachability:{kind:'gozar'},v1_origin:'https://owned.invalid'};
    const handle={id:'internal-owned-route',generation:7};
    const saved={spec:{target:'127.0.0.1:17734',reach:'internet',usage:'durable',providerId:'fixture'},
      handle,routeOperationId:'old-operation',setupOperationId:'keep-setup',
      pendingApproval:{digest:'old-facts',binding:'old-binding'}};
    await writeFile(configPath,JSON.stringify(config));
    await writeFile(exposurePath,JSON.stringify(saved));
    let running=true, closes=0;
    const events=[];
    const route={handle,cleanup:{state:outcome==='confirmed'?'confirmed':'unconfirmed'}};
    const remoteError=Object.assign(new Error('synthetic close failure'),{route});
    const stopping=stopV1Host({home,expectedOwner:owner},{
      platform:'linux',identityOptions,processExists:()=>running,
      stopServer:async(_config,status)=>{
        assert.equal(status.pid,424242);
        assert.deepEqual(status.owner,owner);
        events.push('local-stop');running=false;
      },
      signal:()=>assert.fail('no real process signal is permitted'),
      sleep:async()=>{},
      hostingApi:{
        closeRoute:async request=>{
          closes++;
          assert.deepEqual(events,['local-stop']);
          assert.equal(running,false);
          assert.deepEqual(request,{home:join(home,'gz'),handle,mode:'remove'});
          if(outcome==='throws')throw remoteError;
          return route;
        },
        cancelSetupOperation:async()=>assert.fail('internal stop must retain setup intent'),
      },
    });
    if(outcome==='confirmed')await stopping;
    else await assert.rejects(stopping,error=>{
      if(outcome==='throws')assert.strictEqual(error,remoteError);
      else assert.equal(error.code,'cleanup_debt');
      assert.strictEqual(error.route,route);
      return true;
    });
    assert.equal(closes,1);
    assert.equal(running,false);
    const after=JSON.parse(await readFile(exposurePath,'utf8'));
    const host=JSON.parse(await readFile(configPath,'utf8'));
    assert.equal(host.host_wanted,true,'no clearIntent was requested');
    assert.notEqual(host.stop_generation,config.stop_generation);
    assert.equal(after.setupOperationId,saved.setupOperationId);
    assert.equal(after.spec.usage,'durable');
    if(outcome==='confirmed'){
      assert.equal(after.handle,undefined);
      assert.equal(after.pendingApproval,undefined);
      assert.notEqual(after.routeOperationId,saved.routeOperationId);
    }else assert.deepEqual(after,saved,'unconfirmed removal retains exact ownership and intent');
  });
}

for (const changed of ['recorded-owner', 'observed-owner']) {
  test('expectedOwner refuses '+changed+' before local or exposure mutation', async t=>{
    const {home,identityOptions}=await coordinatorHome(t);
    const configPath=join(home,'host.json'),statusPath=join(home,'status.json'),exposurePath=join(home,'exposure.json');
    const owner=captureCoordinatorOwner(424242,configPath,identityOptions);
    const saved={spec:{target:'127.0.0.1:17734',usage:'durable'},
      handle:{id:'must-survive',generation:1},routeOperationId:'unchanged'};
    await writeFile(exposurePath,JSON.stringify(saved));
    if(changed==='recorded-owner'){
      const status=JSON.parse(await readFile(statusPath,'utf8'));
      await writeFile(statusPath,JSON.stringify({...status,owner:{...owner,start:'43'}}));
    }
    const beforeConfig=await readFile(configPath,'utf8');
    const observed=changed==='observed-owner'
      ? {...identityOptions,readFile:file=>file.endsWith('/stat')
          ? '424242 (node) '+['S',...Array(18).fill('0'),'43'].join(' ')
          : identityOptions.readFile(file)}
      : identityOptions;
    await assert.rejects(stopV1Host({home,expectedOwner:owner},{
      platform:'linux',identityOptions:observed,processExists:()=>true,
      stopServer:async()=>assert.fail('identity fence must precede stop'),
      signal:()=>assert.fail('identity fence must precede signal'),
      hostingApi:{closeRoute:async()=>assert.fail('identity fence must precede close')},
    }),/changed after it was recorded|cannot verify the previous coordinator process/);
    assert.equal(await readFile(configPath,'utf8'),beforeConfig);
    assert.deepEqual(JSON.parse(await readFile(exposurePath,'utf8')),saved);
  });
}

for (const outcome of ['confirmed', 'unconfirmed', 'unavailable']) {
  test('failed owned launch reports exact durable retirement: '+outcome, async t => {
    const home=await mkdtemp(join(tmpdir(),'spk-host-durable-launch-'));
    t.after(()=>rm(home,{recursive:true,force:true}));
    const port=17734, origin='https://fixture.invalid', stopGeneration='saved-run';
    const {config,paths}=ensureV1HostState({home,port});
    await writeFile(paths.config,JSON.stringify({...config,host_wanted:true,stop_generation:stopGeneration,
      reachability:{kind:'gozar'},v1_origin:origin}));
    const statePath=join(home,'exposure.json'),handle={id:'prior-owned-durable-route',generation:4};
    const saved={spec:{providerId:'fixture',reach:'internet',address:'stable',target:'127.0.0.1:'+port,usage:'durable',origin},
      routeOperationId:'existing-operation',setupOperationId:'existing-setup',handle};
    await writeFile(statePath,JSON.stringify(saved));
    const events=[],launchError=new Error('synthetic readiness refusal');
    const unavailable=new Error('synthetic cleanup reply unavailable');
    const receipt={handle,cleanup:{state:outcome==='confirmed'?'confirmed':'unconfirmed'}};
    await assert.rejects(hostV1({home,port,resume:{stopGeneration}},{
      openDevice:async()=>({}),portInUse:async()=>false,
      startServer:async()=>{
        events.push('start');
        assert.deepEqual(JSON.parse(await readFile(statePath,'utf8')),saved);
        return {stop:async()=>{events.push('owned-child-stopped');}};
      },
      waitReady:async()=>{events.push('readiness-failed');throw launchError;},
      hostingApi:{
        closeRoute:async request=>{
          assert.deepEqual(request,{home:join(home,'gz'),handle,mode:'remove'});
          assert.deepEqual(events,['start','readiness-failed','owned-child-stopped']);
          events.push('exact-route-close');
          if(outcome==='unavailable')throw unavailable;
          return receipt;
        },
        cancelSetupOperation:async()=>assert.fail('launch rollback retains existing setup'),
      },
    }),error=>{
      assert.strictEqual(error,launchError);
      assert.equal(error.cleanupVerified,outcome==='confirmed');
      if(outcome==='unconfirmed'){
        assert.equal(error.exposureCleanupError?.code,'cleanup_debt');
        assert.strictEqual(error.exposureCleanupError.route,receipt);
      }
      if(outcome==='unavailable')assert.strictEqual(error.exposureCleanupError,unavailable);
      return true;
    });
    assert.deepEqual(events,['start','readiness-failed','owned-child-stopped','exact-route-close']);
    const after=JSON.parse(await readFile(statePath,'utf8'));
    if(outcome==='confirmed'){
      assert.equal(after.handle,undefined);
      assert.notEqual(after.routeOperationId,saved.routeOperationId);
      assert.deepEqual(after.spec,saved.spec);
      assert.equal(after.setupOperationId,saved.setupOperationId);
    }else assert.deepEqual(after,saved);
  });
}
