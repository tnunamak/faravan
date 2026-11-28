import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {selectSbxHome} from '../lib/sbx-home.mjs';
import {publishClaudeAccount, readClaudeAccount, createProviderSource, publishProviderGeneration, readCurrentProviderValue, createGitHubSource, publishGitHubGeneration, currentGitHubGeneration} from '../lib/credential-generations.mjs';
import {createUsageAccountStore} from '../lib/v1/usage-account-store.mjs';
import {migrateProductHome, productMigrationNotice, acknowledgeProductMigration} from '../lib/product-home-move.mjs';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faravan-data-move-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const destination = path.join(home, '.local/share/Faravan');
  const options = {home, platform:'linux', env:{}, sandboxUserHome:home};
  const profile = relative => {
    const source = path.join(home, relative);
    fs.mkdirSync(path.join(source, 'v1'), {recursive:true});
    for (const [name, value] of Object.entries({'device.pem':'test-only-key', 'accounts.json':'{"accounts":["one","two"]}', 'app-settings.json':'{"lending":true}'})) fs.writeFileSync(path.join(source, 'v1', name), value, {mode:0o600});
    return source;
  };
  return {home, destination, options, profile};
}
for (const previous of ['.local/share/Faravan Preview 20261026', '.spare' + 'kin-friend-preview']) {
  test(`keeps device key, account list and app settings (${previous}) and moves only once`, t => {
    const {destination, options, profile} = fixture(t);
    const source = profile(previous);
    const before = fs.readdirSync(path.join(source, 'v1')).map(name => [name, fs.readFileSync(path.join(source, 'v1', name)), fs.statSync(path.join(source, 'v1', name)).mode]);
    assert.equal(migrateProductHome(destination, options), destination);
    assert.equal(fs.existsSync(source), false);
    for (const [name, bytes, mode] of before) {
      assert.deepEqual(fs.readFileSync(path.join(destination, 'v1', name)), bytes);
      assert.equal(fs.statSync(path.join(destination, 'v1', name)).mode, mode);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, '.faravan-data-moved'))).destination, destination);
    assert.equal(migrateProductHome(destination, options), null);
  });
}
test('does not merge into an existing home or choose between multiple old profiles', t => {
  const {home, destination, options, profile} = fixture(t);
  const first = profile('.local/share/Faravan Preview 20261026');
  const second = profile('.spare' + 'kin');
  assert.throws(() => migrateProductHome(destination, options), /Multiple old profiles/);
  assert.ok(fs.existsSync(first) && fs.existsSync(second));
  fs.mkdirSync(destination, {recursive:true});
  fs.writeFileSync(path.join(destination, 'sentinel'), 'keep');
  assert.throws(() => migrateProductHome(destination, options), /Multiple old profiles/);
  assert.equal(fs.readFileSync(path.join(destination, 'sentinel'), 'utf8'), 'keep');
});


test('archives signed circle and job bytes, keeps the account vault, and acknowledges its notice once', t => {
  const {destination, options, profile} = fixture(t);
  const source = profile('.spare' + 'kin');
  const raw = '{"schema":"old-protocol","signature":"fixture-only"}';
  fs.mkdirSync(path.join(source, 'v1', 'circles', 'old'), {recursive:true});
  fs.writeFileSync(path.join(source, 'v1', 'circles', 'old', 'roster.json'), raw);
  fs.writeFileSync(path.join(source, 'v1', 'state.json'), '{"version":1,"circles":[{"id":"old"}]}');
  fs.writeFileSync(path.join(source, 'v1', 'job-meta.json'), raw);
  fs.mkdirSync(path.join(source, 'v1', 'accounts', 'account-vault'), {recursive:true});
  fs.writeFileSync(path.join(source, 'v1', 'accounts', 'account-vault', 'one.json'), 'test-only-sign-in');
  migrateProductHome(destination, {...options, now:() => new Date('2026-11-26T00:00:00Z')});
  const archive = path.join(destination, 'earlier-preview-2026-11-26');
  assert.equal(fs.readFileSync(path.join(archive, 'v1', 'circles', 'old', 'roster.json'), 'utf8'), raw);
  assert.equal(fs.readFileSync(path.join(archive, 'v1', 'job-meta.json'), 'utf8'), raw);
  assert.equal(fs.existsSync(path.join(destination, 'v1', 'circles')), false);
  assert.equal(fs.existsSync(path.join(destination, 'v1', 'job-meta.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'v1', 'state.json'))).circles, []);
  assert.equal(fs.readFileSync(path.join(destination, 'v1', 'accounts', 'account-vault', 'one.json'), 'utf8'), 'test-only-sign-in');
  assert.equal(productMigrationNotice(destination).archive, archive);
  assert.equal(productMigrationNotice(destination).message, 'Circles from the earlier preview must be created or joined again. Your accounts and settings were kept.');
  acknowledgeProductMigration(destination);
  acknowledgeProductMigration(destination);
  assert.equal(productMigrationNotice(destination), null);
  assert.equal(migrateProductHome(destination, options), null);
  assert.equal(fs.readFileSync(path.join(archive, 'v1', 'job-meta.json'), 'utf8'), raw);
});

for (const previous of ['.local/share/Faravan Preview 20261028', '.spare' + 'kin']) for (const shortHome of [true, false]) test(`copies real sign-in stores (${previous}, ${shortHome ? 'external short home' : 'long home'})`, async t => {
  const {home, destination, options, profile} = fixture(t);
  const source = profile(previous);
  // The real socket suffix requires a very short account home to exercise the hash fallback.
  const userHome = shortHome ? fs.mkdtempSync((process.platform === 'linux' ? '/dev/shm/' : os.tmpdir() + path.sep)) : null;
  if(userHome)t.after(()=>fs.rmSync(userHome,{recursive:true,force:true}));
  const select = dataHome => selectSbxHome({home, dataHome, override:'', channelPlatform:'linux', channelEnv:{}, userHome}).home;
  const oldSbx = select(source), newSbx = select(destination);
  if(shortHome)assert.ok(oldSbx.startsWith(path.join(userHome,'.fsbx')));
  fs.mkdirSync(oldSbx, {recursive:true, mode:0o700});
  const id = '11111111-1111-4111-8111-111111111111';
  const account = await publishClaudeAccount(oldSbx, id, {kind:'subscription-token', token:'sk-ant-oat01-' + 'a'.repeat(32)});
  const provider = await createProviderSource(oldSbx, 'codex');
  fs.writeFileSync(path.join(provider.directory, 'auth.json'), JSON.stringify({tokens:{access_token:'fixture-access',id_token:'fixture-id',refresh_token:'fixture-refresh'}}), {mode:0o600});
  await publishProviderGeneration(oldSbx, provider);
  const usage = createUsageAccountStore({home:oldSbx,withMutation:run=>run()});
  await usage.stageRefresh('codex',{priorGeneration:'fixture-generation',raw:{refresh_token:'fixture-rotated'}});
  const github = {id,ghBin:'fixture-gh',pathEnv:'/fixture/bin'};
  await createGitHubSource(oldSbx,github);
  fs.writeFileSync(path.join(oldSbx,`.gh-task-access-${id}/hosts.yml`),'fixture-github-source',{mode:0o600});
  await publishGitHubGeneration(oldSbx,github,'fixture-github-token');
  fs.mkdirSync(path.join(oldSbx,'.docker'), {mode:0o700});
  fs.writeFileSync(path.join(oldSbx,'.docker/config.json'), 'fixture-docker');
  fs.writeFileSync(path.join(oldSbx,`usage-account-codex-${id}.json`), 'fixture-account');
  migrateProductHome(destination, {...options, sandboxUserHome:userHome});
  assert.deepEqual(await readClaudeAccount(newSbx, id), account);
  assert.equal((await readCurrentProviderValue(newSbx,'codex')).value.tokens.refresh_token, 'fixture-refresh');
  assert.equal((await createUsageAccountStore({home:newSbx}).stagedRefresh('codex'))?.raw.refresh_token,'fixture-rotated');
  assert.equal((await currentGitHubGeneration(newSbx)).source.id,id);
  assert.equal(fs.readFileSync(path.join(newSbx,`.gh-task-access-${id}/hosts.yml`),'utf8'),'fixture-github-source');
  assert.equal(fs.readFileSync(path.join(newSbx,'.docker/config.json'),'utf8'), 'fixture-docker');
  assert.equal(fs.readFileSync(path.join(newSbx,`usage-account-codex-${id}.json`),'utf8'), 'fixture-account');
  if(shortHome) assert.deepEqual(await readClaudeAccount(oldSbx,id),account,'the old sandbox home is copied, never moved');
});

test('the device name remains usable after circles are cleared',t=>{
 const {destination,options,profile}=fixture(t),source=profile('.local/share/Faravan Preview 20261028');
 fs.writeFileSync(path.join(source,'v1/state.json'),'{"version":1,"ownerName":"My computer","ownerNameRevision":7,"circles":["old"],"activeCircle":"old"}');
 migrateProductHome(destination,options);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination,'v1/state.json'))),{version:1,ownerName:'My computer',ownerNameRevision:7,circles:[],activeCircle:null});
});

test('the retired dollar-cap store stays in the archive and is not restored',t=>{
 const {destination,options,profile}=fixture(t),source=profile('.local/share/Faravan Preview 20261028');
 const relative='v1/owner-settings';fs.mkdirSync(path.join(source,relative));
 fs.writeFileSync(path.join(source,relative,'owner-settings.json'),'{"version":1,"values":{"maxJobUsd":17}}');
 migrateProductHome(destination,options);
 assert.equal(fs.existsSync(path.join(destination,relative)),false);
 const archive=fs.readdirSync(destination).find(name=>name.startsWith('earlier-preview-'));
 assert.equal(fs.readFileSync(path.join(destination,archive,relative,'owner-settings.json'),'utf8'),'{"version":1,"values":{"maxJobUsd":17}}');
});

test('a chosen source moves when multiple profiles exist', t => {
  const {destination, options, profile} = fixture(t);
  const first = profile('.local/share/Faravan Preview 20261026');
  const second = profile('.local/share/Faravan Preview 20261028');
  assert.throws(() => migrateProductHome(destination,options), /FARAVAN_MOVE_FROM/);
  migrateProductHome(destination, {...options,env:{FARAVAN_MOVE_FROM:second}});
  assert.ok(fs.existsSync(first));
  assert.equal(fs.existsSync(second),false);
});

test('a live old app prevents the move', async t => {
  const {destination, options, profile} = fixture(t);
  const source = profile('.local/share/Faravan Preview 20261026');
  const lock = new URL('../lib/v1/lock.mjs', import.meta.url).href;
  const script = `import {acquireProcessLockSync} from ${JSON.stringify(lock)};
    acquireProcessLockSync(${JSON.stringify(path.join(source, 'v1/app.lock'))});console.log('held');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio:['ignore','pipe','inherit']});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', () => reject(new Error('child ended'))); child.stdout.once('data', resolve); });
  fs.writeFileSync(path.join(source,'v1/app.json'), JSON.stringify({pid:child.pid,port:12345}));
  assert.throws(() => migrateProductHome(destination,options), /Quit the old app, then start Faravan again\./);
  assert.ok(fs.existsSync(source));
  assert.equal(fs.existsSync(destination),false);
});

test('a saved number that belongs to an unrelated live process does not block the move', t => {
  const {destination, options, profile} = fixture(t);
  const source = profile('.local/share/Faravan Preview 20261026');
  fs.writeFileSync(path.join(source,'v1/app.json'), JSON.stringify({pid:process.pid,port:12345}));
  assert.equal(migrateProductHome(destination,options), destination);
  assert.equal(fs.existsSync(source),false);
  assert.ok(fs.existsSync(path.join(destination,'v1/device.pem')));
});

test('two first starts serialize and the waiter sees the completed move', async t => {
  const {home, destination, profile} = fixture(t);
  profile('.local/share/Faravan Preview 20261026');
  const module = new URL('../lib/product-home-move.mjs',import.meta.url).href;
  const script = `import fs from 'node:fs';import {migrateProductHome} from ${JSON.stringify(module)};
    const original=fs.renameSync;fs.renameSync=(...args)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);return original(...args);};
    console.log(JSON.stringify(migrateProductHome(${JSON.stringify(destination)},{home:${JSON.stringify(home)},platform:'linux',env:{},sandboxUserHome:${JSON.stringify(home)}})));`;
  const run = () => new Promise((resolve,reject) => {
    const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  });
  const results = await Promise.all([run(),run()]);
  for(const result of results)assert.equal(result.code,0,result.err);
  assert.deepEqual(results.map(r=>JSON.parse(r.out)).sort(), [destination,null].sort());
});
test('refuses to move into a new home with circles', t => {
  const {destination, options, profile} = fixture(t);
  const source = profile('.spare' + 'kin');
  fs.mkdirSync(path.join(destination, 'v1'), {recursive:true});
  const state = '{"version":1,"circles":[{"id":"new"}]}';
  fs.writeFileSync(path.join(destination, 'v1', 'state.json'), state);
  assert.throws(() => migrateProductHome(destination, options), /already has circles/);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.readFileSync(path.join(destination, 'v1', 'state.json'), 'utf8'), state);
});
test('an interrupted account copy resumes without rewriting the archive or generating a key', t => {
  const {destination, options, profile} = fixture(t);
  profile('.spare' + 'kin');
  const original = fs.cpSync;
  const injected = t.mock.method(fs, 'cpSync', () => { throw new Error('injected copy failure'); });
  assert.throws(() => migrateProductHome(destination, options), /injected copy failure/);
  injected.mock.restore();
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, '.faravan-data-moved'))).phase, 'preparing');
  assert.equal(migrateProductHome(destination, options), destination);
  assert.equal(fs.readFileSync(path.join(destination, 'v1', 'device.pem'), 'utf8'), 'test-only-key');
  assert.equal(fs.cpSync, original);
});

test('the packaging entrypoint moves the former profile before creating app state', async t => {
  const {destination, options, profile} = fixture(t);
  const source = profile('.spare' + 'kin');
  const {spawnSync} = await import('node:child_process');
  const run = spawnSync(process.execPath, [new URL('../lib/product-home-move.mjs', import.meta.url).pathname, destination], {
    encoding:'utf8', env:{...process.env, HOME:options.home, XDG_DATA_HOME:path.join(options.home, '.local/share'), FARAVAN_SBX_SHORT_HOME_BASE:options.home},
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'v1/state.json'))).circles, []);
  assert.ok(productMigrationNotice(destination));
});
