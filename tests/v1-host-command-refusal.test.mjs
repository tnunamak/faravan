import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeSync} from 'node:fs';
import {Writable} from 'node:stream';
import {hostCommand,hostRefusalFromLine,startHostFromInstall} from '../lib/v1/host-command.mjs';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const line = fields => JSON.stringify({schema_version: 1, ...fields});

test('hostRefusalFromLine preserves a valid code from a supplied host_error JSON line', () => {
  assert.deepEqual(hostRefusalFromLine(line({type: 'host_error', status: 'failed', code: 'previous_coordinator_other_install', message: 'older copy'})),
    {code: 'previous_coordinator_other_install', message: 'older copy'});
  assert.equal(hostRefusalFromLine(line({type: 'host_error', status: 'failed', message: 'port 8787 is already in use'})), null);
  assert.equal(hostRefusalFromLine(line({type: 'host_error', code: 'Not A Code'})), null);
  assert.equal(hostRefusalFromLine(line({type: 'host_stopped', status: 'stopped'})), null);
  assert.equal(hostRefusalFromLine('{"type":"host_error",'), null);
});

for(const code of ['ENOENT','EACCES'])test('R2 host launch preserves permanent spawn '+code,async t=>{
  const root=await mkdtemp(join(tmpdir(),'host-spawn-code-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(startHostFromInstall({installDir:root,runtime:process.execPath,coordinatorHome:root,timeoutMs:100,
    spawnProcess:()=>{const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('error',Object.assign(Error('cannot spawn'),{code})));return child;},
    sleep:async()=>{}}),{code});
});

const fakeLaunchId = 'synthetic-test-id'.padEnd(43, 'x');

for (const approved of [false, true]) test('host subprocess uses ' + (approved ? 'a private approval input' : 'unchanged default stdio'), async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-approval-input-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const chunks = [];
  let reachedEof = false;
  const result = await startHostFromInstall({installDir:root, runtime:process.execPath, coordinatorHome:root,
    args:['--example'], ...(approved ? {launchId:fakeLaunchId} : {}), timeoutMs:500,
    spawnProcess(runtime, argv, options) {
      assert.equal(runtime, process.execPath);
      assert.deepEqual(argv, [join(root, 'bin', 'faravan'), 'host', '--example', '--json',
        ...(approved ? ['--approved-launch-stdin'] : [])]);
      assert.equal(options.stdio[0], approved ? 'pipe' : 'ignore');
      assert.equal(Object.values(options.env).includes(fakeLaunchId), false);
      const child = new EventEmitter();
      child.unref = () => {};
      writeSync(options.stdio[1], line({type:'host_ready', status:'ready'}) + '\n');
      if (approved) child.stdin = new Writable({
        write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
        final(done) { reachedEof = true; done(); },
      });
      return child;
    },
    sleep:async () => new Promise(resolve => setImmediate(resolve)),
  });
  assert.deepEqual(result, {status:'ready'});
  assert.deepEqual(chunks.map(chunk => chunk.toString()), approved ? [fakeLaunchId] : []);
  assert.equal(reachedEof, approved);
});

test('host command hands the reviewed launch to the subprocess transport', async t => {
  const root=await mkdtemp(join(tmpdir(),'host-command-approval-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const chunks=[];
  const result=await hostCommand({coordinatorHome:root,spawnProcess(_runtime,argv,options){
    assert.deepEqual(argv,[fileURLToPath(new URL('../bin/faravan',import.meta.url)),
      'host','--tunnel','public','--json','--approved-launch-stdin']);
    assert.equal(options.stdio[0],'pipe');
    const child=new EventEmitter();
    child.unref=()=>{};
    child.stdin=new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done();}});
    writeSync(options.stdio[1],line({type:'host_ready',status:'ready'})+'\n');
    return child;
  }},['--tunnel','public'],'host_ready',{launchId:fakeLaunchId});
  assert.deepEqual(result,{status:'ready'});
  assert.deepEqual(chunks,[fakeLaunchId]);
});

test('malformed host launch approval is refused before spawn without echoing it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-approval-invalid-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const malformed = fakeLaunchId + '\n';
  let spawned = false;
  await assert.rejects(startHostFromInstall({installDir:root, runtime:process.execPath, coordinatorHome:root,
    launchId:malformed, spawnProcess:() => { spawned = true; }}),
    error => error.code === 'invalid_launch_id' && !error.message.includes(fakeLaunchId));
  assert.equal(spawned, false);
});

test('approval pipe failure enters owned cleanup without exposing input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-approval-pipe-fail-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const signals = [];
  await assert.rejects(startHostFromInstall({installDir:root, runtime:process.execPath, coordinatorHome:root,
    launchId:fakeLaunchId, timeoutMs:500, stopWaitMs:1,
    spawnProcess() {
      const child = new EventEmitter();
      child.pid = 1; // fixture metadata only; the fake kill method never signals a process
      child.unref = () => {};
      child.kill = signal => { signals.push(signal); child.emit('exit'); };
      child.stdin = new Writable({
        write(_chunk, _encoding, done) { done(Object.assign(new Error(fakeLaunchId), {code:'EPIPE'})); },
      });
      return child;
    },
    sleep:async () => new Promise(resolve => setImmediate(resolve)),
  }), error => error.code === 'launcher_unverified' && error.cause?.code === 'EPIPE' &&
    !error.cause.message.includes(fakeLaunchId));
  assert.deepEqual(signals, ['SIGTERM']);
});
