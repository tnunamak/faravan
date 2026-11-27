import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLendingRuleState, mapRuleEpisode} from '../lib/v1/lending-rule-seam.mjs';
import {decide, adaptSeamV2} from '../lib/v1/rules/fluid-protection.mjs';
const H=3600000,M=1000000;
function input() {
  const now=1000*H, windows={},rows=[],entries=[];
  for(const [id,length] of [['weekly',168],['short',5]]) {
    const reset=now+length*H-H;
    windows[id]={kind:id,resetAtMs:reset,durationMs:length*H,usedMicro:3*M,committedMicro:0,pointsPerUsdMicro:M};
    rows.push({window_id:id,window_minutes:length*60,used_pct:3,resets_at:reset,observed_at:now,state:'open',lent_pct:3,reserved_pct:0});
    entries.push({account:'a',window_id:id,started_at:now-2,ended_at:now-1,resets_at:reset,lent_pts:3,attribution:'exact',represented_at:now});
  }
  return {now,windows,ruleDial:.75,job:{provider:'claude',model:'claude-sonnet-5-5',requestedUsdMicro:100000,nativeCostBounds:{unit:'usd',lower:0,upper:.1},wallMs:1,uncertaintyMs:0,stopMs:0},ruleEvidence:{quotaRegistry:{version:'synthetic/1',complete:true,limits:Object.entries(windows).map(([id,w])=>({id,provider:'claude',unit:'quota_percent',capacity:100,durationMs:w.durationMs,reset:{kind:'first-use'},scope:{kind:'account'},weights:{version:'synthetic/1',nativeUnit:'usd',byModel:{'claude-sonnet-5-5':w.pointsPerUsdMicro/M}}}))},snapshot:{account:'a',windows:rows},entries,history:[],applicableResources:{account:'a',provider:'claude',model:'claude-sonnet-5-5',complete:true,ids:['weekly','short']},roundingPoints:{weekly:0,short:0},lagBounds:Object.fromEntries(['weekly','short'].map(id=>[id,{providerLagMs:0,maxPointsPerHour:0,provenance:'Synthetic exact synchronous evidence'}]))}};
}
const episode=()=>({window_id:'weekly',start_at:0,resets_at:168*H,length_ms:168*H,complete:true,censored:false,source:'synthetic',rounding_points:0,metadata:{measurement:'exact'},trace:[[0,0],[168*H,10]]});
test('first settled loan: owner zero and borrower three remain valid total bounds',()=>{
 const s=buildLendingRuleState(input());for(const w of s.windows){assert.equal(w.owner_lo,0);assert.equal(w.owner_hi,0);assert.equal(w.total_lo,3);assert.equal(w.total_hi,3);assert.equal(w.borrower_settled_hi,3);assert.equal(w.borrower_represented_lo,3);assert.equal(w.used_lo,w.owner_lo);assert.equal(w.used_hi,w.owner_hi);}assert.equal(decide(s).admit,true);assert.ok(Math.abs(decide(s).lendable.short-17)<1e-9);assert.ok(Math.abs(decide(s).lendable.weekly-17)<1e-9);
});
test('rounding and lag precede subtraction; old owner aliases retain exact formulas',()=>{
 const p=input();p.ruleEvidence.roundingPoints.short=.5;p.ruleEvidence.lagBounds.short={providerLagMs:H,maxPointsPerHour:2,provenance:'synthetic'};
 const w=buildLendingRuleState(p).windows[1];assert.equal(w.total_lo,2.5);assert.equal(w.total_hi,5.5);assert.equal(w.owner_lo,0);assert.equal(w.owner_hi,2.5);assert.equal(w.used_lo,0);assert.equal(w.used_hi,2.5);
});
test('complete episode uses relative times and retains censor source rounding identity',()=>{
 const h=episode();h.start_at=500*H;h.resets_at=668*H;h.trace=[[500*H,0],[668*H,10]];h.censored=true;
 const r=mapRuleEpisode(h,1000*H);assert.equal(r.supported,true);assert.deepEqual(r.trace,[[0,0],[168,10]]);assert.equal(r.start_h,500);assert.equal(r.reset_h,668);assert.equal(r.censored,true);assert.equal(r.source,'synthetic');assert.equal(r.rounding_points,0);
});
test('missing metadata or absent endpoints remains unsupported, never zero-filled',()=>{
 for(const key of ['start_at','resets_at','length_ms','complete','censored','source','rounding_points','metadata']) {const h=episode();delete h[key];assert.equal(mapRuleEpisode(h,1000*H).supported,false,key);}
 const h=episode();h.trace=[[H,1],[168*H,10]];assert.equal(mapRuleEpisode(h,1000*H).supported,false);
 const p=input();p.ruleEvidence.history=[{window_id:'weekly',trace:[[H,10]]}];const s=buildLendingRuleState(p);assert.equal(s.history[0].supported,false);assert.deepEqual(adaptSeamV2(s).history,[]);
});
test('open import preserves reset identity without fabricating completion',()=>{
 const p=input(),h=episode();h.start_at=999*H;h.resets_at=1167*H;h.complete=false;h.source='import-open-window';h.trace=[[999*H,0],[1000*H,80]];p.ruleEvidence.history=[h];const s=buildLendingRuleState(p),a=adaptSeamV2(s);assert.equal(a.history.length,1);assert.equal(a.history[0].reset_h,1167);assert.deepEqual(a.history[0].trace,[[0,0],[1,80]]);assert.equal(decide(s).admit,false);
});
test('unsupported rounding and different episode duration are not candidate samples',()=>{
 const p=input(),h=episode();h.rounding_points=2;p.ruleEvidence.history=[h];assert.deepEqual(adaptSeamV2(buildLendingRuleState(p)).history,[]);
 h.rounding_points=0;h.length_ms=5*H;h.resets_at=5*H;h.trace=[[0,0],[5*H,10]];assert.deepEqual(adaptSeamV2(buildLendingRuleState(p)).history,[]);
});
test('inconsistent identity, future completion and decreasing use are unsupported',()=>{
 for(const edit of [h=>h.length_ms++,h=>h.resets_at=2000*H,h=>h.trace=[[0,0],[H,20],[168*H,10]]]){const h=episode();edit(h);assert.equal(mapRuleEpisode(h,1000*H).supported,false);}
});

test('R2 uses each window owner upper, its own rate and remaining reset time',()=>{
 const p=input();p.ruleEvidence.roundingPoints.short=.5;
 p.ruleEvidence.lagBounds.short={providerLagMs:H,maxPointsPerHour:2,maxPointsPerHourEvidenceClass:'measured',provenance:'synthetic measured rate'};
 p.ruleEvidence.lagBounds.weekly={providerLagMs:0,maxPointsPerHour:.1,maxPointsPerHourEvidenceClass:'measured',provenance:'synthetic measured rate'};
 const s=buildLendingRuleState(p),[week,short]=s.windows;
 assert.equal(week.owner_envelope_hi,16.7);
 assert.equal(short.owner_envelope_hi,10.5);
 assert.equal(short.owner_hi,2.5);
 assert.equal(short.total_hi,5.5);
 p.ruleEvidence.lagBounds.weekly.maxPointsPerHour=20;
 assert.equal(buildLendingRuleState(p).windows[0].owner_envelope_hi,100);
 assert.equal(adaptSeamV2(s).windows[1].owner_envelope_hi,10.5);
});
