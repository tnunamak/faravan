import './helpers/no-browser.mjs';
import {tempDir} from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {MEASUREMENT_MAX_AGE_MS, certifiedKappa, measureKappa} from '../lib/v1/lending-kappa-measure.mjs';
import {emptyTokens} from '../lib/v1/lending-meter.mjs';
const now = 1_800_000_000_000, day = 86400_000, ACCOUNT = 'a1b2c3d4e5f60718';
const attribution = {account_sha256_16:ACCOUNT, since:now - 60*day};
// A row the importer marked as paid by the plan (folder signed in to the lent account, no API key set up).
let rowId=0;
const row = (at, usd=1, account='claude', attributed_account=ACCOUNT) => ({account, provider:account, at, attributed_account, message_id:`msg_${++rowId}`,
  funding:'subscription', model:'claude-haiku-4-5-20251001', tokens:{...emptyTokens(),fresh_input:usd*1_000_000}});
const span = (i, points=3) => ({account:'claude', resource:'claude:seven_day', start_at:now-(i+1)*day,end_at:now-i*day,week_start:now-(i+1)*day,account_week_id:now-i*day,meter_points:points,end_points:50});
const base = () => ({account:'claude',resource:'claude:seven_day',now,attribution,
  meterPeriods:[0,1,2,3].map(i=>span(i)),usage:[0,1,2,3].map(i=>row(now-(i+.5)*day))});
// Each shown rise counts one more point (the meter's rounding), so a measurement is an upper bound.
test('the highest span rate, with one point of meter resolution per span',()=>{
  // Span 0 has $3 of logged use for 3+1 points; the others $1 each. Uncounted use only lowers a span, so the highest wins.
  const x=base();x.usage[0]=row(now-.5*day,3);
  assert.equal(measureKappa(x).upper_micro,Math.ceil(4/1*1e6));
  assert.equal(measureKappa(x).provenance.resolution_points,1);
  assert.equal(measureKappa(x).provenance.method,'max-span/8-weeks');
});
test('a per-model meter is priced only by that model family, and a meter of unknown scope is never measured',()=>{
  const model=(r,m)=>({...r,model:m});
  const x={...base(),resource:'claude:seven_day_sonnet',meterPeriods:[],
    usage:[model(row(now-.5*day),'claude-sonnet-4-5'),model(row(now-.5*day,2),'claude-opus-4-5')],
    currentWindows:[{account:'claude',resource:'claude:seven_day_sonnet',start_at:now-day,observed_at:now,meter_points:3}]};
  // Sonnet: $3 at list price per million input tokens, so 1M tokens is $3; (3+1) points over $3. Opus use is not counted.
  assert.equal(measureKappa(x).upper_micro,Math.ceil(4/3*1e6));
  assert.equal(measureKappa({...x,resource:'claude:seven_day_opus',
    currentWindows:[{...x.currentWindows[0],resource:'claude:seven_day_opus'}]}).upper_micro,Math.ceil(4/10*1e6));
  assert.equal(measureKappa({...base(),resource:'claude:seven_day_oauth_apps',
    meterPeriods:base().meterPeriods.map(p=>({...p,resource:'claude:seven_day_oauth_apps'}))}),null);
  assert.equal(measureKappa({...base(),account:'codex',resource:'codex:codex:other:10080'}),null);
  for (const resource of ['claude:seven_day_overage_included','claude:seven_day_future'])
    assert.equal(measureKappa({...base(),resource,meterPeriods:base().meterPeriods.map(p=>({...p,resource}))}),null,resource);
});
test('under-three-point spans are ignored',()=>{
  const x=base();x.meterPeriods[0].meter_points=2.99;
  assert.equal(measureKappa(x),null);
});
test('eight-week cutoff rejects crossing spans',()=>{
  const x=base();x.meterPeriods[0].start_at=now-57*day;
  assert.equal(measureKappa(x),null);
});
test('fewer than four spans use current-window reading, plus one point',()=>{
  const x=base();x.meterPeriods.pop();x.currentWindows=[{...span(0,6),observed_at:now}];
  assert.equal(measureKappa(x).upper_micro,7_000_000);
  assert.equal(measureKappa(x).provenance.label,'measured from your usage');
  assert.deepEqual(measureKappa(x).binding,attribution);
});
test('no measurement and no seed: no logs give no rate',()=>{
  assert.equal(measureKappa({...base(),usage:[]}),null);
  assert.equal(measureKappa({...base(),usage:[],fallback:{upper_micro:534900,provenance:{method:'bound'}}}),null);
});
test('without an attribution nothing is measured',()=>{
  assert.equal(measureKappa({...base(),attribution:null}),null);
  assert.equal(measureKappa({...base(),attribution:{account_sha256_16:ACCOUNT}}),null);
});
test('use from another account folder never prices this meter',()=>{
  const x=base();x.usage=x.usage.map(r=>({...r,attributed_account:'ffffffffffffffff'}));
  assert.equal(measureKappa(x),null);
  x.usage=x.usage.map(r=>({...r,attributed_account:null}));
  assert.equal(measureKappa(x),null);
});
test('use before the attribution start never counts',()=>{
  const x={...base(),attribution:{account_sha256_16:ACCOUNT,since:now-2*day}};
  // Only the two newest rows count, so only two spans are priced: too few for a ratio of sums.
  assert.equal(measureKappa(x),null);
  // A window opened before the start keeps all its points but prices only the use since: the rate only rises.
  x.currentWindows=[{...span(0,6),start_at:now-3*day,observed_at:now}];
  assert.equal(measureKappa(x).upper_micro,Math.ceil(7/2*1e6));
});
test('previous estimate requires exact account, window and binding',()=>{
  const previous={account:'claude',resource:'claude:seven_day',upper_micro:100,binding:attribution,expires_at:now+day};
  const x={...base(),meterPeriods:[],previous:{...previous,account:'other'}};
  assert.equal(measureKappa(x),null);
  x.previous=previous;assert.equal(measureKappa(x).upper_micro,100);
  x.previous={...previous,binding:{...attribution,since:attribution.since+1}};assert.equal(measureKappa(x),null);
  x.previous={...previous,binding:undefined};assert.equal(measureKappa(x),null);
  // An expired or undated measurement is never kept, whatever the meter shows now.
  x.previous={...previous,expires_at:now};assert.equal(measureKappa(x),null);
  x.previous={...previous,expires_at:undefined};assert.equal(measureKappa(x),null);
});
test('duplicate spans and other accounts do not contribute',()=>{
  const x=base();x.meterPeriods.push(span(0));x.usage.push(row(now-.5*day,100,'other'));
  assert.equal(measureKappa(x).upper_micro,4_000_000);
  assert.equal(measureKappa(x).provenance.spans,4);
});

test('history importer publishes the measured conversion before pricing imported history',async()=>{
 const {importLendingHistory}=await import('../lib/v1/lending-history-import.mjs');
 const x=base(), estimates=[];
 importLendingHistory({consent:true,now,meterPeriods:x.meterPeriods,
   logAttribution:{roots:[{provider:'claude',path:'/logs/a',account_sha256_16:ACCOUNT,since:attribution.since}],
     providers:{claude:attribution}},
   loadSessionLogs:()=>[{provider:'claude',account:'claude',source:'/logs/a/p/s.jsonl',contents:'',
     parsed:{usage:x.usage.map(({attributed_account,...r})=>({...r,provider:'claude'})),malformedLines:0}}],
   onKappa:row=>estimates.push(row)});
 assert.equal(estimates.length,1);
 assert.equal(estimates[0].estimate.upper_micro,4_000_000);
 assert.deepEqual(estimates[0].estimate.binding,attribution);
});

test('calibration uses disjoint total-meter rises, not weekly peak owner scores',async()=>{
 const {createLendingHistory}=await import('../lib/v1/lending-history.mjs');
 const {createLocalLendingHistoryAdapter}=await import('../lib/v1/lending-history-import.mjs');
 const {mkdtempSync}=await import('node:fs');
 const home=tempDir('kappa-spans-');
 const ledger={entries:()=>[]};
 const history=createLendingHistory({home,account:'claude',ledger,now:()=>now});
 for(let i=0;i<=6;i++) history.record({window_id:'five_hour',window_minutes:300,
   used_pct:20+i,observed_at:now-(6-i)*60000,resets_at:now+60000,account_week_epoch:now+day,
   state:'open',censoring:{complete:true,limit_reached:false,owner_refused:false,owner_deferred:false}});
 const adapter=createLocalLendingHistoryAdapter({homeDir:home,ledger,now:()=>now});
 assert.equal(adapter.kappaPeriods.length,2);
 assert.deepEqual(adapter.kappaPeriods.map(p=>p.meter_points),[3,3]);
 assert.equal(adapter.kappaPeriods[0].end_at,adapter.kappaPeriods[1].start_at);
 console.log('scratch',home);
});

test('current-window fallback accepts two points over ten dollars before four historical spans',()=>{
 const x={...base(),meterPeriods:[],usage:[row(now-.5*day,10)],
   currentWindows:[{...span(0,2),observed_at:now}]};
 assert.equal(measureKappa(x)?.upper_micro,300000);
});

test('use not known to be paid by the plan never counts, even when every span holds it',()=>{
  // Each span: $1 of plan use and $99 of use paid another way. Counting the $99 would give (3+1)/100 points per dollar.
  const x=base();
  x.usage.push(...[0,1,2,3].map(i=>({...row(now-(i+.5)*day,99),funding:'unknown'})));
  assert.equal(measureKappa(x).upper_micro,4_000_000);
  // With only that use, there is nothing to measure: no rate, not a low one.
  x.usage=x.usage.filter(r=>r.funding!=='subscription');
  assert.equal(measureKappa(x),null);
});

test('a Codex event counts only for the account its session was signed in to',()=>{
  const codexAttribution={account_sha256_16:ACCOUNT,since:now-60*day};
  const codexRow=(i,creator)=>({account:'codex',provider:'codex',at:now-(i+.5)*day,attributed_account:ACCOUNT,funding:'subscription',
    message_id:`codex-session-s-${i}`,creator_account_sha256_16:creator,model:'gpt-6-sol',tokens:{...emptyTokens(),fresh_input:1_000_000}});
  const codexSpan=i=>({...span(i),account:'codex',resource:'codex:codex:10080'});
  const x={account:'codex',resource:'codex:codex:10080',now,attribution:codexAttribution,meterPeriods:[0,1,2,3].map(codexSpan),
    usage:[0,1,2,3].map(i=>codexRow(i,ACCOUNT))};
  assert.equal(measureKappa(x).upper_micro,2_000_000,'gpt-6-sol: $2 per span, (3+1)/2');
  x.usage.push(...[0,1,2,3].map(i=>({...codexRow(i,'ffffffffffffffff'),message_id:`codex-session-t-${i}`})));
  x.usage.push(...[0,1,2,3].map(i=>({...codexRow(i,null),message_id:`codex-session-u-${i}`})));
  assert.equal(measureKappa(x).upper_micro,2_000_000,'another sign-in or an unknown one adds no cost');
});

test('a meter at 100% is not measured: it stops counting while use goes on',()=>{
  const x=base();x.meterPeriods=x.meterPeriods.map((p,i)=>i===0?{...p,end_points:100}:p);
  // Three clean spans are fewer than four, so the current window decides; with none, there is no measurement.
  assert.equal(measureKappa(x),null);
  x.meterPeriods[0]={...x.meterPeriods[0],end_points:undefined};assert.equal(measureKappa(x),null,'an unknown end is not below 100');
  x.meterPeriods[0]={...x.meterPeriods[0],end_points:99};assert.equal(measureKappa(x).upper_micro,4_000_000);
  const y={...base(),meterPeriods:[],usage:[row(now-.5*day,10)]};
  y.currentWindows=[{...span(0,100),observed_at:now}];assert.equal(measureKappa(y),null);
});

test('a current window must be read, in the past, with finite points and cost',()=>{
  const y={...base(),meterPeriods:[],usage:[row(now-.5*day,10)]};
  const ok={...span(0,2),observed_at:now};
  for(const bad of [{observed_at:now+1},{observed_at:undefined},{observed_at:'not a date'},{meter_points:NaN},
    {meter_points:Infinity},{meter_points:0},{start_at:NaN}]){
    y.currentWindows=[{...ok,...bad}];assert.equal(measureKappa(y),null,JSON.stringify(bad));
  }
  y.currentWindows=[ok];assert.equal(measureKappa(y).upper_micro,300000);
  y.usage=[{...row(now-.5*day,10),model:'no-such-model'}];assert.equal(measureKappa(y),null,'unpriced use is no cost');
});

test('a measurement carries the time it expires: 8 weeks after the newest use it was made from',()=>{
  const x=base();const m=measureKappa(x);
  // The highest-rate span decides; all four rate the same, so the first found (span 0, ending now) is kept.
  assert.equal(m.evidence_end_at,now);
  assert.equal(m.expires_at,now+MEASUREMENT_MAX_AGE_MS);
  const y={...base(),meterPeriods:[],usage:[row(now-.5*day,10)],currentWindows:[{...span(0,2),observed_at:now-day/4}]};
  assert.equal(measureKappa(y).expires_at,now-.5*day+MEASUREMENT_MAX_AGE_MS);
  // A kept measurement keeps its own expiry: a new meter reading with no new evidence does not move it.
  const z={...base(),meterPeriods:[],usage:[],previous:m,now:now+MEASUREMENT_MAX_AGE_MS-1};
  assert.equal(measureKappa(z),m);
  z.now=now+MEASUREMENT_MAX_AGE_MS;assert.equal(measureKappa(z),null);
});

test('current-window expiry stays anchored to the newest priced in-window use as meter reads advance',()=>{
  const newest=now-.5*day;
  const x={...base(),meterPeriods:[],usage:[
    row(newest,1),row(now-.75*day,1),
    {...row(now-day/8,100),model:'no-such-model'},
    {...row(now-day/8,100),funding:'unknown'},
    row(now-2*day,100),row(now+1,100),
  ],currentWindows:[{...span(0,2),observed_at:now-day/4}]};
  const first=measureKappa(x);
  assert.equal(first.upper_micro,1_500_000,'only the two priced in-window subscription rows contribute');
  assert.equal(first.evidence_end_at,newest);
  assert.equal(first.expires_at,newest+MEASUREMENT_MAX_AGE_MS);
  x.currentWindows[0].observed_at=now;
  const later=measureKappa(x);
  assert.equal(later.evidence_end_at,newest);
  assert.equal(later.expires_at,first.expires_at,'a later meter read alone cannot renew evidence');
});

test('a non-finite now cannot produce a measurement',()=>{
  const completed=base();
  const current={...base(),meterPeriods:[],currentWindows:[{...span(0,2),observed_at:now}]};
  for(const invalidNow of [NaN,Infinity,-Infinity]){
    assert.equal(measureKappa({...completed,now:invalidNow}),null,String(invalidNow));
    assert.equal(measureKappa({...current,now:invalidNow}),null,String(invalidNow));
  }
});


test('shipped calibration retains its provenance after the source is removed',()=>{
 const bound=certifiedKappa({provider:'claude',plan:'max20',window:'weekly',model:'claude-haiku-5-5'});
 assert.equal(bound.upper_micro,534900);
 assert.equal(typeof bound.provenance.acceptedBy,'string');
 assert.equal(certifiedKappa({provider:'missing'}),null);
});
