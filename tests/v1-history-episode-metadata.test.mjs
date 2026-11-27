import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingHistory} from '../lib/v1/lending-history.mjs';
import {mapRuleEpisode} from '../lib/v1/lending-rule-seam.mjs';
const H=3_600_000, W=168*H, START=1_800_000_000_000;
const clean={complete:true,limit_reached:false,owner_refused:false,owner_deferred:false};
function setup(t, now=START+2*W) {
  const home=mkdtempSync(join(tmpdir(),'history-episode-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const history=createLendingHistory({home,account:'claude',ledger:{entries:()=>[]},now:()=>now});
  const record=(at,used,reset=START+W,extra={})=>history.record({window_id:'seven_day',
    window_minutes:10080,resets_at:reset,observed_at:at,used_pct:used,state:'open',
    source:'probe',rounding_points:0,metadata:{measurement:'exact'},censoring:clean,...extra});
  return {history,record,file:join(home,'v1','lending-history-claude.json'),now};
}
test('truly observed complete week maps supported; pre-reset tail is never called complete',t=>{
  // Pure seam evidence can have a true endpoint. Normal meter ingestion cannot attest one.
  const complete={window_id:'seven_day',start_at:START,resets_at:START+W,length_ms:W,
    complete:true,censored:false,source:'synthetic-observed-endpoint',rounding_points:0,
    metadata:{measurement:'exact'},trace:[[START,0],[START+W,10]]};
  assert.equal(mapRuleEpisode(complete,START+W).supported,true);
  const {history,record,now}=setup(t);
  record(START,0);record(START+W-H,10);
  const row=history.ownerTraces()[0], mapped=mapRuleEpisode(row,now);
  assert.equal(row.complete,false);assert.equal(mapped.open,true);
  assert.equal(mapped.supported,true);assert.equal(mapped.tail_unobserved_h,1);
  assert.deepEqual(mapped.trace,[[0,0],[167,10]]);
});
test('censored week has named unsupported reason and no usable trace',t=>{
  const {history,record,now}=setup(t);record(START,0);record(START+H,10);
  record(START+2*H,11,START+W,{censoring:{...clean,owner_refused:true}});
  const raw=history.ownerTraces()[0], mapped=mapRuleEpisode(raw,now);
  assert.equal(raw.censored,true);assert.deepEqual(raw.trace,[]);
  assert.equal(mapped.supported,false);assert.ok(mapped.unsupported.includes('account_week_censored'));
});
test('open week without observed zero start is unsupported, not zero-filled',t=>{
  const {history,record,now}=setup(t,START+3*H);record(START+H,2);record(START+2*H,3);
  const row=mapRuleEpisode(history.ownerTraces()[0],now);
  assert.equal(row.open,true);assert.equal(row.supported,false);
  assert.ok(row.unsupported.includes('trace endpoints'));
  assert.deepEqual(row.trace,[[1,2],[2,3]]);assert.equal(row.tail_unobserved_h,166);
});
test('old persisted row without metadata stays unsupported after reload',t=>{
  const {history,record,file,now}=setup(t);record(START,0);record(START+H,2);
  const saved=JSON.parse(readFileSync(file,'utf8'));
  for(const row of saved.readings)delete row.episode;
  writeFileSync(file,JSON.stringify(saved));
  const raw=history.ownerTraces()[0], mapped=mapRuleEpisode(raw,now);
  assert.equal(raw.start_at,null);assert.equal(raw.rounding_points,null);
  assert.equal(mapped.supported,false);assert.ok(mapped.unsupported.includes('source'));
  assert.ok(mapped.unsupported.includes('rounding_points'));
  assert.ok(mapped.unsupported.includes('metadata.measurement'));
});
test('reset-relative times and tail gaps stay separate across two resets',t=>{
  const {history,record,now}=setup(t);
  record(START,0);record(START+W-H,10);
  record(START+W,0,START+2*W);record(START+W+2*H,3,START+2*W);
  const rows=history.ownerTraces().map(row=>mapRuleEpisode(row,now));
  assert.deepEqual(rows.map(row=>row.trace),[[[0,0],[167,10]],[[0,0],[2,3]]]);
  assert.deepEqual(rows.map(row=>row.start_h),[START/H,START/H+168]);
  assert.deepEqual(rows.map(row=>row.reset_h),[START/H+168,START/H+336]);
  assert.deepEqual(rows.map(row=>row.tail_unobserved_h),[1,166]);
  assert.ok(rows.every(row=>row.supported && row.open));
});
test('missing and conflicting provenance never acquire exact defaults',t=>{
  const {history,record,now}=setup(t);record(START,0);
  record(START+H,2,START+W,{rounding_points:undefined});
  const row=mapRuleEpisode(history.ownerTraces()[0],now);
  assert.equal(row.supported,false);assert.equal(row.rounding_points,null);
  assert.ok(row.unsupported.includes('rounding_points'));
});
test('normal exact-reset meter reading remains a rejected rollover, never a completion',t=>{
  const {history,record}=setup(t);record(START,0);record(START+W-H,10);
  const result=record(START+W,11);
  assert.equal(result.known,false);assert.equal(result.reason,'rollover_reading');
  const row=history.ownerTraces()[0];assert.equal(row.complete,false);
  assert.deepEqual(row.trace,[[START,0],[START+W-H,10]]);
  assert.equal(row.tail_unobserved_ms,H);
});
