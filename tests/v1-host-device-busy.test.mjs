import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import {mkdtemp, mkdir, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startHostFromInstall} from '../lib/v1/host-command.mjs';
import {RESUME_LOCK_WAIT_MS} from '../lib/v1/host.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, lock) {
  const dir = await mkdtemp(join(tmpdir(), 'host-busy-'));
  const home = join(dir, 'profile'), coordinatorHome = join(dir, 'coordinator');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {acquireProcessLockSync,profileWriterLockPath} from ${JSON.stringify(new URL('../lib/v1/lock.mjs', import.meta.url).href)};
    import {join} from 'node:path';
    const release=acquireProcessLockSync(${lock === 'profile' ? 'profileWriterLockPath(process.argv[1])' : "join(process.argv[1],'v1','state.lock')"});
    console.log('locked');
    process.stdin.once('data',()=>{release();process.exit(0);});
  `, home], {stdio:['pipe','pipe','pipe']});
  const closed = once(child, 'exit');
  await once(child.stdout, 'data');
  t.after(async () => {
    if (child.exitCode === null) child.stdin.end('release');
    await closed;
    await rm(dir, {recursive:true,force:true});
  });
  return {dir,home,coordinatorHome,release:async()=>{child.stdin.end('release');await closed;}};
}

// Real launcher, real cross-process device locks and real host lifecycle; only the
// coordinator/network are fakes. No installed app or real coordinator is used.
async function fakeInstall(f) {
  const installDir=join(f.dir,'install');
  await mkdir(join(installDir,'bin'),{recursive:true});
  await writeFile(join(installDir,'bin','faravan'), `
    import fs from 'node:fs';
    import {hostV1,hostLaunchWithCleanup} from ${JSON.stringify(new URL('../lib/v1/host.mjs',import.meta.url).href)};
    import {openDevice} from ${JSON.stringify(new URL('../lib/v1/device.mjs',import.meta.url).href)};
    import {FaravanHostError} from ${JSON.stringify(new URL('../lib/host.mjs',import.meta.url).href)};
    const circle={id:'test-circle',origin:'http://10.23.4.10:8787',lanMode:true,pinnedRootFingerprint:'test-root'};
    const launch=hostLaunchWithCleanup(()=>hostV1({home:process.env.FARAVAN_COORDINATOR_HOME,tunnel:'lan'}, {
      networkInterfaces:()=>({lan:[{family:'IPv4',address:'10.23.4.10',internal:false}]}),
      openDevice:async options=>{fs.writeFileSync(${JSON.stringify(join(f.dir,'opening'))},'');await openDevice({...options,home:process.env.FARAVAN_HOME});return {
        createCircle:async()=>circle,publishRoster:async()=>{},createInviteLinks:async()=>({})};},
      portInUse:async()=>false,provision:async()=>{},startServer:async()=>({stop:async()=>{}}),
      waitReady:async()=>({protocol_version:1,status:'listening',public_url:circle.origin})
    }),{acknowledge:()=>fs.writeSync(1,JSON.stringify({type:'host_launch_stopped',token:process.env.FARAVAN_HOST_LAUNCH_TOKEN})+'\\n')});
    try {await launch.result;fs.writeSync(1,JSON.stringify({type:'host_ready',status:'ready'})+'\\n');launch.dispose();}
    catch(error){if(error instanceof FaravanHostError && error.code) fs.writeSync(1,JSON.stringify({type:'host_error',code:error.code,message:error.message})+'\\n');launch.dispose();process.exitCode=1;}
  `);
  return installDir;
}
for (const lock of ['profile','state']) {
  test(`hosting waits past the old timeout for the ${lock} lock`, {timeout:25000}, async t=>{
    const f=await fixture(t,lock), installDir=await fakeInstall(f);
    const launched=startHostFromInstall({installDir,runtime:process.execPath,home:f.home,coordinatorHome:f.coordinatorHome});
    launched.catch(()=>{});
    while (!await access(join(f.dir,'opening')).then(()=>true,()=>false)) await pause(10);
    await pause(4000);
    await f.release();
    const result=await launched;
    assert.equal(result.status,'ready');
  });
}
test('device admission past the bound is a clean refusal through the actual CLI', {timeout:30000}, async t=>{
  const f=await fixture(t,'profile');
  const started=Date.now();
  await assert.rejects(startHostFromInstall({installDir:root,runtime:process.execPath,home:f.home,coordinatorHome:f.coordinatorHome,
    args:['--tunnel','public']}),error=>{
    assert.equal(error.code,'device_busy');
    assert.notEqual(error.cleanup_verified,false);
    assert.equal(error.message,'The device is busy. Start hosting again.');
    return true;
  });
  assert.ok(Date.now()-started>=RESUME_LOCK_WAIT_MS);
  await assert.rejects(access(join(f.coordinatorHome,'host.json')),{code:'ENOENT'});
});
