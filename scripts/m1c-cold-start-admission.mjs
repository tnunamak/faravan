// Offline reproduction of the authored M1(c) fixture at the pinned base.
// No provider pricing lookup; all labels share its 1 point/USD conversion.
import assert from 'node:assert/strict';
import {buildLendingRuleState, evaluateLendingRule} from '../lib/v1/lending-rule-seam.mjs';
import {decide, protection, adaptSeamV2} from '../lib/v1/rules/fluid-protection.mjs';
const M=1_000_000,H=3_600_000,START=1_800_000_000_000,Q=100;
const IDS=['seven_day','five_hour'];
const jobs=[['Haiku',1.32],['Sonnet',5.28],['Opus',10.56]];
function input(dial,worst){
  const now=START+.5*H;
  const windows=Object.fromEntries(IDS.map((id,i)=>[id,{kind:i?'short':'weekly',
    durationMs:(i?5:168)*H,usedMicro:0,committedMicro:0,uncertaintyMicro:0,
    pointsPerUsdMicro:M,resetAtMs:i?now+3*H:START+168*H,known:true,fresh:true,compatible:true}]));
  const rows=IDS.map(id=>({window_id:id,window_minutes:windows[id].durationMs/60_000,
    used_pct:0,resets_at:windows[id].resetAtMs,observed_at:now,state:'open',lent_pct:0,reserved_pct:0}));
  return {now,observedAt:now,windows,weeklyResource:'seven_day',
    gates:{consent:true,limits:true,funding:true,stopping:true},laterBurnCapacityMicro:0,ruleDial:dial,
    ruleEvidence:{snapshot:{account:'claude',windows:rows},entries:[],history:[],
      applicableResources:{account:'claude',provider:'claude',model:'claude-haiku-5-5',complete:true,ids:IDS},
      roundingPoints:{seven_day:0,five_hour:0},
      lagBounds:Object.fromEntries(IDS.map(id=>[id,{providerLagMs:0,maxPointsPerHour:0,provenance:'Synthetic synchronous bounded fixture.'}]))},
    job:{provider:'claude',model:'claude-haiku-5-5',wallMs:60_000,uncertaintyMs:1000,stopMs:1000,
      estimateUsdMicro:20*M,requestedUsdMicro:20*M,worstCallUsdMicro:Math.round(worst*M),friendValue:1}};
}
const rows=[];
for(const dial of [.05,.1,.2,.5,1])for(const [model,worst]of jobs){
  const args=input(dial,worst),s=buildLendingRuleState(args),c=adaptSeamV2(s);
  const actual=evaluateLendingRule(args,decide);
  const capRule=t=>({admit:t.windows.every(w=>t.job.gross[w.id]<=Q*t.dial
      &&t.now_h+t.job.duration_h<=w.reset_h),
    lendable:Object.fromEntries(t.windows.map(w=>[w.id,Math.min(Q,Q*t.dial)])),
    reason:'Cold fixture cap-only comparison; not a replacement production rule.'});
  const capOnly=evaluateLendingRule(args,capRule);
  const limits=c.windows.map(w=>{
    const elapsed=Math.max(0,Math.min(w.length_h,w.length_h-(w.reset_h-c.now_h)));
    const later=Q*(1-elapsed/w.length_h),owner=Math.max(0,w.used_lo-w.borrower_used);
    const p=protection(c.history,w.id,w.length_h,dial,{owner,later,reset_h:w.reset_h,elapsed});
    assert.ok(Math.abs(actual.lendableMicro[w.id]/M-p.envelope)<1e-6);
    const binding=p.optimum>p.startup?'two-stage optimum':'startup';
    return {id:w.id,gross:s.job.gross[w.id],K:0,B:dial*Q,cap:dial*Q,later,
      optimum:p.optimum,startup:p.startup,proposal:Math.max(p.optimum,p.startup),
      lendable:actual.lendableMicro[w.id]/M,binding,
      fits:s.job.gross[w.id]<=actual.lendableMicro[w.id]/M,
      capProposal:dial*Q,capLendable:capOnly.lendableMicro[w.id]/M,
      capFits:s.job.gross[w.id]<=capOnly.lendableMicro[w.id]/M,
      minimumCapDial:s.job.gross[w.id]/Q};
  });
  assert.equal(actual.admitted,false);
  assert.equal(capOnly.admitted,dial>=.2);
  rows.push({dial,model,grossUsd:20,nativeBudgetUsd:20-worst,limits,
    admitted:actual.admitted,capAdmitted:capOnly.admitted,
    minimumCapDial:Math.max(...limits.map(w=>w.minimumCapDial))});
}
if(process.argv.includes('--json'))console.log(JSON.stringify(rows,null,2));
else{
 const f=n=>Number(n.toFixed(6)),pair=(r,key)=>r.limits.map(w=>f(w[key])).join(' / ');
 console.log('| Dial | Job | Gross W/S | Cap W/S | Optimum W/S | Startup W/S | Proposal W/S | Lendable W/S | Actual | Blocking limits (allowance term) | Cap proposal = lendable W/S | Cap-only |');
 console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
 for(const r of rows)console.log('| '+[r.dial,r.model,pair(r,'gross'),pair(r,'cap'),pair(r,'optimum'),
 pair(r,'startup'),pair(r,'proposal'),pair(r,'lendable'),r.admitted?'admit':'hold',
 r.limits.filter(w=>!w.fits).map(w=>(w.id==='seven_day'?'W':'S')+': '+w.binding).join('; '),
 pair(r,'capLendable'),r.capAdmitted?'admit':'hold'].join(' | ')+' |');
 console.log('\nSmallest cap-only dial for every named job: '+rows[0].minimumCapDial+' (both limits).');
}
