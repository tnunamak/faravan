import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {settleOwnResets, assertAdmissionCounts, exposure} from './helpers/pace50-reset-assertions.mjs';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {ACCOUNT, NOW, WEEK, ordinaryInput, request} from './helpers/pace50-fixtures.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'pace50-crash-child.mjs');

// Shared log for parent and child. Each process appends one JSON line per provider-facing call.
function scene(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pace50-crash-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const logPath = join(directory, 'calls.log');
  fs.writeFileSync(logPath, '');
  const log = (entry) => fs.appendFileSync(logPath, JSON.stringify({proc: 'parent', ...entry}) + '\n');
  const effects = {
    arm_cessation_deadline: async (effect) => {
      log({event: 'arm', attempt: effect.attempt_id, resource: effect.resource_id});
      return () => {};
    },
    launch_chunk: async (effect) => { log({event: 'launch', attempt: effect.attempt_id}); },
    open_short_window: async (effect) => { log({event: 'open', attempt: effect.attempt_id}); },
    cancel_pending_attempt: async (effect) => { log({event: 'cancel', attempt: effect.attempt_id, effect_id: effect.effect_id}); },
    request_cessation: async (effect) => { log({event: 'cessation', attempt: effect.attempt_id, effect_id: effect.effect_id}); },
    request_fresh_complete_reconciliation: async (effect) => { log({event: 'reconcile', attempt: effect.attempt_id}); },
  };
  // Observation time moves forward with authoritative events; a restarted process reads the same clock.
  const clock = {at: NOW};
  const open = () => createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK,
    // Bind the signed request ceiling into the objective; otherwise it quotes all spare capacity.
  buildInput: async ({now, request: requested}) => {
    const input = ordinaryInput({now,windows:ordinaryInput({now:now<NOW+42*3600000?NOW:now}).windows.map(w=>({...w,observed_at:now}))});
    input.objective.job.requestedUsdMicro = requested.requested_usd_micro;
    return input;
  }, effects, now: () => clock.at});
  const readLog = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return {directory, logPath, clock, open, readLog, file: join(directory, 'lending-pace50-state.json')};
}

// Runs one scenario in a child process. The child must die by SIGKILL, not exit on its own.
function killedAt(s, scenario) {
  const out = spawnSync(process.execPath, [CHILD, s.directory, scenario, String(NOW), s.logPath],
    {encoding: 'utf8', timeout: 30000});
  assert.equal(out.signal, 'SIGKILL', `${scenario}: child must be killed (status ${out.status}, stderr ${out.stderr})`);
}

const launches = (s) => s.readLog().filter((e) => e.event === 'launch');
const disk = (s) => JSON.parse(fs.readFileSync(s.file, 'utf8'));

test('a process killed after persisting and before arming leaves a reservation that a restart never launches', {timeout: 30000}, async (t) => {
  const s = scene(t);
  killedAt(s, 'kill-after-persist');
  assert.equal(disk(s).revision, 1);
  assert.equal(disk(s).attempts[0].launch_state, 'reserved');
  const restarted = s.open();
  // The never-launched reservation is counted against capacity, so it does not fence the store: a second run is admitted within what is left.
  const second = await restarted.admit({expectedRevision: 1, request: request({attempt_id: 'attempt-2'})});
  assert.equal(second.admitted, true, JSON.stringify(second));
  // Startup recovery asks the backend to cease the never-launched reservation, and it never launches it.
  const recovered = await restarted.recover();
  assert.ok(recovered.effects.some((e) => e.type === 'request_cessation' && e.attempt_id === 'attempt-1'));
  assert.deepEqual(launches(s).filter((e) => e.attempt === 'attempt-1'), [], 'the unlaunched reservation is never launched');
  await restarted.close();
});

test('a process killed inside the launch callback is counted, not fenced; cleanup retains it until its own reset; the next launch runs once', {timeout: 30000}, async (t) => {
  const s = scene(t);
  killedAt(s, 'kill-in-launch');
  assert.deepEqual(launches(s).map((e) => [e.proc, e.attempt]), [['child', 'attempt-1']]);
  const restarted = s.open();
  // An ambiguous launch is counted against capacity, not a fence: the second run is admitted within what is left.
  const second = await restarted.admit({expectedRevision: 1, request: request({attempt_id: 'attempt-2'})});
  assert.equal(second.admitted, true, JSON.stringify(second));
  const initial=exposure(restarted.state().attempts[0]);
  const cleanup=await restarted.transition({type:'cleanup_proven',event_id:'attempt-1:cleanup-proven:1',at:NOW+1,
    attempt_id:'attempt-1',cleanup_removed:true},{expectedRevision:restarted.state().revision});
  assert.equal(cleanup.applied,true);
  assert.deepEqual(exposure(restarted.state().attempts[0]),initial,'recovered removal proves no usage coverage');
  assert.notEqual(restarted.state().attempts[0].hold_closed,true);
  s.clock.at=NOW+1;
  await assertAdmissionCounts(restarted,'attempt-1',request({attempt_id:'preview-held'}));
  await settleOwnResets(restarted,'attempt-1');
  assert.deepEqual(launches(s).map((e) => [e.proc, e.attempt]), [['child', 'attempt-1'], ['parent', 'attempt-2']],
    'attempt-1 was never launched again');
  await restarted.close();
});

test('a process killed before the rename leaves the old revision, removes its temporary file, and dispatches nothing', {timeout: 30000}, async (t) => {
  const s = scene(t);
  killedAt(s, 'kill-before-rename');
  assert.equal(disk(s).revision, 0);
  assert.equal(fs.readdirSync(s.directory).filter((n) => n.endsWith('.tmp')).length, 1,
    'the killed write left its temporary file behind');
  const restarted = s.open();
  assert.deepEqual(fs.readdirSync(s.directory).filter((n) => n.endsWith('.tmp')), []);
  assert.deepEqual(s.readLog().map((e) => [e.event, e.where ?? null]), [['opened', null], ['killed', 'before-rename']],
    'the child dispatched nothing before its kill');
  const out = await restarted.admit({expectedRevision: 0, request: request()});
  assert.equal(out.admitted, true);
  assert.deepEqual(launches(s).map((e) => e.proc), ['parent']);
  await restarted.close();
});

test('a process killed after the rename but before directory sync has a durable reservation that is counted after restart', {timeout: 30000}, async (t) => {
  const s = scene(t);
  killedAt(s, 'kill-after-rename');
  assert.equal(disk(s).revision, 1, 'the rename already made the proposal durable');
  assert.deepEqual(s.readLog().map((e) => [e.event, e.where ?? null]), [['opened', null], ['killed', 'after-rename']],
    'no arm or launch happened after an unconfirmed persist');
  const restarted = s.open();
  assert.equal((await restarted.admit({expectedRevision: 1, request: request({attempt_id: 'attempt-2'})})).admitted,
    true);
  assert.deepEqual(launches(s).filter((e) => e.attempt === 'attempt-1'), [], 'the durable reservation is never launched');
  await restarted.close();
});

test('a process killed inside a Stop cancel callback is retried by recover with the same effect id after restart', {timeout: 30000}, async (t) => {
  const s = scene(t);
  killedAt(s, 'stop-kill-in-cancel');
  assert.equal(disk(s).mode, 'off', 'the Stop was durable before its callback ran');
  assert.equal(disk(s).attempts[0].process_state, 'cancel_requested');
  const restarted = s.open();
  const retried = await restarted.recover();
  // A cancel-requested attempt gets a cessation request and the cancel, each keyed by attempt, not by revision.
  assert.deepEqual(retried.effects.map((e) => [e.type, e.effect_id, e.status]),
    [['request_cessation', 'recover:request_cessation:attempt-1', 'dispatched'],
      ['cancel_pending_attempt', 'recover:cancel_pending_attempt:attempt-1', 'dispatched']]);
  assert.equal(s.readLog().filter((e) => e.event === 'cancel' && e.proc === 'parent').length, 1);
  assert.deepEqual(launches(s).map((e) => e.proc), ['child'], 'the retry never relaunches');
  const initial=exposure(restarted.state().attempts[0]);
  assert.equal((await restarted.transition({type:'cleanup_proven',event_id:'attempt-1:cleanup-proven:1',at:NOW+2,
    attempt_id:'attempt-1',cleanup_removed:true},{expectedRevision:restarted.state().revision})).applied,true);
  assert.deepEqual(exposure(restarted.state().attempts[0]),initial,'cleanup proves no usage coverage');
  assert.notEqual(restarted.state().attempts[0].hold_closed,true);
  s.clock.at=NOW+3;
  assert.equal((await restarted.admit({expectedRevision:restarted.state().revision,request:request({attempt_id:'attempt-2'})})).reason,'stopped');
  assert.equal((await restarted.transition({type:'on',event_id:'on-1',at:s.clock.at},{expectedRevision:restarted.state().revision})).applied,true);
  await assertAdmissionCounts(restarted,'attempt-1',request({attempt_id:'preview-held'}));
  await settleOwnResets(restarted,'attempt-1');
  s.clock.at=restarted.state().updated_at;
  assert.equal((await restarted.admit({expectedRevision:restarted.state().revision,request:request({attempt_id:'attempt-2'})})).admitted,true);
  await restarted.close();
});

test('a live owner process is refused by a second process; after it is SIGKILLed the store opens again', {timeout: 30000}, async (t) => {
  const s = scene(t);
  const holder = spawn(process.execPath, [CHILD, s.directory, 'hold', String(NOW), s.logPath], {stdio: 'ignore'});
  const exited = new Promise((resolve) => holder.once('exit', (code, signal) => resolve({code, signal})));
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); });
  for (let waited = 0; !s.readLog().some((e) => e.event === 'ready'); waited += 20) {
    assert.ok(waited < 10000, 'the holder never became ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.throws(() => s.open(), {code: 'lock_busy'});
  holder.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  const reopened = s.open();
  assert.equal(reopened.state().revision, 0);
  await reopened.close();
});
