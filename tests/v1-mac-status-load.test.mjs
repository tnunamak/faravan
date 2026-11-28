import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {DockerSbxBackend, probeSbxPreflight} from '../lib/docker-backend.mjs';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const exec = promisify(execFile);

test('display snapshots see atomic replacements without waiting for the writer or changing plans', t => {
  const dir = fs.mkdtempSync(join(homedir(), '.tmp/mac-status-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = join(dir, 'ledger.json'), ledger = createLendingLedger({file});
  ledger.recordReadings('claude', [], {signal:{limit_reached:true,at:Date.now()}});
  const before = fs.readFileSync(file, 'utf8');
  const release = acquireProcessLockSync(file + '.lock');
  try {
    assert.equal(ledger.snapshotForDisplay('claude', {plan:'max20'}).holds, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => createLendingLedger({file,lockWaitMs:0}).snapshotReadOnly('claude'), {code:'lock_busy'});
    assert.throws(() => createLendingLedger({file,lockWaitMs:0}).reserve({account:'claude',job_digest:'j',attempt_id:'a',budget_units:1,unit:'claude_usd'}), {code:'lock_busy'});
  } finally { release(); }
  const other = createLendingLedger({file});
  other.reserve({account:'claude',job_digest:'j',attempt_id:'a',budget_units:1,unit:'claude_usd'});
  assert.equal(ledger.snapshotForDisplay('claude').holds, 1);
  // No cached object escapes to a caller.
  ledger.snapshotForDisplay('claude').signal.limit_reached = false;
  assert.equal(ledger.snapshotForDisplay('claude').signal.limit_reached, true);
  fs.writeFileSync(file, '{');
  assert.throws(() => ledger.snapshotForDisplay('claude'), {code:'ledger_corrupt'});
  fs.unlinkSync(file);
  assert.equal(ledger.snapshotForDisplay('claude').holds, 0);
});

test('APFS-like status polling leaves child callbacks and workspace preparation responsive', {timeout:30000}, async t => {
  const dir = fs.mkdtempSync(join(homedir(), '.tmp/mac-load-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = join(dir, 'ledger.json'), ledger = createLendingLedger({file});
  const at = Date.now();
  ledger.recordReadings('claude', Array.from({length:336}, (_, i) => ({window_id:'seven_day',window_minutes:10080,
    used_pct:i/10,resets_at:at+86400000,observed_at:at-(335-i)*60000,state:'open',source:'probe'})));
  // Retained completed attempts are representative of a busy lender's JSON, but have no active money holds.
  const data = JSON.parse(fs.readFileSync(file));
  data.entries = Array.from({length:1000}, (_, i) => ({account:'codex',attempt_id:'a'+i,ended_at:at-i*60000,windows:[]}));
  fs.writeFileSync(file, JSON.stringify(data));
  const originals = new Map();
  let injectedMs = 0;
  for (const name of ['mkdirSync','lstatSync','symlinkSync','readdirSync','readlinkSync','unlinkSync','fsyncSync']) {
    originals.set(name, fs[name]);
    fs[name] = (...args) => { injectedMs += 30; pause(30); return originals.get(name)(...args); };
  }
  t.after(() => { for (const [name, original] of originals) fs[name] = original; });
  const delays = [], started = performance.now(), elu = performance.eventLoopUtilization();
  const poll = () => { for (let view=0;view<4;view++) for (const provider of ['claude','codex']) ledger.snapshotForDisplay(provider); };
  const timer = setInterval(poll, 2000);
  t.after(() => clearInterval(timer));
  // An independent readiness probe times out. It must not abort a preparation's signal.
  const readiness = probeSbxPreflight({platformName:'darwin',env:{},commandTimeoutMs:20,
    runCommand:async()=>{await sleep(40); return {code:0,stdout:'',stderr:''};}});
  const controller = new AbortController();
  const backend = new DockerSbxBackend({home:dir, runCommand:async () => {
    const {stdout} = await exec(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))']);
    delays.push(Date.now()-Number(stdout));
    return {code:0,stdout:'',stderr:''};
  }});
  const assertActive = backend.assertActive.bind(backend);
  backend.assertActive = (handle, options) => assertActive(handle, {...options, guestCommand:false});
  let failure;
  backend.prepare = async () => {
    const handle = {...testSbxRuntimeFields(backend._profileHome),_prepareSignal:controller.signal,_deadline:{controller:new AbortController(),expired:false},_resources:{}};
    const deadline = setTimeout(() => {handle._deadline.expired = true;}, 500);
    try {
      const command = backend._runJobCommand(handle, ['exec','fixture','--','true']);
      // Replay work done by overlapping home/status projections while sbx exits.
      poll();
      await command;
      return handle;
    } catch (error) { failure=error; throw error; }
    finally {clearTimeout(deadline);}
  };
  backend.destroy = async () => ({removed:true,scratch_removed:true});
  const prepared = await backend.prepare();
  await backend.destroy(prepared);
  assert.equal((await readiness).ok, false, 'the independent readiness timeout must fail closed');
  await sleep(2100);
  clearInterval(timer);
  const busy = performance.eventLoopUtilization(elu), elapsed = performance.now()-started;
  t.diagnostic(JSON.stringify({elapsed_ms:Math.round(elapsed),busy_fraction:busy.utilization,injected_ms:injectedMs,child_callback_delay_ms:delays,workspacePrepared:Boolean(prepared)}));
  assert.equal(failure, undefined);
  assert.equal(prepared._deadline.expired,false,'an independent readiness timeout does not expire workspace preparation');
  assert.ok(Math.max(...delays) < 1000, 'child exits must be observed within one second');
  assert.ok(busy.utilization < 0.35, 'idle polling must leave most of the main thread idle');
});

// The HTTP surface must actually choose the display contract; the ledger-only load test cannot prove that wiring.
test('an unconfigured tray status does not invent provider accounts or write the retired ledger', {timeout:60000}, async t => {
  const f = await appFixture(t);
  const file = join(f.root, 'tray-ledger.json'), ledger = createLendingLedger({file});
  let displays = 0, policies = 0;
  const display = ledger.snapshotForDisplay, policy = ledger.snapshot;
  ledger.snapshotForDisplay = (...args) => {displays++; return display(...args);};
  ledger.snapshot = (...args) => {policies++; return policy(...args);};
  const {app} = await f.start('tray-status', {lendingLedger:ledger});
  displays = policies = 0;
  await api(app, '/api/status');
  assert.equal(displays,0,'no enrolled account means no provider ledger display');
  assert.deepEqual((await api(app,'/api/lending')).objective.accounts,[]);
  assert.equal(policies, 0, 'a tray read must not persist plan changes');
});
