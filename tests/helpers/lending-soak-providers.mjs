import assert from 'node:assert/strict';
import {join} from 'node:path';
import fs from 'node:fs';
import {createLendingLedger} from '../../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../../lib/v1/lending-probe.mjs';
import {createRealPace50Source, readingAgeReserve} from './real-source.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';
import oldRows from '../fixtures/lending/cleanup-open-holds.json' with {type:'json'};
import {DAY, HOUR} from './lending-soak.mjs';

export const START = Date.parse('2026-11-02T15:00:00Z');
export {oldRows};

// The guest and optional provider storage are fake. Parsing, probe backoff, cached snapshots,
// same-run identity/funding and admission age reserves are production code.
export function soakProviders(directory, clock, physical = {failure:new Set(),calls:[],extra:{claude:0,codex:0}}) {
  const identities = {claude:'1111222233334444',codex:'5555666677778888'};
  const {failure,calls,extra} = physical;
  // The long run needs a scripted meter store, not calibration fitting or
  // filesystem flushes for thousands of fake provider answers. Cache/probe
  // behavior still uses the production createLendingReadings/createLendingProbe.
  // The independent I3 integration cases use createLendingLedger itself.
  const ledger = physical.fastMeter ? scriptedMeterLedger(directory,clock)
    : createLendingLedger({file:join(directory,'provider-ledger.json'),now:() => clock.at});
  const weeklyReset = provider => {
    const first = oldRows[provider === 'codex' ? 0 : 1].resources.find(r => r.kind === 'weekly').resets_at;
    return first + Math.max(0,Math.floor((clock.at-first)/(7*DAY))+1)*7*DAY;
  };
  const shortReset = () => START + HOUR + Math.max(0,Math.floor((clock.at-START-HOUR)/(5*HOUR))+1)*5*HOUR;
  const probe = createLendingProbe({ledger,now:() => clock.at,runGuest:async ({provider}) => {
    calls.push([clock.at,provider,!failure.has(provider)]);
    if (failure.has(provider)) return {stdout:JSON.stringify({faravan_probe:1,status:503}),usage_seen_at:clock.at};
    const used = provider === 'codex' ? 87 : 14;
    const body = provider === 'claude' ? {
      seven_day:{utilization:used+extra[provider],resets_at:new Date(weeklyReset(provider)).toISOString()},
      five_hour:{utilization:14+extra[provider],resets_at:new Date(shortReset()).toISOString()},extra_usage:{is_enabled:false},
    } : {plan_type:'pro',spend_control:{reached:false},credits:{has_credits:false},rate_limit:{allowed:true,limit_reached:false,
      primary_window:{used_percent:used+extra[provider],limit_window_seconds:604800,reset_at:weeklyReset(provider)/1000}}};
    return {stdout:JSON.stringify({faravan_probe:1,status:200,body,
      identity:{status:200,account_sha256_16:identities[provider],email_sha256_16:identities[provider]},
      guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),usage_seen_at:clock.at,
      executor:{backend_id:'soak',sbx_version:'test/1'},
      stop:{delivered:true,fallback:null,latency_ms:1,removed:true}};
  }});
  const readings = createLendingReadings({ledger,probe,now:() => clock.at});
  const fixture = createSyntheticPace50Source({start:START});
  const source = createRealPace50Source({readings,funding:p => probe.funding(p),
    expectedIdentity:p => ({account_sha256_16:identities[p]}),
    expectedExecutor:{backend_id:'soak',accepts:v => v === 'test/1'},stopBoundMs:35_000,
    windowOrigin:(_p,resources) => new Map(resources.map(r => [r.id,'owner'])),kappaFloor:() => null,
    kappaForUsage:({provider,window,account_id}) => physical.native && provider === 'claude' ? null : ({binding:{account_sha256_16:account_id},
      upper_micro:provider === 'codex' ? 135700 : window === 'weekly' ? 534900 : 1583100,
      lower_micro:provider === 'codex' ? 135700 : window === 'weekly' ? 534900 : 1583100,
      provenance:{label:'synthetic-soak'}})});
  source.objectiveInputFor = fixture.objectiveInputFor;
  source.history = fixture.history;
  const refresh = async () => {for (const provider of ['claude','codex']) await probe.probe(provider);};
  const clearQuota = provider => {
    const snap = readings.cached(provider);
    return snap.windows.length > 0 && snap.windows.every(row => {
      const resource = {used_micro:Math.ceil(row.used_pct*1e6),uncertainty_micro:1e6,observed_at:row.observed_at,max_rate_pct_per_hour:row.max_rate_pct_per_hour};
      // A two-dollar job's full exposure is a conservative call bound here.
      const worst = provider === 'codex' ? 2*135700 : row.window_minutes > 300 ? 2*534900 : 2*1583100;
      return clock.at < row.resets_at && clock.at >= row.observed_at &&
        resource.used_micro + resource.uncertainty_micro + readingAgeReserve(resource,clock.at) + worst < 100e6;
    });
  };
  return {source,probe,readings,refresh,clearQuota,failure,calls,extra,weeklyReset,shortReset,physical,
    week:provider => `${identities[provider]}:weekly:${weeklyReset(provider)}`,
    async assertCachedFailure(provider) {
      const before = readings.cached(provider);
      failure.add(provider);await probe.probe(provider);failure.delete(provider);
      assert.equal(probe.lastResult(provider).ok,false);
      assert.deepEqual(readings.cached(provider).windows,before.windows,'I3 real cache preserves good quota after failed probe');
    },
  };
}

function scriptedMeterLedger(directory,clock) {
  const file = join(directory,'scripted-provider-meters.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
  const snapshot = provider => {
    const windows = (saved[provider] ?? []).map(row => ({...row,
      owner_used_pct:row.used_pct, max_rate_pct_per_hour:20,
      state:row.resets_at <= clock.at ? 'unknown' : row.state}));
    return {read_at:windows.length ? Math.min(...windows.map(r => r.observed_at)) : null,windows};
  };
  return {snapshot,snapshotReadOnly:snapshot,recordReadings(provider,rows) {
    saved[provider] = structuredClone(rows);
    fs.writeFileSync(file,JSON.stringify(saved));
  }};
}
