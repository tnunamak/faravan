import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {migratePreviewProfile} from '../lib/preview-migration.mjs';
import {startApp} from '../lib/v1/app.mjs';
import {createJobMetaStore, createBorrowerOutcomeStore} from '../lib/v1/job-meta.mjs';
import {openDevice} from '../lib/v1/device.mjs';
import {ensureV1HostState} from '../lib/v1/host.mjs';
import {profileWriterLockPath} from '../lib/v1/lock.mjs';
import {saveJsonFile} from '../lib/local-state.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(tmpdir(),'review-pr62-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'), destination=path.join(root,'data','preview');
  fs.mkdirSync(path.join(source,'v1'),{recursive:true});
  fs.mkdirSync(path.dirname(destination));
  fs.writeFileSync(path.join(source,'v1/state.json'),JSON.stringify({version:1,circles:[]}));
  fs.writeFileSync(path.join(source,'v1/device.pem'),generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
  return {root,source,destination,base:root};
}

test('N1: a committed migration reuses the real running app',async t=>{
  const f=fixture(t);
  assert.equal(migratePreviewProfile(f).mode,'copy');
  const app=await startApp({home:f.destination,port:0,freshLending:'off'});
  try {
    assert.equal(migratePreviewProfile(f).status, 'committed');
  } finally {await app.close();}
  assert.equal(migratePreviewProfile(f).status,'committed');
});

test('N2: late CLI metadata observation is excluded during publication',async t=>{
  const f=fixture(t), digest='sha256:'+'1'.repeat(64), directory=path.join(f.source,'v1');
  const store=createJobMetaStore(directory);
  await store.record(digest,{prompt:'original',circle:'circle',submittedAt:'2026-10-28'});
  const view={current_attempt:{attempt_id:'new-run',generation:1,state:'completed'}};
  const writer=`
    import {createJobMetaStore} from ${JSON.stringify(new URL('../lib/v1/job-meta.mjs',import.meta.url).href)};
    try { await createJobMetaStore(${JSON.stringify(directory)}).observe(${JSON.stringify(digest)},${JSON.stringify(view)}); }
    catch (error) { if (error.code === 'lock_busy') process.exit(42); throw error; }
  `;
  const open=fs.openSync;
  let status;
  t.mock.method(fs,'openSync',function(file,...args){
    if(status===undefined&&String(file).includes('/.faravan-preview-record.')) {
      const child=spawnSync(process.execPath,['--input-type=module','-e',writer],{encoding:'utf8',timeout:10000});
      assert.equal(child.signal,null,child.stderr);status=child.status;
    }
    return open.call(this,file,...args);
  });
  assert.equal(migratePreviewProfile(f).status,'committed');
  assert.equal(status,42, 'the late metadata writer must fail busy');
  assert.equal((await store.get(digest)).runs,undefined);
  assert.equal((await createJobMetaStore(path.join(f.destination,'v1')).get(digest)).runs,undefined);
  assert.equal(migratePreviewProfile(f).status,'committed');

});

test('N4: an unknown owner is preserved and its exact entry is diagnosed',t=>{
  const f=fixture(t), gate=profileWriterLockPath(f.source);
  const unknown=path.join(gate+'.owners-v1','unknown-owner');
  fs.mkdirSync(path.dirname(unknown), {recursive:true});
  fs.writeFileSync(unknown,'unknown');
  assert.throws(()=>migratePreviewProfile(f),error=>error.code==='lock_busy' && error.message.includes(unknown));
  assert.equal(fs.readFileSync(unknown,'utf8'),'unknown');
  assert.equal(fs.existsSync(f.destination),false);
});

test('N4: first migration ships the stop-all-versions and backup instructions',t=>{
  const f=fixture(t);
  const child=spawnSync(process.execPath,[new URL('../lib/preview-migration.mjs',import.meta.url).pathname,f.source,f.destination,f.base],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
  assert.match(child.stderr,/stop all versions/i);
  assert.match(child.stderr,/back up both profiles/i);
  assert.ok(child.stderr.includes(f.source) && child.stderr.includes(f.destination));
});

test('N4: an unknown per-file lock entry is named and retained', t => {
  const f = fixture(t), unknown = path.join(f.source, 'v1/job-meta.lock.owners-v1/unknown-owner');
  fs.mkdirSync(path.dirname(unknown));
  fs.writeFileSync(unknown, 'unknown');
  assert.throws(() => migratePreviewProfile(f), error => error.message.includes(unknown));
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'unknown');
});

test('N3: saves under an established execute-only ancestor succeed',t=>{
  const f=fixture(t), privateParent=path.join(f.root,'traverse-only'), child=path.join(privateParent,'writable');
  fs.mkdirSync(child,{recursive:true});
  fs.chmodSync(privateParent,0o111);
  try {
    fs.writeFileSync(path.join(child,'control.json'),'{}');
    saveJsonFile(path.join(child,'saved.json'),{saved:true},{base:child});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(child,'saved.json'),'utf8')),{saved:true});
  } finally {fs.chmodSync(privateParent,0o700);}
});

test('N3: a missing explicit base refuses before creating directories', t => {
  const f = fixture(t), base = path.join(f.root, 'missing');
  assert.throws(() => saveJsonFile(path.join(base, 'nested/state.json'), {}, {base}), {code:'ENOENT'});
  assert.equal(fs.existsSync(base), false);
});

test('N3: a killed mkdir writer retries from its original durable base', t => {
  const f = fixture(t), file = path.join(f.root, 'created/profile/state.json');
  const writer = `
    import fs from 'node:fs';
    import {saveJsonFile} from ${JSON.stringify(new URL('../lib/local-state.mjs', import.meta.url).href)};
    const sync=fs.fsyncSync;
    fs.fsyncSync=fd=>{
      if(fs.readlinkSync('/proc/self/fd/'+fd)===${JSON.stringify(f.root)})process.kill(process.pid,'SIGKILL');
      return sync(fd);
    };
    saveJsonFile(${JSON.stringify(file)}, {saved:true}, {base:${JSON.stringify(f.root)}});
  `;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {encoding:'utf8', timeout:10000});
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'created')), true);
  assert.equal(fs.existsSync(file), false);
  const sync = fs.fsyncSync, events = [];
  t.mock.method(fs, 'fsyncSync', fd => { events.push(fs.readlinkSync('/proc/self/fd/'+fd)); return sync(fd); });
  saveJsonFile(file, {saved:true}, {base:f.root});
  assert.deepEqual(events.slice(0, 2), [f.root, path.join(f.root, 'created')]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {saved:true});
});

test('N3: fresh app admission durably establishes its home before JSON saves', async t => {
  const f = fixture(t), home = path.join(f.root, 'fresh-app'), events = [], sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => { events.push(fs.readlinkSync('/proc/self/fd/'+fd)); return sync(fd); });
  const app = await startApp({home, base:f.root, port:0, freshLending:'off'});
  try { assert.ok(events.includes(f.root), 'app admission must sync the new home binding'); }
  finally { await app.close(); }
});

test('N3: fresh host state durably establishes its home before JSON saves', t => {
  const f = fixture(t), home = path.join(f.root, 'fresh-host'), events = [], sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => { events.push(fs.readlinkSync('/proc/self/fd/'+fd)); return sync(fd); });
  ensureV1HostState({home, base:f.root});
  assert.ok(events.includes(f.root), 'host initialization must sync the new home binding');
});

for (const operation of ['record', 'setTitle', 'setApplied', 'clearApplied', 'outcome-set', 'outcome-delete']) {
test(`N2: migration excludes the ${operation} metadata writer`, async t => {
  const f = fixture(t), directory = path.join(f.source, 'v1'), digest = 'sha256:' + '2'.repeat(64);
  const meta = createJobMetaStore(directory), outcomes = createBorrowerOutcomeStore(directory);
  await meta.record(digest, {prompt:'original', circle:'circle'});
  await meta.setApplied(digest, {commit:'original'});
  await outcomes.set('circle', digest, {verdict:'unused'});
  const calls = {
    record:`meta.record('sha256:' + '3'.repeat(64), {prompt:'new'})`,
    setTitle:`meta.setTitle(digest, 'new')`,
    setApplied:`meta.setApplied(digest, {commit:'new'})`,
    clearApplied:`meta.clearApplied(digest, 'original')`,
    'outcome-set':`outcomes.set('circle', digest, {verdict:'used'})`,
    'outcome-delete':`outcomes.set('circle', digest, null)`,
  };
  const writer = `
    import {createJobMetaStore,createBorrowerOutcomeStore} from ${JSON.stringify(new URL('../lib/v1/job-meta.mjs', import.meta.url).href)};
    const meta=createJobMetaStore(${JSON.stringify(directory)}),outcomes=createBorrowerOutcomeStore(${JSON.stringify(directory)}),digest=${JSON.stringify(digest)};
    try { await ${calls[operation]}; }
    catch(error) { if(error.code==='lock_busy')process.exit(42); throw error; }
  `;
  const before = ['job-meta.json', 'borrower-outcomes.json'].map(name => fs.readFileSync(path.join(directory, name), 'utf8'));
  const open = fs.openSync;
  let result;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (!result && String(file).includes('/.faravan-preview-record.')) {
      result = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {encoding:'utf8', timeout:10000});
    }
    return open(file, ...args);
  });
  migratePreviewProfile(f);
  assert.equal(result?.status, 42, result?.stderr);
  assert.deepEqual(['job-meta.json', 'borrower-outcomes.json'].map(name => fs.readFileSync(path.join(directory, name), 'utf8')), before);
});
}

test('N2: device operations can nest metadata writers under the same gate', async t => {
  const f = fixture(t), device = await openDevice({home:f.source, origin:null});
  const circle = (await device.listCircles())[0];
  const directory = path.join(f.source, 'v1'), digest = 'sha256:' + '4'.repeat(64);
  await device.withOperationLock(circle.id, async () => {
    await createJobMetaStore(directory).record(digest, {prompt:'nested'});
    await createBorrowerOutcomeStore(directory).set(circle.id, digest, {verdict:'used'});
  });
  assert.equal((await createJobMetaStore(directory).get(digest)).title, 'nested');
});
