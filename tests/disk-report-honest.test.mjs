import './helpers/no-browser.mjs';
import './helpers/removal-off.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger, ledgerProblem } from '../lib/disk-ledger.mjs';
import { openDiskStore } from '../lib/disk-store.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { readDiskReport, diskLines, diskWarningOf, withFreeReading, liveDiskReport } from '../lib/disk-report.mjs';
import { showStatus } from '../lib/v1/status.mjs';
import { createNotificationFeed, notificationSettings } from '../lib/v1/notifications.mjs';

// The disk report and the low-space warning never say more than was read: an unreadable
// directory or listing is unknown or partial, and a damaged record file does not hide a warning.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-honest-'));
const locked = [];
const lock = dir => { fs.chmodSync(dir, 0o000); locked.push(dir); };
test.after(() => { for (const dir of locked) fs.chmodSync(dir, 0o755); fs.rmSync(root, { recursive: true, force: true }); });
const GiB = 1024 ** 3;
const LOW = 6 * GiB;
const NOW = 1_800_000_000_000;
const hex = c => c.repeat(64);
const CUR = hex('a');
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const aged = new Date(NOW - 24 * 3600 * 1000).toISOString();
const row = (tag, digest, size) => ({ repository: ASSEMBLED, tag, image_id: digest.slice(0, 12), size, created: aged });
let counter = 0;
const tmp = name => { const dir = path.join(root, `${name}-${counter++}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// ---- 1. ledger validation covers what the readers use

const SWEEP = {
  at: Date.UTC(2026, 10, 7, 12), trigger: 'startup', durationMs: 5, scanned: { images: 3, sandboxes: 0, caches: 0, notOurs: 0 }, eligible: 2, removed: 0, removes: false,
  expectedBytes: 2_400_000_000, expectedPartial: false, storeFreeBytes: null, reclaimedBytes: null, kept: { too_new: 1 }, retained: [{ kind: 'image', ref: 'a:b', reason: 'too_new', heldBy: null }], retainedTotal: 1,
  logsRotated: 0, errors: [], categories: { images: { count: 3, listedBytes: 4_800_000_000, partial: false }, sandboxes: { count: 0 }, workspaces: null, logs: null, caches: null },
};
const valid = lastSweep => ({ version: 3, leases: {}, sandboxes: {}, pins: { current: [], previous: [] }, lastSweep, owned: { images: {}, caches: {} }, ops: {} });
function homeWithFile(t, content) {
  const home = tmp('home');
  const file = path.join(home, 'v1', 'disk-ledger.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return { home, file };
}

const BAD_SWEEPS = {
  'categories as an empty map': { ...SWEEP, categories: {} },
  'categories as a list': { ...SWEEP, categories: [] },
  'a timestamp of text': { ...SWEEP, at: 'bogus' },
  'a timestamp out of range': { ...SWEEP, at: 1e20 },
  'an image count of text': { ...SWEEP, categories: { ...SWEEP.categories, images: { count: 'x', listedBytes: 1 } } },
  'a logs record that is a number': { ...SWEEP, categories: { ...SWEEP.categories, logs: 5 } },
  'a cache size of text': { ...SWEEP, categories: { ...SWEEP.categories, caches: { bytes: 'big' } } },
  'errors that are not a list': { ...SWEEP, errors: 'none' },
  'an error with no message': { ...SWEEP, errors: [{ item: 'x' }] },
  'kept counts of text': { ...SWEEP, kept: { too_new: 'one' } },
  'retained that is not a list': { ...SWEEP, retained: {} },
  'a retained item with no ref': { ...SWEEP, retained: [{ kind: 'image', reason: 'too_new' }] },
  'an expected size of text': { ...SWEEP, expectedBytes: 'lots' },
};
for (const [name, lastSweep] of Object.entries(BAD_SWEEPS)) {
  test(`a last sweep with ${name} makes the ledger damaged, before any render or update`, () => {
    assert.ok(ledgerProblem(valid(lastSweep)), 'the shape check names a problem');
    const { home, file } = homeWithFile(null, valid(lastSweep));
    const bytes = fs.readFileSync(file, 'utf8');
    const ledger = createDiskLedger({ file });
    assert.equal(ledger.damaged, true);
    assert.throws(() => ledger.recordSweep({ ...SWEEP }), /damaged/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the bytes are kept');
    const report = readDiskReport(home);
    assert.equal(report.damaged, true);
    assert.doesNotThrow(() => diskLines(report));
    assert.match(diskLines(report).join('\n'), /disk records damaged/);
  });
}

test('older summaries stay readable: no removes flag, the old listed size, no partial flags, no kept list', () => {
  const { expectedBytes, expectedPartial, removes, retained, retainedTotal, ...old } = SWEEP;
  const older = { ...old, listedBytes: 2_400_000_000, categories: { images: { count: 2, listedBytes: 4_800_000_000 }, sandboxes: { count: 1 }, workspaces: { count: 3, bytes: 210_000_000 }, logs: { bytes: 4_000_000 }, caches: { bytes: 1 } } };
  assert.equal(ledgerProblem(valid(older)), null);
  assert.equal(ledgerProblem(valid(SWEEP)), null);
  assert.equal(ledgerProblem(valid({ at: 1, trigger: 'startup' })), null, 'a summary with no categories is old, not damaged');
  assert.equal(ledgerProblem(valid({ ...SWEEP, categories: { ...SWEEP.categories, images: { count: null, listedBytes: null, partial: true }, sandboxes: { count: null }, logs: { bytes: null, partial: true } } })), null, 'unknown figures are stored as null');
});

// ---- 2. unreadable directories are not complete zeroes

const world = ({ templates = [], sandboxes = [] } = {}) => ({
  runSbx: async args => {
    if (args[0] === 'template' && args[1] === 'ls') return templates === null ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: JSON.stringify([row('0a0a0a0a0a0a0a0a', CUR, 1000), ...templates]), stderr: '' };
    if (args[0] === 'ls') return sandboxes === null ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: JSON.stringify(sandboxes), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  },
});
function rig(w, { free = 20 * GiB, caches = null, usage = null } = {}) {
  const dir = tmp('case');
  const ledger = createDiskLedger({ file: path.join(dir, 'ledger.json'), now: () => NOW });
  const sweeper = createDiskSweeper({ ledger, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(), caches, usage, measureFree: async () => free, now: () => NOW });
  return { ledger, sweeper, dir };
}

test('an unreadable logs root is unknown and partial, not 0 B complete', { skip: isRoot && 'root reads any directory' }, async () => {
  const logs = tmp('logs');
  fs.writeFileSync(path.join(logs, 'a.log'), 'x'.repeat(100));
  lock(logs);
  const { sweeper } = rig(world(), { usage: { logsDir: logs } });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.categories.logs.bytes, null);
  assert.equal(summary.categories.logs.partial, true);
  assert.match(diskLines({ last_sweep: summary, categories: summary.categories }).join('\n'), /logs unknown/);
});

test('an unreadable workspace root is unknown, not zero workspaces', { skip: isRoot && 'root reads any directory' }, async () => {
  const scratch = tmp('scratch');
  lock(scratch);
  const { sweeper } = rig(world(), { usage: { scratchRoot: scratch } });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.categories.workspaces.count, null);
  assert.equal(summary.categories.workspaces.bytes, null);
  assert.equal(summary.categories.workspaces.partial, true);
  const text = diskLines({ last_sweep: summary, categories: summary.categories }).join('\n');
  assert.match(text, /workspaces unknown/);
  assert.doesNotMatch(text, /workspaces 0|null/);
});

test('an empty readable logs root is a complete zero, and a missing one is too', async () => {
  const logs = tmp('logs');
  const { sweeper } = rig(world(), { usage: { logsDir: logs, cacheRoot: path.join(logs, 'nope') } });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.deepEqual(summary.categories.logs, { bytes: 0, partial: false });
  assert.deepEqual(summary.categories.caches, { bytes: 0, partial: false });
});

test('a partial traversal keeps what it measured as a lower bound and says partial', { skip: isRoot && 'root reads any directory' }, async () => {
  const logs = tmp('logs');
  fs.writeFileSync(path.join(logs, 'a.log'), 'x'.repeat(100));
  const hidden = path.join(logs, 'sub');
  fs.mkdirSync(hidden);
  fs.writeFileSync(path.join(hidden, 'b.log'), 'y'.repeat(5000));
  lock(hidden);
  const { sweeper } = rig(world(), { usage: { logsDir: logs } });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.categories.logs.partial, true);
  assert.ok(summary.categories.logs.bytes >= 100 && summary.categories.logs.bytes < 5000, `lower bound, got ${summary.categories.logs.bytes}`);
});

test('an unreadable cache root is not an empty list: the sweep says so, and the would-free figure is not complete', { skip: isRoot && 'root reads any directory' }, async () => {
  const cacheRoot = tmp('cache');
  lock(cacheRoot);
  const { sweeper, ledger } = rig(world(), { caches: () => ({ root: cacheRoot, current: hex('9'), offer: true }) });
  ledger.ownCache(path.join(cacheRoot, hex('7')), 'created');
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.ok(summary.errors.some(error => error.item === 'cache-listing'), JSON.stringify(summary.errors));
  assert.equal(summary.expectedPartial, true);
  assert.ok(ledger.ownedCaches()[path.join(cacheRoot, hex('7'))], 'an unreadable root does not disown what the ledger recorded');
});

// ---- 3. failed listings are not complete zero totals

test('failed template and sandbox listings give unknown counts and an unknown would-free figure', async () => {
  const { sweeper } = rig(world({ templates: null, sandboxes: null }));
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.categories.images.count, null);
  assert.equal(summary.categories.images.listedBytes, null);
  assert.equal(summary.categories.images.partial, true);
  assert.equal(summary.categories.sandboxes.count, null);
  assert.equal(summary.expectedBytes, null);
  assert.equal(summary.expectedPartial, true);
  const lines = diskLines({ last_sweep: summary, categories: summary.categories }).join('\n');
  assert.match(lines, /images unknown/);
  assert.match(lines, /sandboxes unknown/);
  assert.match(lines, /could free: unknown/);
  assert.doesNotMatch(lines, /images 0|sandboxes 0|could free 0/);
  const warning = diskWarningOf({ last_sweep: summary, categories: summary.categories }, LOW);
  assert.match(warning.text, /images unknown, sandboxes unknown/);
  assert.match(warning.text, /could free: unknown/);
  assert.equal(warning.could_free_bytes, null);
});

test('an unreadable sandbox listing alone gives a partial lower bound, never a complete figure', async () => {
  const calls = [];
  const { runSbx } = world({ templates: [row('1111111111111111', hex('c'), 2 * GiB)], sandboxes: null });
  const { sweeper } = rig({ runSbx: args => {
    calls.push([...args]);
    return runSbx(args);
  } });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.deepEqual(calls, [['template', 'ls', '--json'], ['template', 'ls', '--json'], ['ls', '--json']]);
  assert.equal(summary.expectedPartial, true);
  assert.equal(summary.categories.sandboxes.count, null);
  const warning = diskWarningOf({ last_sweep: summary, categories: summary.categories }, LOW);
  assert.match(warning.text, /sandboxes unknown/);
  assert.doesNotMatch(warning.text, /could free \d/, 'no plain figure while an inventory is unreadable');
});

test('an unreadable template listing alone does not report zero images', async () => {
  const { sweeper } = rig(world({ templates: null, sandboxes: [] }));
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.categories.images.count, null);
  assert.equal(summary.categories.sandboxes.count, 0, 'the readable listing is still counted');
  assert.equal(summary.expectedBytes, null);
});

test('a complete listing still gives plain figures', async () => {
  const { sweeper, ledger } = rig(world({ templates: [row('1111111111111111', hex('c'), 2 * GiB)], sandboxes: [] }));
  ledger.ownImages([{ ref: 'docker.io/library/sandbox-kit-assembled:1111111111111111', imageId: hex('c').slice(0, 12) }], 'created');
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.expectedBytes, 0, 'images are never removed, so their size is not counted as freeable');
  assert.equal(summary.expectedPartial, false);
  assert.equal(summary.categories.images.count, 2);
});

// ---- 4. a damaged ledger does not hide a valid low-space warning

const DAMAGED = valid({ ...SWEEP, categories: [] });
const device = { keyId: 'k'.repeat(40), listCircles: async () => [] };
async function runStatus(home, argv, storeFree) {
  let out = '';
  await showStatus(argv, { home, device, storeFree, fetch: async () => { throw new TypeError('no app'); }, stdout: { write: s => { out += s; } }, stderr: { write() {} } });
  return out;
}

test('with a damaged ledger and a low live reading, status says both, with unknown figures', async t => {
  const { home, file } = homeWithFile(t, DAMAGED);
  const bytes = fs.readFileSync(file, 'utf8');
  const text = await runStatus(home, [], async () => LOW);
  assert.match(text, /Low disk space: 6\.4 GB is free/);
  assert.match(text, /images unknown, sandboxes unknown, caches unknown, logs unknown/);
  assert.match(text, /could free: unknown/);
  assert.match(text, /disk records damaged/);
  const json = JSON.parse(await runStatus(home, ['--json'], async () => LOW));
  assert.equal(json.disk.damaged, true);
  assert.equal(json.disk.warning.kind, 'disk_space_low');
  assert.equal(json.disk.warning.could_free_bytes, null);
  assert.equal(json.disk.warning.by_kind.images.count, null);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the damaged file is untouched');
  assert.doesNotMatch(await runStatus(home, [], async () => 200 * GiB), /Low disk space/);
  assert.match(await runStatus(home, [], async () => 200 * GiB), /disk records damaged/);
  assert.doesNotMatch(await runStatus(home, [], async () => null), /Low disk space/);
});

test('doctor says both for a damaged ledger on a low drive', async t => {
  const { default: cli } = await import('../bin/faravan');
  const { home } = homeWithFile(t, DAMAGED);
  const backend = { probeCapabilities: async () => ({ preflight: { ok: true, backend_id: 'docker-sbx', checks: [] } }), testWorkspace: async () => ({ ok: true }) };
  const { result } = await cli.sandboxPreflight({ report: false, quick: true, home, backendFactory: () => backend, storeFree: async () => LOW });
  assert.equal(result.disk.damaged, true);
  assert.equal(result.disk.warning.kind, 'disk_space_low');
  assert.match(diskLines(withFreeReading(readDiskReport(home), LOW)).join('\n'), /Low disk space[\s\S]*disk records damaged/);
});

test('Status and Doctor keep the current reading separate from disabled sweep history', async t => {
  const {default:cli}=await import('../bin/faravan');
  const cacheRoot=tmp('disabled-cache'), cache=path.join(cacheRoot,hex('7'));
  fs.mkdirSync(cache);
  const marker=path.join(cache,'sentinel');
  fs.writeFileSync(marker,'keep these bytes\n');
  fs.utimesSync(cache,new Date(NOW-30*86400000),new Date(NOW-30*86400000));
  const {ledger,sweeper}=rig(world(),{free:LOW,caches:()=>({root:cacheRoot,current:CUR,offer:true})});
  ledger.ownCache(cache,'created');
  const saved=await sweeper.run({trigger:'startup'});
  assert.deepEqual([saved.eligible,saved.removes,saved.removed,saved.reclaimedBytes],[1,false,0,null]);
  const {home,file}=homeWithFile(t,fs.readFileSync(ledger.file,'utf8'));
  const before=fs.readFileSync(file,'utf8');
  const backend={probeCapabilities:async()=>({preflight:{ok:true,backend_id:'docker-sbx',checks:[]}})};
  const liveLow=LOW+GiB;
  for(const current of [undefined,null,200*GiB,liveLow]) {
    const measure=async()=>current;
    const status=JSON.parse(await runStatus(home,['--json'],measure)).disk;
    const {result}=await cli.sandboxPreflight({home,report:false,quick:true,backendFactory:()=>backend,storeFree:measure});
    for(const [command,report] of [['Status',status],['Doctor',result.disk]]) {
      assert.equal(report.store_free_bytes,current??null,command);
      assert.equal(report.measured_at,saved.at,command);
      if(current===liveLow){
        assert.equal(report.warning?.kind,'disk_space_low',command);
        assert.equal(report.warning?.free_bytes,liveLow,command);
      }else assert.equal(report.warning,null,command);
      const sweep=report.last_sweep;
      assert.deepEqual([sweep.at,sweep.storeFreeBytes,sweep.removes,sweep.removed,sweep.reclaimedBytes],
        [saved.at,LOW,false,0,null],command);
    }
    for(const text of [await runStatus(home,[],measure),diskLines(result.disk).join('\n')]) {
      assert.match(text,/cleanup is turned off/i);
      assert.match(text,/could free: unknown/);
      if(current===liveLow)assert.match(text,/Low disk space: 7\.5 GB is free/);
      else assert.doesNotMatch(text,/Low disk space/);
      assert.doesNotMatch(text,/Last disk measurement|measured reclaimed/);
    }
  }
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(fs.readFileSync(marker,'utf8'),'keep these bytes\n');
});

test('Status JSON and Doctor keep the saved startup sweep honest when only sandbox listing failed', async t => {
  const calls = [];
  const sbx = world({ templates: [row('1111111111111111', hex('c'), 2 * GiB)], sandboxes: null });
  const { sweeper, dir } = rig({ runSbx: args => {
    calls.push([...args]);
    return sbx.runSbx(args);
  } });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.deepEqual(calls, [['template', 'ls', '--json'], ['template', 'ls', '--json'], ['ls', '--json']]);
  assert.deepEqual(summary.errors.map(error => error.item), ['sandbox-listing']);
  assert.equal(summary.storeFreeBytes, 20 * GiB, 'the saved sweep itself was not low');
  const { home, file } = homeWithFile(t, fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'));
  const bytes = fs.readFileSync(file);

  // Point the canonical store lookup at an empty fixture so no actual sbx
  // ledger can shadow the profile fixture. All free-space reads are injected.
  const previousSbxHome = process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_SBX_HOME = tmp('empty-sbx-home');
  t.after(() => {
    if (previousSbxHome === undefined) delete process.env.FARAVAN_SBX_HOME;
    else process.env.FARAVAN_SBX_HOME = previousSbxHome;
  });

  const check = disk => {
    assert.notEqual(disk.damaged, true);
    assert.equal(disk.last_sweep.trigger, 'startup');
    assert.equal(disk.last_sweep.at, summary.at);
    assert.equal(disk.last_sweep.removes, false);
    assert.equal(disk.last_sweep.removed, 0);
    assert.equal(disk.last_sweep.listingsComplete, false);
    assert.equal(disk.last_sweep.expectedPartial, true);
    assert.equal(disk.last_sweep.expectedBytes, null);
    assert.equal(disk.categories.images.count, 2);
    assert.equal(disk.categories.sandboxes.count, null);
    assert.equal(disk.warning.kind, 'disk_space_low');
    assert.equal(disk.warning.free_bytes, LOW);
    assert.equal(disk.warning.by_kind.sandboxes.count, null);
    assert.equal(disk.warning.could_free_partial, true);
    assert.equal(disk.warning.could_free_bytes, null);
    assert.match(disk.warning.text, /sandboxes unknown/);
    assert.deepEqual(fs.readFileSync(file), bytes, 'readers leave ledger bytes untouched');
  };
  let freeReads = 0;
  const storeFree = async () => { freeReads += 1; return LOW; };
  check(JSON.parse(await runStatus(home, ['--json'], storeFree)).disk);
  assert.equal(freeReads, 1);

  const { default: cli } = await import('../bin/faravan');
  const backend = {
    probeCapabilities: async () => ({ preflight: { ok: true, backend_id: 'docker-sbx', checks: [] } }),
    testWorkspace: async () => assert.fail('quick Doctor must not launch a workspace'),
  };
  const { result } = await cli.sandboxPreflight({ report: false, quick: true, home, backendFactory: () => backend, storeFree });
  check(result.disk);
  assert.equal(freeReads, 2);
});

test('the app view of a damaged ledger carries the warning, and the notification feed takes it', async t => {
  const { file } = homeWithFile(t, DAMAGED);
  const ledger = createDiskLedger({ file });
  const report = liveDiskReport(ledger, LOW);
  assert.equal(report.damaged, true);
  assert.equal(report.warning.kind, 'disk_space_low');
  assert.equal(liveDiskReport(ledger, 200 * GiB).warning, null);
  const dir = tmp('feed');
  const feed = await createNotificationFeed(dir, { now: () => NOW });
  const start = feed.read().cursor;
  await feed.diskWarning(report.warning, notificationSettings());
  assert.equal(feed.read(start).notifications.length, 1);
  assert.match(feed.read(start).notifications[0].body, /Low disk space: 6\.4 GB is free/);
});


test('cache child stat errors make report discovery incomplete while gone children stay empty', async t => {
  const actual=[],expected=[];
  for(const code of ['EACCES','EIO','ENOENT','ENOTDIR'])for(const sized of [false,true]) {
    const cacheRoot=tmp('child-stat'),child=path.join(cacheRoot,hex('7'));
    fs.mkdirSync(child);
    const lstat=fs.promises.lstat;
    const mocked=t.mock.method(fs.promises,'lstat',async (file,...args)=>{
      if(file===child)throw Object.assign(new Error('synthetic child stat failure'),{code});
      return lstat(file,...args);
    });
    let summary;
    try {
      // Only a cache the ledger records as ours is read for size; a directory nobody recorded is not touched or measured.
      const r=rig(world({templates:sized?[row('1111111111111111',hex('c'),4096)]:[]}),{caches:{root:cacheRoot,current:hex('9')}});
      r.ledger.ownCache(child,'created');
      if(sized)r.ledger.ownImages([{ref:`${ASSEMBLED}:1111111111111111`,imageId:hex('c').slice(0,12)}],'created');
      summary=await r.sweeper.run({trigger:'startup'});}
    finally {mocked.mock.restore();}
    const incomplete=['EACCES','EIO'].includes(code);
    actual.push({code,sized,complete:summary.listingsComplete,partial:summary.expectedPartial,bytes:summary.expectedBytes,
      error:summary.errors.some(error=>error.item==='cache-listing'),removes:summary.removes});
    expected.push({code,sized,complete:!incomplete,partial:incomplete,bytes:incomplete?null:0,error:incomplete,removes:false});
    if(incomplete)assert.doesNotMatch(diskLines({last_sweep:summary,categories:summary.categories}).join('\n'),/could free 0 B/);
  }
  assert.deepEqual(actual,expected);
  const empty=await rig(world(),{caches:{root:tmp('empty-cache'),current:hex('9')}}).sweeper.run({trigger:'startup'});
  assert.equal(empty.listingsComplete,true);assert.equal(empty.expectedPartial,false);assert.equal(empty.expectedBytes,0);
});

test('unknown listing rows never become a complete empty report', async()=>{
  const foreign={repository:'example/foreign',tag:'v1',id:'123456789abc',size:10};
  const untagged={repository:'example/foreign',tag:'<none>',id:'123456789abc'};
  const sandbox={name:'foreign-sandbox',status:'running'};
  const cases=[
    ['template',[{unexpected:true}],false],['template',[foreign,{unexpected:true}],false],
    ['template',[null],false],['template',[[]],false],['template',[{repository:7,tag:'v1'}],false],
    ['template',[{repository:'example/foreign'}],false],['template',[{repository:'example/foreign',tag:7}],false],
    ['sandbox',[{unexpected:true}],false],['sandbox',[sandbox,{unexpected:true}],false],
    ['sandbox',[{name:'',status:'stopped'}],false],
    ['template',[],true],['sandbox',[],true],['template',[foreign,untagged],true],['sandbox',[sandbox],true],
  ];
  const actual=[],expected=[];
  for(const [kind,rows,complete] of cases) {
    const calls=[];
    const w={runSbx:async args=>{
      calls.push(args);const listing=args[0]==='template'?'template':'sandbox';
      return {code:0,stdout:JSON.stringify(listing===kind?rows:[]),stderr:''};
    }};
    const summary=await rig(w).sweeper.run({trigger:'startup'});
    const text=diskLines({last_sweep:summary,categories:summary.categories}).join('\n');
    actual.push({kind,rows,complete:summary.listingsComplete,partial:summary.expectedPartial,bytes:summary.expectedBytes,
      error:summary.errors.some(error=>error.item===kind+'-listing'),unknownCount:summary.categories[kind==='template'?'images':'sandboxes'].count===null});
    expected.push({kind,rows,complete,partial:!complete,bytes:complete?0:null,error:!complete,unknownCount:!complete});
    assert.equal(summary.removes,false);assert.ok(calls.every(args=>args[0]==='ls'||args[0]==='template'&&args[1]==='ls'));
    if(!complete)assert.doesNotMatch(text,/could free 0 B/);
    if(kind==='template'&&complete&&rows.length)assert.equal(summary.scanned.notOurs,1,'recognized foreign and untagged rows retain their handling');
  }
  assert.deepEqual(actual,expected);
});

test('an unreadable preferred disk ledger does not silently substitute the profile record', t => {
  const { home } = homeWithFile(t, valid({ ...SWEEP, trigger: 'profile' }));
  const ledgerFile = path.join(tmp('preferred'), 'disk-ledger.json');
  assert.equal(readDiskReport(home, { ledgerFile }).last_sweep.trigger, 'profile');
  fs.mkdirSync(ledgerFile);
  const report = readDiskReport(home, { ledgerFile });
  assert.equal(report.damaged, true);
  assert.equal(report.last_sweep, undefined);
  assert.match(diskLines(report).join('\n'), /could not read/);
  assert.equal(fs.statSync(ledgerFile).isDirectory(), true);
});

test('the app keeps the last sweep reading separate from current free space', () => {
  const sweep = { ...SWEEP, storeFreeBytes: LOW };
  const ledger = { sweepSnapshot: () => ({ lastSweep: sweep, damage: null }) };
  const initial = liveDiskReport(ledger);
  assert.equal(initial.last_sweep.storeFreeBytes, LOW);
  assert.equal(initial.measured_at, SWEEP.at);
  assert.equal(initial.store_free_bytes, null);
  assert.equal(initial.warning, null);
  assert.equal(liveDiskReport(ledger, null).warning, null);
  assert.equal(liveDiskReport(ledger, 200 * GiB).store_free_bytes, 200 * GiB);
  assert.equal(liveDiskReport(ledger, 200 * GiB).warning, null);
  assert.equal(liveDiskReport(ledger, LOW).warning.free_bytes, LOW);

  const historical = withFreeReading({ store_free_bytes: LOW, last_sweep: sweep });
  assert.match(historical.warning.lines[0], /Last disk measurement: .* was free/);
});

test('an old sparse sweep cannot claim removal and a live warning cannot promise it', t => {
  const { home } = homeWithFile(t, valid({ at: 1, trigger: 'startup' }));
  const text = diskLines(readDiskReport(home)).join('\n');
  assert.match(text, /removal was not recorded/);
  assert.doesNotMatch(text, /removed|undefined/);
  const warning = diskWarningOf(null, LOW);
  assert.match(warning.text, /Free space on that drive/);
  assert.doesNotMatch(warning.text, /Faravan frees/);
});

test('a live disk report reads one ledger snapshot and preserves a preferred I/O error', t => {
  const { file: legacyLedgerFile } = homeWithFile(t, valid({ ...SWEEP, trigger: 'legacy' }));
  const { ledger } = openDiskStore({ home: tmp('preferred-store'), legacyLedgerFile });
  ledger.recordSweep({ ...SWEEP, trigger: 'preferred' });
  const readFile = fs.readFileSync;
  const preferredBytes = readFile(ledger.file, 'utf8');
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file !== ledger.file || ++reads === 1) return readFile(file, ...args);
    throw Object.assign(new Error('synthetic preferred ledger I/O error'), { code: 'EIO' });
  });

  const first = liveDiskReport(ledger, LOW);
  assert.equal(first.last_sweep?.trigger, 'preferred');
  assert.equal(reads, 1);
  const unavailable = liveDiskReport(ledger, LOW);
  assert.equal(reads, 2);
  assert.equal(unavailable.damaged, true);
  assert.match(unavailable.damage, /synthetic preferred ledger I\/O error/);
  assert.equal(unavailable.warning.free_bytes, LOW);
  assert.equal(unavailable.warning.could_free_bytes, null);
  assert.throws(() => ledger.recordSweep(SWEEP), { code: 'ledger_damaged' });
  assert.equal(readFile(ledger.file, 'utf8'), preferredBytes);
});
