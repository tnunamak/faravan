import './helpers/no-browser.mjs';
import {guardReadFrom} from './helpers/guard-read.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';

const T = Date.parse('2026-11-03T12:00:00Z');
const identity = {status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'};
const response = (status = 200) => ({stdout:JSON.stringify({faravan_probe:1, status, identity,
  guest_auth:{loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty'},
  body:{five_hour:{utilization:20, resets_at:new Date(T + 3 * 3600e3).toISOString()},
    seven_day:{utilization:10, resets_at:new Date(T + 4 * 86400e3).toISOString()}, extra_usage:{is_enabled:false}}})});
const drain = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-ownership-'));
  const clock = {at:T}, calls = [];
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => clock.at});
  const probe = createLendingProbe({ledger, now:() => clock.at, runGuest:({provider, signal}) =>
    new Promise(resolve => calls.push({provider, signal, resolve}))});
  const readings = createLendingReadings({ledger, probe, now:() => clock.at});
  t.after(async () => {
    for (const call of calls) call.resolve(response());
    await probe.close();
    rmSync(directory, {recursive:true, force:true});
  });
  const seed = readings('claude',{forceRefresh:true});
  assert.equal(calls.length, 1);
  calls[0].resolve(response());
  const good = await seed;
  assert.equal(probe.lastResult('claude').ok,true);
  assert.equal(good.read_at, T);
  return {clock,calls,ledger,probe,readings};
}

test('shared transport preserves an interested guard after one signal cancels',async t=>{
 const f=await fixture(t),background=new AbortController(),guard=new AbortController();
 f.clock.at=T+1000;
 const first=f.readings('claude',{signal:background.signal,forceRefresh:true});await drain();
 assert.equal(f.calls.length,2);
 let meterRuns=0;
 const second=f.readings('claude',{signal:guard.signal,forceRefresh:true,
  guardRead:guardReadFrom(async()=>{meterRuns++;assert.fail('join the existing provider read');})});await drain();
 assert.equal(f.calls.length,2);assert.equal(meterRuns,0);
 background.abort();assert.equal(guard.signal.aborted,false);assert.equal(f.calls[1].signal.aborted,false);
 assert.equal(f.probe.inFlight('claude'),true);assert.equal(f.ledger.snapshotReadOnly('claude').read_at,T);
 f.clock.at=T+9000;f.calls[1].resolve(response());
 const [a,b]=await Promise.all([first,second]);assert.equal(a.refresh_succeeded,false);assert.equal(b.read_at,T+1000);
 assert.equal(f.probe.inFlight('claude'),false);assert.equal(f.ledger.snapshotReadOnly('claude').read_at,T+1000);
 assert.equal(f.probe.funding('claude').observed_at,T+1000);
});

test('successful join, provider isolation and backoff expiry retain dispatch timestamps', async t => {
  const f = await fixture(t);
  f.clock.at = T + 1000;
  const first = f.readings('claude',{forceRefresh:true});
  const second = f.readings('claude',{forceRefresh:true,guardRead:guardReadFrom(() => assert.fail('joined'))});
  assert.equal(f.calls.length, 2);
  const otherSignal = new AbortController();
  const other = f.readings('codex',{signal:otherSignal.signal,forceRefresh:true});
  assert.equal(f.calls.length, 3, 'different provider owns a different controller');
  otherSignal.abort();
  assert.equal(f.calls[2].signal.aborted, true);
  assert.equal(f.calls[1].signal.aborted, false);
  f.clock.at = T + 5000;
  f.calls[1].resolve(response()); f.calls[2].resolve(response());
  for (const result of await Promise.all([first, second])) {
    assert.ok(result.windows.length>0);
    assert.equal(result.read_at, T + 1000, 'completion time does not renew the acquisition timestamp');
  }
  assert.equal((await other).probe.reason, 'cancelled');
  const limited = f.readings('claude',{forceRefresh:true});
  f.calls[3].resolve(response(429));
  assert.equal((await limited).probe.reason, 'rate_limited');
  const savedAt = T + 1000;
  assert.equal(f.ledger.snapshotReadOnly('claude').read_at, savedAt);
  f.clock.at += 299999;
  assert.equal((await f.readings('claude',{forceRefresh:true})).probe.reason, 'rate_limited');
  assert.equal(f.calls.length, 4);
  f.clock.at++;
  const dispatchAt = f.clock.at;
  const retry = f.readings('claude',{forceRefresh:true});
  assert.equal(f.calls.length, 5, 'BackoffExpires enables another transport generation');
  f.clock.at += 1000; f.calls[4].resolve(response());
  assert.equal((await retry).read_at, dispatchAt);
});

for (const count of [1, 2]) {
  test(`${count} cancelled waiters abort transport and drain ownership before a later read`, async t => {
    const f = await fixture(t);
    const signals = Array.from({length:count}, () => new AbortController());
    const reads = signals.map(controller => f.probe.probe('claude', {signal:controller.signal}));
    assert.equal(f.calls.length, 2);
    for (let i = 0; i < count; i++) {
      signals[i].abort();
      assert.deepEqual(await reads[i], {ok:false, reason:'cancelled'});
      assert.equal(getEventListeners(signals[i].signal, 'abort').length, 0);
      assert.equal(f.calls[1].signal.aborted, i === count - 1);
    }
    assert.equal(f.probe.inFlight('claude'), true, 'cleanup still owns the transport');
    const late = f.probe.probe('claude');
    assert.equal(f.calls.length, 2, 'no overlapping transport during cleanup');
    f.calls[1].resolve(response());
    await drain();
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2].signal.aborted, false);
    f.calls[2].resolve(response());
    assert.equal((await late).ok, true);
    assert.equal(f.probe.inFlight('claude'), false);
    assert.equal(await f.probe.close(), undefined);
  });
}

test('late joiner shares the surviving transport after another waiter cancels', async t => {
  const f = await fixture(t), firstSignal = new AbortController();
  const first = f.probe.probe('claude', {signal:firstSignal.signal});
  const survivor = f.probe.probe('claude');
  firstSignal.abort();
  assert.equal((await first).reason, 'cancelled');
  const late = f.probe.probe('claude');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].signal.aborted, false);
  f.calls[1].resolve(response());
  assert.equal((await survivor).ok, true);
  assert.equal((await late).ok, true);
});
