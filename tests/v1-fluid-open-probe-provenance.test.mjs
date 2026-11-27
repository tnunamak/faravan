import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingHistory} from '../lib/v1/lending-history.mjs';
import {mapRuleEpisode} from '../lib/v1/lending-rule-seam.mjs';
import {adaptSeamV2, protection} from '../lib/v1/rules/fluid-protection.mjs';

const H=3600000, now=126*H, reset=168*H;
const window={id:'weekly',length_h:168,total_lo:0,total_hi:100,borrower_settled_hi:0};
const adapt=history=>adaptSeamV2({windows:[window],history}).history;
const protect=(history,options={})=>protection(history,'weekly',168,.5,
  {reset_h:168,elapsed:126,owner:0,later:25,...options});
const charge=(patch={})=>({account:'claude',window_id:'weekly',
  started_at:now-2,ended_at:now-1,resets_at:reset,lent_pts:80,
  lent_lower_pts:0,attribution:'estimated',represented_at:now,...patch});
function recorded(t,{entries=[],rounding=0,measurement='exact',used=80,evidence=true,coverage={},ledgerError=false}={}) {
  const home=mkdtempSync(join(tmpdir(),'open-probe-provenance-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const history=createLendingHistory({home,account:'claude',ledger:{entries:()=>{
    if(ledgerError)throw new Error('Synthetic ledger unavailable');return entries;
  }},now:()=>now});
  for(const [at,value] of [[0,0],[now,used]]) history.record({
    window_id:'weekly',window_minutes:10080,resets_at:reset,
    observed_at:at,used_pct:value,state:'open',source:'probe',
    rounding_points:rounding,metadata:{measurement},
    // Authored complete synthetic world, not a production inference from entries().
    ...(evidence ? {borrower_upper_bound:{complete:true,account:'claude',window_id:'weekly',
      resets_at:reset,observed_at:at,upper_points:Array.isArray(entries)
        ? entries.reduce((sum,row)=>sum+(row?.lent_pts??0),0) : 0,
      provenance:'Synthetic complete borrower spend, including active/unrecorded work.',...coverage}} : {}),
    censoring:{complete:true,limit_reached:false,owner_refused:false,owner_deferred:false}});
  const raw=history.ownerTraces(),mapped=raw.map(row=>mapRuleEpisode(row,now)),adapted=adapt(mapped);
  return {raw,mapped,adapted,history,home};
}
function observed(t,options) {
  const {raw,mapped,adapted}=recorded(t,options);
  assert.equal(mapped[0].supported,true);
  assert.equal(mapped[0].open,true);
  assert.equal(adapted.length,options?.evidence===false?0:1);
  const out=protect(adapted);
  assert.equal(out.n,0);
  return {raw,mapped,adapted,out};
}

test('OPEN probe upper-only borrower attribution must not become owner lower evidence',t=>{
  const {out}=observed(t,{entries:[charge()],evidence:false});
  // All 80 metered points may be borrower spend: proven owner lower is zero.
  assert.equal(out.imported,0);
});
test('half-point rounded OPEN probe must subtract its absolute error for lower evidence',t=>{
  const {out}=observed(t,{rounding:.5,measurement:'rounded-nearest',evidence:false});
  // Meter 80 with absolute error .5 allows true owner use 79.5.
  assert.ok(out.imported<=79.5,`invalid lower bound ${out.imported} > 79.5`);
});
test('proven borrower-free rounded probe imports exactly the corrected lower observation',t=>{
  const {out}=observed(t,{rounding:.5,measurement:'rounded-nearest'});
  assert.equal(out.imported,79.5);
});
test('owner lower trace subtracts borrower upper and rounding without reinterpreting the upper trace',t=>{
  const {raw,mapped,out}=observed(t,{entries:[charge({lent_pts:30,lent_lower_pts:5})],
    rounding:.5,measurement:'rounded-nearest'});
  assert.deepEqual(raw[0].trace,[[0,0],[now,75]]);
  assert.deepEqual(raw[0].owner_lower_trace,[[0,0],[now,49.5]]);
  assert.deepEqual(mapped[0].trace,[[0,0],[126,75]]);
  assert.deepEqual(mapped[0].owner_lower_trace,[[0,0],[126,49.5]]);
  assert.equal(out.imported,49.5);
});
test('unrepresented borrower upper debit is still subtracted for owner lower evidence',t=>{
  const {raw,out}=observed(t,{entries:[charge({lent_pts:30,lent_lower_pts:30,attribution:'exact',represented_at:null})]});
  assert.equal(raw[0].trace.at(-1)[1],80);
  assert.equal(out.imported,50);
});
test('an overlapping not-yet-ended borrower debit cannot inflate owner lower evidence',t=>{
  const {out}=observed(t,{entries:[charge({lent_pts:30,ended_at:now+1,represented_at:null})]});
  assert.equal(out.imported,50);
});
test('OPEN probes without separate lower provenance are excluded, not completed samples',t=>{
  const {raw,mapped}=observed(t);
  delete raw[0].owner_lower_trace;
  const legacy=mapRuleEpisode(raw[0],now);
  assert.equal(legacy.supported,true);
  assert.deepEqual(adapt([legacy]),[]);
  const direct={...mapped[0]};delete direct.owner_lower_trace;
  assert.equal(protect([direct]).imported,0);
  assert.equal(protect([direct]).n,0);
});
test('unknown borrower or rounding evidence cannot create a lower trace',t=>{
  for(const options of [{entries:null},{ledgerError:true},{entries:[charge({lent_pts:NaN})]},
    {entries:[charge({resets_at:null})]},{rounding:null},{rounding:NaN}]) {
    const {raw,adapted}=recorded(t,options);
    assert.equal(raw.length,1);
    assert.equal(Object.hasOwn(raw[0],'owner_lower_trace'),false);
    assert.deepEqual(adapted,[]);
    assert.equal(protect(adapted).n,0);
  }
});
test('legacy rows without lower evidence retain idempotent duplicate recording',t=>{
  const {history,home}=recorded(t,{evidence:false});
  const file=join(home,'v1','lending-history-claude.json');
  const data=JSON.parse(readFileSync(file,'utf8'));
  for(const row of data.readings)delete row.ownerLowerUsagePct;
  writeFileSync(file,JSON.stringify(data));
  const result=history.record({window_id:'weekly',window_minutes:10080,resets_at:reset,
    observed_at:now,used_pct:80,state:'open',source:'probe',rounding_points:0,
    metadata:{measurement:'exact'},censoring:{complete:true,limit_reached:false,owner_refused:false,owner_deferred:false}});
  assert.deepEqual(result,{recorded:false,known:true,reason:null});
  const raw=history.ownerTraces();
  assert.deepEqual(raw[0].trace,[[0,0],[now,80]]);
  assert.equal(Object.hasOwn(raw[0],'owner_lower_trace'),false);
  assert.deepEqual(adapt(raw.map(row=>mapRuleEpisode(row,now))),[]);
});
test('complete borrower upper evidence must be finite and bound to account, window, reset and receipt',t=>{
  for(const coverage of [{complete:false},{account:'codex'},{window_id:'short'},
    {resets_at:reset+1},{observed_at:now+1},{upper_points:-1},{upper_points:Infinity},
    {upper_points:NaN},{provenance:''},{provenance:null}]) {
    const {raw,adapted}=recorded(t,{coverage});
    assert.equal(Object.hasOwn(raw[0],'owner_lower_trace'),false);
    assert.deepEqual(adapted,[]);
  }
  const {out}=observed(t,{coverage:{upper_points:80}});
  assert.equal(out.imported,0,'active/unrecorded spend can exhaust an otherwise empty ledger reading');
  const contradictory=recorded(t,{entries:[charge({lent_pts:30,lent_lower_pts:30})],coverage:{upper_points:20}});
  assert.deepEqual(contradictory.adapted,[],'upper evidence cannot contradict represented borrower lower debit');
});
test('malformed or misaligned lower provenance cannot be admitted through the mapper or directly',t=>{
  const {raw,mapped}=observed(t);
  for(const lower of [null,[],[[0,0],[126,81]],[[0,0],[127,79]],
    [[0,1],[126,79]],[[0,0],[126,-1]],[[0,0],[126,NaN]],[[0,0],[126,Infinity]]]) {
    const direct={...mapped[0],owner_lower_trace:lower};
    assert.deepEqual(adapt([direct]),[]);
    assert.equal(protect([direct]).imported,0);
    assert.equal(protect([direct]).n,0);
    const absolute=Array.isArray(lower)?lower.map(p=>[p[0]*H,p[1]]):lower;
    assert.deepEqual(adapt([mapRuleEpisode({...raw[0],owner_lower_trace:absolute},now)]),[]);
  }
});
test('same reset and already-elapsed observations remain required for lower evidence',t=>{
  const {mapped:[h]}=observed(t);
  for(const [episode,options] of [[{...h,reset_h:0},{}],[h,{elapsed:125}],
    [{...h,trace:[[0,0],[127,80]],owner_lower_trace:[[0,0],[127,80]]},{}]]) {
    const out=protect([episode],options);
    assert.equal(out.n,0);assert.equal(out.imported,0);
  }
  assert.equal(protect([h],{elapsed:126}).imported,80);
});
test('duplicate OPEN lower observations combine by maximum, never sum, with current owner use',t=>{
  const {mapped:[h]}=observed(t,{entries:[charge({lent_pts:30})]});
  const stronger={...h,owner_lower_trace:[[0,0],[126,60]]};
  const out=protect([h,h,stronger]);
  assert.equal(out.imported,60);assert.equal(out.owner,60);assert.equal(out.n,0);
  assert.equal(protect([h,stronger],{owner:70}).owner,70);
});
test('OPEN probe source and unobserved tail remain intact with no fabricated endpoint',t=>{
  const {raw,mapped:[h],out}=observed(t);
  assert.equal(raw[0].source,'probe');assert.equal(h.source,'probe');
  assert.equal(h.complete,false);assert.equal(h.open,true);assert.equal(h.tail_unobserved_h,42);
  assert.deepEqual(h.trace,[[0,0],[126,80]]);
  assert.deepEqual(h.owner_lower_trace,[[0,0],[126,80]]);
  assert.equal(out.imported,80);assert.equal(out.n,0);
});
test('unknown OPEN sources stay excluded and the legacy import path is unchanged',t=>{
  const {mapped:[h]}=observed(t);
  assert.deepEqual(adapt([{...h,source:'unknown'}]),[]);
  const imported={...h,source:'import-open-window'};delete imported.owner_lower_trace;
  assert.equal(adapt([imported]).length,1);
  assert.equal(protect(adapt([imported])).imported,80);
  assert.equal(protect(adapt([imported])).n,0);
});
test('completed probes still train without needing OPEN lower provenance',()=>{
  const h={window_id:'weekly',supported:true,complete:true,open:false,censored:false,source:'probe',
    length_h:168,reset_h:0,rounding_points:0,metadata:{measurement:'exact'},trace:[[0,0],[168,10]]};
  const out=protect(adapt([h]));
  assert.equal(out.n,1);assert.equal(out.imported,0);
});
test('adapter and protection do not mutate either bound trace',t=>{
  const {mapped}=observed(t,{rounding:.5,measurement:'rounded-nearest'});
  const before=structuredClone(mapped);
  protect(adapt(mapped));
  assert.deepEqual(mapped,before);
});

// R1 of docs/reviews/open-probe-recheck-1027.md: invalid optional lower evidence is dropped, never fatal.
test('valid closed history survives a sparse optional lower trace',()=>{
  const closed={window_id:'weekly',start_at:0,resets_at:168*H,length_ms:168*H,
    complete:true,censored:false,source:'probe',rounding_points:0,
    metadata:{measurement:'exact'},trace:[[0,0],[168*H,10]]};
  assert.equal(mapRuleEpisode(closed,168*H).supported,true);
  const optional=new Array(2);optional[1]=[168*H,5];
  const mapped=mapRuleEpisode({...closed,owner_lower_trace:optional},168*H);
  assert.equal(mapped.supported,true);
  assert.equal(Object.hasOwn(mapped,'owner_lower_trace'),false);
  const h=adaptSeamV2({windows:[{id:'weekly',length_h:168}],history:[mapped]}).history;
  assert.equal(protection(h,'weekly',168,.5).n,1);
});
