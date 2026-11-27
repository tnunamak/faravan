import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';


// Independent provider-world controls. Integer micro-points only; these helpers
// never call the candidate policy. A request and a provider result are distinct.
const ORACLE_POINT = 1000000;
function providerWorld(used, {atomic = true} = {}) {
  return {used: {...used}, held: Object.fromEntries(Object.keys(used).map(k=>[k,0])),
    attempts: new Map(), fence: 1, atomic, events: []};
}
function oracleEvent(world, event) {
  const previous=world.events.at(-1);
  assert.ok(!previous || event.at>previous.at || event.at===previous.at&&event.sequence>previous.sequence);
  world.events.push(Object.freeze(structuredClone(event)));
}
function oracleReserve(world,id,cost,fence) {
  if(fence!==world.fence || world.attempts.has(id))return false;
  if(Object.keys(world.used).some(k=>!Number.isSafeInteger(cost[k])||cost[k]<0||
    world.used[k]+world.held[k]+cost[k]>100*ORACLE_POINT))return false;
  for(const k of Object.keys(world.used))world.held[k]+=cost[k];
  world.attempts.set(id,{remaining:{...cost},fence,ended:false,cancelled:false});return true;
}
function oracleBurn(world,id,cost,fence) {
  const a=world.attempts.get(id);
  if(!a||a.ended||fence!==world.fence||a.fence!==fence)return false;
  if(Object.keys(world.used).some(k=>!Number.isSafeInteger(cost[k])||cost[k]<0||cost[k]>a.remaining[k]))return false;
  for(const k of Object.keys(world.used)){world.used[k]+=cost[k];world.held[k]-=cost[k];a.remaining[k]-=cost[k];}
  return true;
}
function oracleCancel(world,id) { const a=world.attempts.get(id);if(a)a.cancelled=true; }
function oracleAck(world,id,fence) {
  const a=world.attempts.get(id);if(!a||a.ended||fence!==world.fence||a.fence!==fence)return false;
  for(const k of Object.keys(world.used))world.held[k]-=a.remaining[k];
  a.ended=true;return true;
}
function oracleOwner(world,cost) {
  const available=Object.keys(cost).map(k=>Math.max(0,100*ORACLE_POINT-world.used[k]-world.held[k]));
  const ratio=world.atomic?(Object.keys(cost).every((k,i)=>available[i]>=cost[k])?1:0):
    Math.min(1,...Object.keys(cost).map((k,i)=>cost[k]===0?1:available[i]/cost[k]));
  for(const k of Object.keys(cost))world.used[k]+=cost[k]*ratio;
  return Object.values(cost)[0]*ratio;
}
function oracleSlack(world,key,reserve,margin) {return 100*ORACLE_POINT-world.used[key]-world.held[key]-reserve-margin;}

test('independent G02 keeps denied atomic demand and divisible loss in separate worlds',()=>{
  const baseline=providerWorld({week:94*ORACLE_POINT}),actual=providerWorld({week:99*ORACLE_POINT});
  assert.notEqual(baseline.used,actual.used);
  assert.equal(oracleOwner(baseline,{week:2*ORACLE_POINT}),2*ORACLE_POINT);
  assert.equal(oracleOwner(actual,{week:2*ORACLE_POINT}),0);
  const b=providerWorld({week:94*ORACLE_POINT},{atomic:false}),a=providerWorld({week:99*ORACLE_POINT},{atomic:false});
  assert.equal(oracleOwner(b,{week:2*ORACLE_POINT})-oracleOwner(a,{week:2*ORACLE_POINT}),ORACLE_POINT);
  // A wrong control that aliases worlds cannot satisfy the independent baseline.
  assert.throws(()=>assert.equal(oracleOwner(actual,{week:2*ORACLE_POINT}),2*ORACLE_POINT));
  assert.throws(()=>assert.equal(2*ORACLE_POINT-0,0),'dropping denied owner demand hides loss');
});
test('independent G04 vector reserve is atomic in both arrival orders and fences settle',()=>{
  for(const ids of [['a','b'],['b','a']]){
    const w=providerWorld({week:90*ORACLE_POINT,short:0});
    assert.equal(oracleReserve(w,ids[0],{week:6*ORACLE_POINT,short:6*ORACLE_POINT},1),true);
    assert.equal(oracleReserve(w,ids[1],{week:6*ORACLE_POINT,short:6*ORACLE_POINT},1),false);
    assert.equal(oracleSlack(w,'week',0,0),4*ORACLE_POINT);
    assert.equal(oracleReserve(w,'stale',{week:ORACLE_POINT,short:ORACLE_POINT},0),false);
    assert.equal(oracleAck(w,ids[0],0),false);
    assert.equal(w.held.week,6*ORACLE_POINT);
    assert.throws(()=>assert.equal(100*ORACLE_POINT-w.used.short-w.held.short<6*ORACLE_POINT,true),
      'scalar short-only admission would accept the second request');
  }
});
test('independent G05 burn conserves slack; cancellation and crash are not refunds',()=>{
  const w=providerWorld({week:20*ORACLE_POINT});
  assert.equal(oracleReserve(w,'job',{week:6*ORACLE_POINT},1),true);
  const slack=()=>oracleSlack(w,'week',69*ORACLE_POINT,ORACLE_POINT);
  assert.equal(slack(),4*ORACLE_POINT);
  assert.equal(oracleBurn(w,'job',{week:5*ORACLE_POINT},1),true);
  assert.equal(w.used.week,25*ORACLE_POINT);assert.equal(w.held.week,ORACLE_POINT);assert.equal(slack(),4*ORACLE_POINT);
  oracleCancel(w,'job');assert.equal(slack(),4*ORACLE_POINT);
  const crash=structuredClone(w);assert.equal(crash.held.week,ORACLE_POINT);
  assert.throws(()=>assert.equal(slack()+w.held.week,4*ORACLE_POINT),'cancel refund is a wrong control');
  assert.equal(oracleAck(w,'job',1),true);assert.equal(slack(),5*ORACLE_POINT);
  assert.equal(oracleAck(w,'job',1),false);assert.equal(slack(),5*ORACLE_POINT);
  assert.throws(()=>assert.equal(slack()+ORACLE_POINT,5*ORACLE_POINT),'duplicate refund is a wrong control');
});
test('independent opening clocks and useful completion preserve literal boundaries',()=>{
  const hour=3600000, baselineAnchor=0, actualAnchor=2*hour;
  const quiet=(attempts,t)=>!attempts.some(at=>at>t-5*hour&&at<=t);
  assert.notEqual(baselineAnchor,actualAnchor);
  assert.equal(quiet([0],2*hour),false);assert.equal(quiet([0],5*hour),true);
  const deadline=actualAnchor+5*hour-10*60000;
  assert.equal(deadline,6*hour+50*60000);
  assert.equal(actualAnchor+4*hour+50*60000<=deadline,true);
  assert.equal(actualAnchor+4*hour+50*60000+1<=deadline,false);
  const w=providerWorld({week:20*ORACLE_POINT});
  oracleEvent(w,{account:'synthetic',epoch:'one',window:'week/1',at:0,sequence:1,type:'reserve'});
  assert.equal(oracleReserve(w,'useful',{week:ORACLE_POINT},1),true);
  assert.equal(oracleBurn(w,'useful',{week:ORACLE_POINT},1),true);
  assert.equal(oracleAck(w,'useful',1),true);
  oracleEvent(w,{account:'synthetic',epoch:'one',window:'week/1',at:1,sequence:2,type:'completed'});
  assert.equal(w.used.week,21*ORACLE_POINT);assert.equal(w.held.week,0);
  assert.equal(Object.isFrozen(w.events[0]),true);
  assert.throws(()=>oracleEvent(w,{at:0,sequence:3,type:'future-observation-reordered'}));
});

// Chronological synthetic provider-world oracle. This block is deliberately
// independent of evaluateLending and the preceding legacy/helper tests.
// Units are integral fixture points; all computed fractions are exact rationals.
function cr(n, d = 1n) {
  n = BigInt(n); d = BigInt(d); assert.ok(d > 0n, 'positive denominator');
  let a = n < 0n ? -n : n, b = d;
  while (b) [a,b] = [b,a%b];
  return [String(n/(a||1n)), String(d/(a||1n))];
}
const cn = n => { assert.ok(Number.isSafeInteger(n) && n >= 0,'nonnegative integral amount'); return cr(n); };
const ca = (a,b) => cr(BigInt(a[0])*BigInt(b[1])+BigInt(b[0])*BigInt(a[1]),BigInt(a[1])*BigInt(b[1]));
const cs = (a,b) => ca(a,[-BigInt(b[0])+'',b[1]]);
const cm = (a,b) => cr(BigInt(a[0])*BigInt(b[0]),BigInt(a[1])*BigInt(b[1]));
const cd = (a,b) => { assert.ok(BigInt(b[0])>0n); return cr(BigInt(a[0])*BigInt(b[1]),BigInt(a[1])*BigInt(b[0])); };
const cc = (a,b) => { const d=BigInt(a[0])*BigInt(b[1])-BigInt(b[0])*BigInt(a[1]); return d<0n?-1:d>0n?1:0; };
const cz = () => cr(0);
const ct = a => a[1]==='1'?a[0]:a.join('/');
const cfreeze = o => { if(o && typeof o==='object') {Object.values(o).forEach(cfreeze);Object.freeze(o);}return o; };
const ccopy = o => JSON.parse(JSON.stringify(o));
function cvector(w,v) {
  assert.ok(v && typeof v==='object' && !Array.isArray(v),'vector');
  assert.deepEqual(Object.keys(v).sort(),Object.keys(w.resources).sort(),'complete vector');
  return Object.fromEntries(Object.entries(v).map(([k,n])=>[k,cn(n)]));
}
function cworld(f) {
  assert.ok(['atomic','divisible'].includes(f.service));
  assert.ok(f.resources.length>0);
  const resources={};
  for(const r of f.resources) {
    assert.ok(typeof r.id==='string' && r.id && !Object.hasOwn(resources,r.id),'unique resource');
    assert.ok(['open','unopened','unknown'].includes(r.state));
    assert.ok(['fixed','first-use'].includes(r.kind));
    if(r.kind==='first-use')assert.ok(Number.isSafeInteger(r.duration)&&r.duration>0);
    assert.ok(r.reset===null||Number.isSafeInteger(r.reset));
    resources[r.id]={...r,capacity:cn(r.capacity),used:cn(r.used),held:cz(),anchor:null};
  }
  return {provider:f.provider,account:f.account,epoch:f.epoch,week:f.week,mapping:true,fence:1,
    service:f.service,resources,attempts:{},requests:[],quietAttempts:[],tokens:{},seen:{},
    receipts:[],lastAt:-1,trace:[],quiet:f.quiet??null};
}
function cresources(w) {return Object.keys(w.resources);}
function cavailable(w,k) {const r=w.resources[k];return cs(cs(r.capacity,r.used),r.held);}
function cidentity(w,e) {return e.provider===w.provider&&e.account===w.account&&e.epoch===w.epoch&&e.fence===w.fence;}
function cinstance(w,e) {return cresources(w).every(k=>e.instances[k]===w.resources[k].instance);}
function cexpire(w,at,mutation) {
  for(const r of Object.values(w.resources)) if(r.state==='open'&&r.reset!==null&&at>=r.reset) {
    r.state='unknown'; // time alone is not a replacement observation.
    for(const a of Object.values(w.attempts)) if(!a.ended)a.unresolved=true;
    if(mutation==='reset-erased-hold') {r.held=cz();for(const a of Object.values(w.attempts))a.ended=true;}
  }
}
function copen(w,e,mutation,actual) {
  for(const [k,r] of Object.entries(w.resources)) if(r.state==='unopened'&&r.kind==='first-use') {
    r.anchor=mutation==='shared-anchor'&&actual?actual.resources[k].anchor:e.at;
    r.reset=r.anchor+r.duration;r.state='open';
  }
}
function cburn(w,a,e) {
  const next=cvector(w,e.cumulative);
  assert.ok(Number.isSafeInteger(e.meterSequence)&&e.meterSequence>=0,'meter sequence');
  if(e.meterSequence<a.meterSequence)return 'stale-meter';
  if(e.meterSequence===a.meterSequence) {
    assert.deepEqual(next,a.meter,'conflicting meter');return 'duplicate-meter';
  }
  for(const k of cresources(w)) assert.ok(cc(next[k],a.meter[k])>=0,'backward cumulative');
  for(const k of cresources(w)) {
    const delta=cs(next[k],a.meter[k]), r=w.resources[k];
    if(r.state==='unknown' || a.instances[k]!==r.instance) {
      a.unresolved=true; // attribution awaits authoritative reconciliation.
    } else {
      r.used=ca(r.used,delta);
      const release=cc(delta,a.remaining[k])>0?a.remaining[k]:delta;
      r.held=cs(r.held,release);a.remaining[k]=cs(a.remaining[k],release);
    }
  }
  a.meter=next;a.meterSequence=e.meterSequence;
  return 'burned'; // excess is charged, never silently capped to estimate.
}
function crelease(w,a,mutation) {
  if(a.ended && mutation!=='duplicate-refund')return 'duplicate-ack';
  const refund=a.ended?a.released:a.remaining;
  for(const k of cresources(w))w.resources[k].held=cs(w.resources[k].held,refund[k]);
  if(!a.ended) {a.released=ccopy(a.remaining);a.remaining=Object.fromEntries(cresources(w).map(k=>[k,cz()]));}
  a.ended=true;return 'completed';
}
function cstep(w,e,mutation,actual) {
  assert.ok(typeof e.event_id==='string'&&e.event_id && typeof e.attempt==='string'&&e.attempt,'identity');
  assert.ok(Number.isSafeInteger(e.at)&&e.at>=0&&Number.isSafeInteger(e.sequence)&&e.sequence>=0,'time/sequence');
  assert.ok(e.instances&&typeof e.instances==='object','instances');
  for(const key of ['provider','account','epoch'])assert.ok(typeof e[key]==='string'&&e[key],key);
  assert.ok(Number.isSafeInteger(e.fence)&&e.fence>=0,'fence');
  assert.deepEqual(Object.keys(e.instances).sort(),cresources(w).sort(),'instance dimensions');
  for(const value of Object.values(e.instances))assert.ok(typeof value==='string'&&value,'window instance');
  const encoded=JSON.stringify(e);
  if(Object.hasOwn(w.seen,e.event_id)) {assert.equal(w.seen[e.event_id],encoded,'conflicting event');return;}
  assert.ok(e.at>=w.lastAt,'backward event');w.lastAt=e.at;w.seen[e.event_id]=encoded;
  if(mutation!=='owner-before-reset'||e.type!=='OWNER_ATTEMPT')cexpire(w,e.at,mutation);
  let outcome='refused';
  if(e.type==='RESTART') {
    w.trace.push(cfreeze(ccopy(e)));w.receipts.push({id:e.event_id,outcome:'restart'});
    const restored=JSON.parse(JSON.stringify(w));restored.trace.forEach(cfreeze);return restored;
  }
  if(e.type==='FENCE'&&cidentity(w,e)) {assert.ok(Number.isSafeInteger(e.nextFence)&&e.nextFence>w.fence);w.fence=e.nextFence;outcome='fenced';}
  else if(e.type==='EPOCH'&&cidentity(w,e)) {
    assert.ok(typeof e.nextEpoch==='string'&&e.nextEpoch!==w.epoch);
    w.epoch=e.nextEpoch;w.mapping=e.mapping===true;
    if(e.newWeek!==undefined) {assert.ok(e.authoritative===true&&typeof e.newWeek==='string');w.week=e.newWeek;}
    for(const r of Object.values(w.resources))r.state='unknown';
    for(const a of Object.values(w.attempts))if(!a.ended)a.unresolved=true;
    outcome='epoch';
  } else if(e.type==='RESET'&&cidentity(w,e)&&cinstance(w,e)) {
    assert.deepEqual(Object.keys(e.nextInstances).sort(),cresources(w).sort(),'reset dimensions');
    const affected=e.affected??cresources(w);
    assert.ok(Array.isArray(affected)&&affected.length>0&&new Set(affected).size===affected.length,'reset subset');
    assert.ok(affected.every(k=>Object.hasOwn(w.resources,k)),'known reset resources');
    // Validate every dimension before changing any identity. Time is necessary,
    // not evidence of zero use; replacement readings remain authoritative.
    for(const k of cresources(w)) {
      const r=w.resources[k];
      if(affected.includes(k)) {
        assert.ok(typeof e.nextInstances[k]==='string'&&e.nextInstances[k]&&e.nextInstances[k]!==r.instance);
        assert.ok(r.reset!==null&&e.at>=r.reset,'reset boundary required');
      } else assert.equal(e.nextInstances[k],r.instance,'continuing identity');
    }
    for(const k of cresources(w)) {
      const r=w.resources[k];
      if(affected.includes(k)) {r.instance=e.nextInstances[k];r.state='unknown';r.anchor=null;r.reset=null;}
      else if(mutation==='reset-clears-continuing') {r.used=cz();r.held=cz();}
    }
    for(const a of Object.values(w.attempts))if(!a.ended)a.unresolved=true;
    outcome='reset';
  } else if(e.type==='OBSERVATION') {
    assert.ok(e.provenance==='fixture-authoritative','provenance');
    assert.ok(Number.isSafeInteger(e.observedAt)&&e.observedAt<=e.at&&e.observedAt>=w.lastObservationAt,'future/backward observation');
    if(cidentity(w,e)&&cinstance(w,e)&&w.mapping) {
      const used=cvector(w,e.used);
      for(const k of cresources(w)) {
        assert.ok(['open','unopened','unknown'].includes(e.states[k]));
        assert.ok(e.resets[k]===null||Number.isSafeInteger(e.resets[k])&&e.resets[k]>e.at,'future reset');
      }
      for(const k of cresources(w))Object.assign(w.resources[k],{used:used[k],state:e.states[k],reset:e.resets[k]});
      w.lastObservationAt=e.observedAt;
      // Explicit receipt says these exact cumulative burns are already included
      // in this observation. A reading alone cannot erase outstanding exposure.
      for(const [id,meter] of Object.entries(e.reconciles??{})) {
        const a=w.attempts[id];assert.ok(a&&a.ceased&&!a.ended,'cessation required');
        assert.deepEqual(cvector(w,meter),a.meter,'attribution mismatch');
        a.unresolved=false;crelease(w,a,mutation);
      }
      outcome='observed';
    }
  } else if(e.type==='OWNER_ATTEMPT') {
    const cost=cvector(w,e.cost);const amount=cn(e.amount);
    assert.ok(!w.requests.some(r=>r.id===e.attempt),'unique owner attempt');
    w.quietAttempts.push(e.at);
    let fraction=null;
    if(cidentity(w,e)&&cinstance(w,e)&&w.mapping&&Object.values(w.resources).every(r=>r.state!=='unknown')) {
      fraction=cr(1);
      for(const k of cresources(w)) if(cc(cost[k],cz())>0) {
        const available=cavailable(w,k);
        const f=cc(available,cz())<=0?cz():cd(available,cost[k]);
        if(cc(f,fraction)<0)fraction=f;
      }
      if(w.service==='atomic'&&cc(fraction,cr(1))<0)fraction=cz();
      if(cc(fraction,cz())>0)copen(w,e,mutation,actual);
      for(const k of cresources(w))w.resources[k].used=ca(w.resources[k].used,cm(cost[k],fraction));
    }
    const served=fraction===null?null:cm(amount,fraction);
    if(!(mutation==='drop-denied'&&served&&cc(served,cz())===0))w.requests.push({
      id:e.attempt,requested:ct(amount),served:served===null?null:ct(served),
      denied:served===null?null:ct(cs(amount,served)),partial:fraction===null?null:cc(fraction,cz())>0&&cc(fraction,cr(1))<0,
      cost:Object.fromEntries(cresources(w).map(k=>[k,fraction===null?null:ct(cm(cost[k],fraction))]))});
    outcome=fraction===null?'unknown':cc(fraction,cz())===0?'denied':'served';
  } else if(cidentity(w,e)) {
    const a=w.attempts[e.attempt];
    if(e.type==='BORROW_RESERVE') {
      const cost=cvector(w,e.cost);
      const keys=mutation==='scalar-vector'?cresources(w).slice(0,1):cresources(w);
      if(!a&&cinstance(w,e)&&w.mapping&&!Object.values(w.attempts).some(a=>a.unresolved&&!a.ended)&&
        Object.values(w.resources).every(r=>r.state!=='unknown')&&keys.every(k=>cc(cost[k],cavailable(w,k))<=0)) {
        const opening=Object.values(w.resources).some(r=>r.state==='unopened');
        if(!opening||!w.tokens[w.week]) {
          if(opening)w.tokens[w.week]=true; // even ambiguous opening consumes token.
          for(const k of cresources(w))w.resources[k].held=ca(w.resources[k].held,cost[k]);
          w.attempts[e.attempt]={remaining:cost,instances:ccopy(e.instances),epoch:w.epoch,fence:w.fence,
            meter:Object.fromEntries(cresources(w).map(k=>[k,cz()])),meterSequence:-1,ended:false,ceased:false,unresolved:false,
            deadline:e.deadline??null,late:false,cancelled:false};
          copen(w,e,mutation,actual);outcome=e.ambiguous?'opening-ambiguous':'reserved';
        }
      }
    } else if(a&&a.epoch===e.epoch&&a.fence===e.fence&&
      Object.keys(a.instances).every(k=>e.instances[k]===a.instances[k])) {
      if(e.type==='BORROW_BURN') {
        const wasEnded=a.ended;outcome=cburn(w,a,e);
        if(wasEnded&&a.unresolved)a.ended=false;
      }
      if(e.type==='CANCEL_REQUEST') {a.cancelled=true;outcome='stopping';if(mutation==='cancel-refund'&&!a.ended)crelease(w,a,mutation);}
      if(e.type==='TERMINATION_ACK') {
        if(a.ended) {
          if(e.meterSequence>a.meterSequence) {
            outcome=cburn(w,a,e);
            if(a.unresolved)a.ended=false;
          } else { cburn(w,a,e);outcome=crelease(w,a,mutation); }
        }
        else if(e.authoritative===true) {
          cburn(w,a,e);a.ceased=true;
          a.late=a.deadline!==null&&e.at>a.deadline;
          outcome=a.unresolved?'awaiting-attribution':a.late?'late-unqualified':crelease(w,a,mutation);
          if(a.late)a.unresolved=true;
        } else outcome='unknown-ack';
      }
    }
  }
  w.trace.push(cfreeze(ccopy(e)));w.receipts.push({id:e.event_id,outcome});
}
function chronological(f,events,mutation='') {
  f=cfreeze(ccopy(f));events=cfreeze(ccopy(events));
  let baseline=cworld(f),actual=mutation==='alias-worlds'?baseline:cworld(f);
  baseline.lastObservationAt=actual.lastObservationAt=-1;
  const seen=new Map();let last=-1;const unique=[];
  for(const e of events) {
    assert.ok(Number.isSafeInteger(e.at)&&e.at>=last,'backward input');last=e.at;
    if(seen.has(e.event_id)){assert.equal(seen.get(e.event_id),JSON.stringify(e),'conflicting id');continue;}
    seen.set(e.event_id,JSON.stringify(e));unique.push(e);
  }
  // Boundary precedence is fixture-explicit: reset before owner by default,
  // then sequence within a class. No scheduling depends on wall time.
  const priority={FENCE:0,EPOCH:1,RESET:2,OBSERVATION:3,TERMINATION_ACK:4,OWNER_ATTEMPT:5,BORROW_RESERVE:6,BORROW_BURN:7,CANCEL_REQUEST:8,RESTART:9};
  assert.equal(f.resetOrder,'before-owner');
  if(mutation==='owner-before-reset')priority.OWNER_ATTEMPT=1;
  unique.sort((a,b)=>a.at-b.at||(priority[a.type]-priority[b.type])||a.sequence-b.sequence||a.event_id.localeCompare(b.event_id));
  for(const e of unique) {
    assert.ok(Object.hasOwn(priority,e.type),'event type');
    if(!e.type.startsWith('BORROW_')&&!['CANCEL_REQUEST','TERMINATION_ACK'].includes(e.type)) {
      // Observations may explicitly bind one world; borrowed usage must not be
      // laundered into the counterfactual baseline.
      if(!e.world||e.world==='baseline')baseline=cstep(baseline,e,mutation,actual)||baseline;
    }
    if(!e.world||e.world==='actual')actual=cstep(actual,e,mutation,actual)||actual;
  }
  const losses=baseline.requests.map(b=>{
    const a=actual.requests.find(a=>a.id===b.id);assert.ok(a,'identical demand present');
    assert.equal(a.requested,b.requested);
    const parse=s=>{const [n,d='1']=s.split('/');return cr(n,d);};
    return {id:b.id,loss:a.served===null||b.served===null?null:ct(cs(parse(b.served),parse(a.served)))};
  });
  return {baseline,actual,losses,E:losses.some(x=>x.loss!==null&&cc(cr(...x.loss.split('/')),cz())>0)?true:losses.some(x=>x.loss===null)?null:false,
    denominator:{provider:f.provider,account:f.account,accountWeek:f.week,count:1},
    quiet:f.quiet?actual.quietAttempts.some(t=>t>=f.quiet[0]&&t<f.quiet[1])?false:f.globalOwnerCoverage===true?true:null:null};
}
function cf(overrides={}) {return {provider:'synthetic',account:'owner',epoch:'e1',week:'w1',service:'atomic',resetOrder:'before-owner',
  resources:[{id:'week',capacity:100,used:0,state:'open',kind:'fixed',instance:'week/1',reset:1000}],...overrides};}
function ce(type,id,at,extra={}) {return {type,event_id:id,provider:'synthetic',account:'owner',epoch:'e1',fence:1,
  instances:{week:'week/1'},at,sequence:at,attempt:'job',...extra};}
function cobs(id,at,extra={}) {return ce('OBSERVATION',id,at,{observedAt:at,provenance:'fixture-authoritative',
  used:{week:0},states:{week:'open'},resets:{week:1000},...extra});}
const csummary=r=>({b:r.baseline.requests,a:r.actual.requests,losses:r.losses,E:r.E});
test('chronological G02 same fixture, exact atomic/divisible service and mutation rejection',()=>{
  const trace=[ce('BORROW_RESERVE','r',0,{cost:{week:5}}),ce('BORROW_BURN','b',1,{cumulative:{week:5},meterSequence:1}),
    ce('TERMINATION_ACK','ack',2,{authoritative:true,cumulative:{week:5},meterSequence:1}),
    ce('OWNER_ATTEMPT','o',3,{attempt:'owner-1',cost:{week:2},amount:2})];
  const expected={b:[{id:'owner-1',requested:'2',served:'2',denied:'0',partial:false,cost:{week:'2'}}],
    a:[{id:'owner-1',requested:'2',served:'0',denied:'2',partial:false,cost:{week:'0'}}],losses:[{id:'owner-1',loss:'2'}],E:true};
  const f=cf({resources:[{...cf().resources[0],used:94}]});
  assert.deepEqual(csummary(chronological(f,trace)),expected);
  for(const mutation of ['alias-worlds','drop-denied'])
    assert.throws(()=>assert.deepEqual(csummary(chronological(ccopy(f),ccopy(trace),mutation)),expected),mutation);
  const d=chronological({...ccopy(f),service:'divisible'},ccopy(trace));
  assert.equal(d.actual.requests[0].served,'1');assert.equal(d.losses[0].loss,'1');assert.equal(d.actual.requests[0].partial,true);
  const rational=chronological(cf({service:'divisible',resources:[{...cf().resources[0],capacity:1}]}),
    [ce('OWNER_ATTEMPT','third',0,{cost:{week:3},amount:1})]);
  assert.equal(rational.actual.requests[0].served,'1/3');assert.equal(ct(rational.actual.resources.week.used),'1');
});
test('chronological G04 concurrent reserves, all dimensions, epoch/fence refusal',()=>{
  const f=cf({resources:[{...cf().resources[0],capacity:10},{id:'short',capacity:3,used:0,state:'open',kind:'fixed',instance:'s1',reset:1000}]});
  const instances={week:'week/1',short:'s1'};
  const blocked=[ce('BORROW_RESERVE','v',0,{instances,cost:{week:4,short:4}})];
  assert.equal(chronological(ccopy(f),blocked).actual.receipts[0].outcome,'refused');
  assert.throws(()=>assert.equal(chronological(ccopy(f),ccopy(blocked),'scalar-vector').actual.receipts[0].outcome,'refused'));
  for(const order of [['a','b'],['b','a']]) {
    const trace=order.map((id,i)=>ce('BORROW_RESERVE',id,0,{attempt:id,sequence:i,cost:{week:6}}));
    trace.push(ce('FENCE','fence',1,{nextFence:2}),ce('TERMINATION_ACK','oldack',2,{attempt:order[0],authoritative:true,cumulative:{week:0},meterSequence:0}),
      ce('BORROW_RESERVE','oldreserve',3,{cost:{week:1},attempt:'new'}));
    const r=chronological(cf({resources:[{...cf().resources[0],capacity:10}]}),trace);
    assert.deepEqual(r.actual.receipts.map(x=>x.outcome),['reserved','refused','fenced','refused','refused']);
    assert.equal(ct(cavailable(r.actual,'week')),'4');
  }
  const epoch=chronological(cf(),[ce('EPOCH','e',0,{nextEpoch:'e2',mapping:false}),
    ce('BORROW_RESERVE','stale',1,{cost:{week:1}})]);
  assert.equal(epoch.actual.receipts.at(-1).outcome,'refused');
});
test('chronological G05 durable hold, cumulative dedup, restart, cancel and duplicate ack',()=>{
  const f=cf({resources:[{...cf().resources[0],used:20}]});
  const trace=[ce('BORROW_RESERVE','r',0,{cost:{week:6}}),ce('BORROW_BURN','b',1,{cumulative:{week:5},meterSequence:1}),
    ce('BORROW_BURN','dup',2,{cumulative:{week:5},meterSequence:1}),ce('CANCEL_REQUEST','cancel',3),ce('CANCEL_REQUEST','cancel2',4),ce('RESTART','restart',5)];
  const r=chronological(ccopy(f),ccopy(trace));
  assert.equal(ct(r.actual.resources.week.used),'25');assert.equal(ct(r.actual.resources.week.held),'1');
  assert.equal(ct(cs(cavailable(r.actual,'week'),cn(70))),'4');
  const finish=[...ccopy(trace),ce('TERMINATION_ACK','ack',6,{authoritative:true,cumulative:{week:5},meterSequence:1}),
    ce('TERMINATION_ACK','ack2',7,{authoritative:true,cumulative:{week:5},meterSequence:1})];
  const done=chronological(ccopy(f),ccopy(finish));assert.equal(ct(cs(cavailable(done.actual,'week'),cn(70))),'5');
  assert.throws(()=>assert.equal(ct(chronological(ccopy(f),ccopy(trace),'cancel-refund').actual.resources.week.held),'1'));
  assert.throws(()=>assert.equal(ct(cs(cavailable(chronological(ccopy(f),ccopy(finish),'duplicate-refund').actual,'week'),cn(70))),'5'));
  const over=chronological(ccopy(f),[ce('BORROW_RESERVE','r',0,{cost:{week:6}}),ce('TERMINATION_ACK','a',1,{authoritative:true,cumulative:{week:8},meterSequence:2})]);
  assert.equal(ct(over.actual.resources.week.used),'28');assert.equal(ct(over.actual.resources.week.held),'0');
});

test('chronological opening anchors, quiet attempts, deadline and durable account-week token',()=>{
  const resource={id:'week',capacity:10,used:0,state:'unopened',kind:'first-use',duration:300,instance:'week/1',reset:null};
  const f=cf({resources:[resource],quiet:[0,300],globalOwnerCoverage:true});
  const trace=[ce('BORROW_RESERVE','r',0,{cost:{week:2},deadline:290}),
    ce('BORROW_BURN','b',1,{cumulative:{week:1},meterSequence:1}),
    ce('OWNER_ATTEMPT','o',120,{attempt:'owner',cost:{week:2},amount:2}),
    ce('TERMINATION_ACK','ack',290,{authoritative:true,cumulative:{week:1},meterSequence:1})];
  const r=chronological(ccopy(f),ccopy(trace));
  assert.equal(r.actual.resources.week.anchor,0);assert.equal(r.baseline.resources.week.anchor,120);
  assert.equal(r.actual.resources.week.reset,300);assert.equal(r.baseline.resources.week.reset,420);
  assert.equal(r.E,false);assert.equal(r.quiet,false);assert.equal(r.actual.attempts.job.ended,true);
  assert.throws(()=>assert.equal(chronological(ccopy(f),ccopy(trace),'shared-anchor').baseline.resources.week.anchor,120));
  const loss=ccopy(trace);loss[2].cost.week=10;loss[2].amount=10;
  const l=chronological(ccopy(f),loss);assert.equal(l.E,true);assert.equal(l.quiet,false);
  assert.equal(l.actual.requests[0].requested,'10');assert.equal(l.actual.requests[0].served,'0');
  const late=ccopy(trace);late[3].at=291;
  const lr=chronological(ccopy(f),late);assert.equal(lr.actual.attempts.job.ended,false);assert.equal(lr.actual.attempts.job.unresolved,true);
  const outside=chronological(ccopy(f),[ce('OWNER_ATTEMPT','edge',300,{attempt:'owner',amount:1,cost:{week:1}})]);
  assert.equal(outside.quiet,true);
  assert.equal(chronological({...ccopy(f),globalOwnerCoverage:false},[]).quiet,null);
  const tokenTrace=[ce('BORROW_RESERVE','open',0,{cost:{week:1},ambiguous:true}),ce('RESTART','crash',1),
    ce('EPOCH','epoch',2,{nextEpoch:'e2',mapping:false}),ce('BORROW_RESERVE','retry',3,{epoch:'e2',attempt:'retry',cost:{week:1}})];
  const token=chronological(ccopy(f),tokenTrace);
  assert.equal(token.actual.tokens.w1,true);assert.equal(token.actual.receipts.at(-1).outcome,'refused');
  assert.equal(token.actual.week,'w1');
  const freshWeek=chronological(ccopy(f),[ce('EPOCH','newweek',0,{nextEpoch:'e2',newWeek:'w2',authoritative:true,mapping:true})]);
  assert.equal(freshWeek.actual.week,'w2');assert.equal(freshWeek.actual.tokens.w2,undefined);
});
test('chronological reset keeps exposure through delayed reading, ack and restart retry',()=>{
  const f=cf({resources:[{...cf().resources[0],reset:5}]});
  const next={week:'week/2'};
  const prefix=[ce('BORROW_RESERVE','r',0,{cost:{week:6}}),
    ce('BORROW_BURN','b',1,{cumulative:{week:5},meterSequence:1}),
    ce('RESET','reset',5,{nextInstances:next}),
    ce('RESTART','restart',6,{instances:next}),
    ce('BORROW_RESERVE','retry',7,{cost:{week:6}}),
    ce('TERMINATION_ACK','ack',8,{authoritative:true,cumulative:{week:5},meterSequence:1}),
    cobs('reading',9,{world:'actual',instances:next,resets:{week:100},used:{week:0}}),
    ce('BORROW_RESERVE','newblocked',10,{attempt:'new',instances:next,cost:{week:2}})];
  const waiting=chronological(ccopy(f),ccopy(prefix));
  assert.equal(waiting.actual.attempts.job.ceased,true);assert.equal(waiting.actual.attempts.job.unresolved,true);
  assert.equal(ct(waiting.actual.resources.week.held),'1');assert.equal(waiting.actual.receipts.at(-1).outcome,'refused');
  const trace=[...ccopy(prefix),
    cobs('settled',11,{world:'actual',instances:next,resets:{week:100},used:{week:0},reconciles:{job:{week:5}}}),
    ce('BORROW_RESERVE','useful',12,{attempt:'new',instances:next,cost:{week:2}}),
    ce('BORROW_BURN','work',13,{attempt:'new',instances:next,cumulative:{week:2},meterSequence:1}),
    ce('TERMINATION_ACK','done',14,{attempt:'new',instances:next,authoritative:true,cumulative:{week:2},meterSequence:1})];
  const done=chronological(ccopy(f),ccopy(trace));assert.equal(done.actual.attempts.job.ended,true);
  assert.equal(done.actual.attempts.new.ended,true);assert.equal(ct(done.actual.resources.week.used),'2');
  assert.equal(ct(done.actual.resources.week.held),'0');
  assert.throws(()=>assert.equal(chronological(ccopy(f),ccopy(prefix),'reset-erased-hold').actual.receipts.at(-1).outcome,'refused'));
  // Even without a RESET event, elapsed time invalidates old-period usage.
  const elapsed=chronological(ccopy(f),[
    ce('BORROW_RESERVE','r',0,{cost:{week:6}}),
    ce('TERMINATION_ACK','ack',6,{authoritative:true,cumulative:{week:5},meterSequence:1}),
    ce('BORROW_RESERVE','blocked',7,{attempt:'new',cost:{week:2}})]);
  assert.equal(elapsed.actual.attempts.job.unresolved,true);
  assert.equal(ct(elapsed.actual.resources.week.held),'6');
  assert.equal(elapsed.actual.receipts.at(-1).outcome,'refused');
});
test('chronological boundary precedence and unknown counterfactual are explicit',()=>{
  const f=cf({resources:[{...cf().resources[0],used:100,reset:5}]});
  const next={week:'week/2'};
  const trace=[ce('OWNER_ATTEMPT','owner',5,{instances:next,amount:2,cost:{week:2},attempt:'owner',sequence:0}),
    ce('RESET','reset',5,{nextInstances:next,sequence:1}),
    cobs('obs',5,{instances:next,resets:{week:100},sequence:2})];
  assert.equal(chronological(ccopy(f),ccopy(trace)).actual.requests[0].served,'2');
  assert.throws(()=>assert.equal(chronological(ccopy(f),ccopy(trace),'owner-before-reset').actual.requests[0].served,'2'));
  const unknown=chronological(cf({resources:[{...cf().resources[0],state:'unknown'}]}),
    [ce('OWNER_ATTEMPT','owner',0,{amount:2,cost:{week:2},attempt:'owner'})]);
  assert.equal(unknown.E,null);assert.equal(unknown.actual.requests[0].requested,'2');
  assert.equal(unknown.actual.requests[0].served,null);
});
test('chronological malformed inputs, provenance, duplicate identity and restart are checked',()=>{
  const good=ce('BORROW_RESERVE','r',0,{cost:{week:2}});
  for(const extra of [{sequence:NaN},{sequence:-1},{event_id:''},{cost:{week:1.5}},{cost:{week:-1}},
    {cost:{week:Infinity}},{cost:{}},{cost:{week:1,short:1}}])
    assert.throws(()=>chronological(cf(),[{...ccopy(good),...extra}]));
  assert.throws(()=>cr(1,0));
  assert.throws(()=>chronological(cf({resources:[cf().resources[0],cf().resources[0]]}),[]));
  assert.throws(()=>chronological(cf(),[cobs('future',0,{observedAt:1})]));
  assert.throws(()=>chronological(cf(),[cobs('unknown-source',0,{provenance:'local-absence'})]));
  assert.throws(()=>chronological(cf(),[ce('RESTART','later',2),ce('RESTART','earlier',1)]));
  assert.throws(()=>chronological(cf(),[good,{...ccopy(good),cost:{week:3}}]));
  const one=chronological(cf(),[ccopy(good),ce('RESTART','restart',1),ce('RESTART','again',2)]);
  const duplicate=chronological(cf(),[ccopy(good),ccopy(good),ce('RESTART','restart',1),ce('RESTART','again',2)]);
  assert.deepEqual(one,duplicate);
  assert.equal(Object.isFrozen(one.actual.trace[0]),true);
  assert.equal(good.cost.week,2);
  assert.equal(ct(one.actual.resources.week.held),'2');
});

test('chronological higher late meter is charged beyond estimate, never capped or refunded twice',()=>{
  const trace=[ce('BORROW_RESERVE','r',0,{cost:{week:6}}),
    ce('TERMINATION_ACK','ack',1,{authoritative:true,cumulative:{week:5},meterSequence:1}),
    ce('BORROW_BURN','late',2,{cumulative:{week:8},meterSequence:2}),
    ce('TERMINATION_ACK','again',3,{authoritative:true,cumulative:{week:8},meterSequence:2})];
  const r=chronological(cf(),trace);
  assert.equal(ct(r.actual.resources.week.used),'8');assert.equal(ct(r.actual.resources.week.held),'0');
  assert.equal(ct(r.actual.attempts.job.meter.week),'8');
});

test('chronological full resource opening and unknown ack preserve weekly and short accounting',()=>{
 const f=cf({resources:[{...cf().resources[0],capacity:100},
   {id:'short',capacity:10,used:0,state:'unopened',kind:'first-use',duration:300,instance:'short/1',reset:null}]});
 const instances={week:'week/1',short:'short/1'};
 const trace=[ce('BORROW_RESERVE','r',0,{instances,cost:{week:2,short:2}}),
 ce('TERMINATION_ACK','unknown',1,{instances,authoritative:false}),
 ce('OWNER_ATTEMPT','o',120,{instances,attempt:'owner',amount:2,cost:{week:2,short:2}}),
 ce('TERMINATION_ACK','ack',290,{instances,authoritative:true,cumulative:{week:1,short:1},meterSequence:1})];
 const r=chronological(f,trace);
 assert.equal(r.actual.resources.short.anchor,0);assert.equal(r.baseline.resources.short.anchor,120);
 assert.equal(r.actual.receipts[1].outcome,'unknown-ack');
 assert.equal(ct(r.actual.resources.week.used),'3');assert.equal(ct(r.actual.resources.short.used),'3');
 assert.equal(ct(r.actual.resources.week.held),'0');assert.equal(ct(r.actual.resources.short.held),'0');
 assert.equal(r.E,false);
});

test('chronological short-only reset preserves continuing weekly attribution and holds',()=>{
 const f=cf({resources:[{...cf().resources[0],used:70},
   {id:'short',capacity:100,used:10,state:'open',kind:'fixed',instance:'short/1',reset:5}]});
 const old={week:'week/1',short:'short/1'},next={week:'week/1',short:'short/2'};
 const e=(t,id,at,x={})=>ce(t,id,at,{instances:old,...x});
 const reading=(id,at,world,used,reconciles)=>cobs(id,at,{world,instances:next,used,
   states:{week:'open',short:'open'},resets:{week:1000,short:100},reconciles});
 const prefix=[e('BORROW_RESERVE','r',0,{cost:{week:6,short:6}}),
   e('BORROW_BURN','b',1,{cumulative:{week:5,short:5},meterSequence:1}),
   e('RESET','reset',5,{affected:['short'],nextInstances:next})];
 const reset=chronological(f,prefix);
 assert.equal(reset.actual.resources.week.instance,'week/1');
 assert.equal(ct(reset.actual.resources.week.used),'75');
 assert.equal(ct(reset.actual.resources.week.held),'1');
 assert.equal(reset.actual.resources.week.state,'open');
 assert.equal(reset.actual.resources.short.state,'unknown');
 assert.equal(ct(reset.actual.resources.short.held),'1');
 const late=[...prefix,e('BORROW_BURN','late',6,{cumulative:{week:6,short:6},meterSequence:2}),
   e('TERMINATION_ACK','unknown',7,{authoritative:false}),
   reading('actual-reading',8,'actual',{week:76,short:0}),
   e('BORROW_RESERVE','blocked',9,{instances:next,attempt:'new',cost:{week:2,short:2}})];
 const waiting=chronological(f,late);
 assert.equal(ct(waiting.actual.resources.week.used),'76');
 assert.equal(ct(waiting.actual.resources.week.held),'0');
 assert.equal(ct(waiting.actual.resources.short.held),'1');
 assert.equal(waiting.actual.receipts.at(-1).outcome,'refused');
 assert.equal(waiting.actual.attempts.job.ceased,false);
 const trace=[...late,e('TERMINATION_ACK','ack',10,{authoritative:true,cumulative:{week:6,short:6},meterSequence:2}),
   reading('settled',11,'actual',{week:76,short:0},{job:{week:6,short:6}}),
   reading('baseline-reading',11,'baseline',{week:70,short:0}),
   e('BORROW_RESERVE','useful',12,{instances:next,attempt:'new',cost:{week:2,short:2}}),
   e('BORROW_BURN','work',13,{instances:next,attempt:'new',cumulative:{week:2,short:2},meterSequence:1}),
   e('TERMINATION_ACK','done',14,{instances:next,attempt:'new',authoritative:true,cumulative:{week:2,short:2},meterSequence:1}),
   e('OWNER_ATTEMPT','owner',15,{instances:next,attempt:'owner',amount:2,cost:{week:2,short:2}})];
 const done=chronological(f,trace);
 assert.equal(done.actual.attempts.job.ended,true);assert.equal(done.actual.attempts.new.ended,true);
 assert.equal(ct(done.actual.resources.week.used),'80');assert.equal(ct(done.actual.resources.short.used),'4');
 assert.equal(ct(done.actual.resources.week.held),'0');assert.equal(ct(done.actual.resources.short.held),'0');
 assert.deepEqual(done.actual.requests,[{id:'owner',requested:'2',served:'2',denied:'0',partial:false,cost:{week:'2',short:'2'}}]);
 assert.equal(done.E,false);
 // Mutate the entire prefix, not an isolated scalar result.
 assert.throws(()=>assert.equal(ct(chronological(f,prefix,'reset-clears-continuing').actual.resources.week.used),'75'));
 assert.throws(()=>assert.equal(ct(chronological(f,prefix,'reset-clears-continuing').actual.resources.week.held),'1'));
 for(const instances of [old,{week:'week/2',short:'short/2'}]) {
   const refused=chronological(f,[...prefix,{...reading('bad',6,'actual',{week:0,short:0}),instances}]);
   assert.equal(refused.actual.receipts.at(-1).outcome,'refused');
   assert.equal(ct(refused.actual.resources.week.used),'75');
 }
 assert.throws(()=>chronological(f,[e('RESET','early',4,{affected:['short'],nextInstances:next})]));
 assert.throws(()=>chronological(f,[e('RESET','invented-week',5,{affected:['short'],nextInstances:{week:'week/2',short:'short/2'}})]));
});

test('chronological first-use clock shift causes owner loss only after independent reset',()=>{
 // Synthetic semantics only: first positive use anchors a ten-unit period;
 // authoritative boundary readings establish the next ten-unit open period.
 // No real-provider contract or calibrated probability is asserted.
 const f=cf({resources:[{...cf().resources[0]},
   {id:'short',capacity:10,used:0,state:'unopened',kind:'first-use',duration:10,instance:'short/1',reset:null}]});
 const old={week:'week/1',short:'short/1'},next={week:'week/1',short:'short/2'};
 const e=(t,id,at,x={})=>ce(t,id,at,{instances:old,...x});
 const owner=(id,at,n,world,instances)=>e('OWNER_ATTEMPT',id+'-'+world,at,{attempt:id,amount:n,cost:{week:0,short:n},world,instances});
 const opening=[e('BORROW_RESERVE','opening',0,{cost:{week:0,short:1}}),
   e('TERMINATION_ACK','useful-complete',1,{authoritative:true,cumulative:{week:0,short:1},meterSequence:1}),
   e('OWNER_ATTEMPT','first-owner',2,{attempt:'first',amount:8,cost:{week:0,short:8}})];
 const before=chronological(f,opening);
 assert.equal(before.baseline.resources.short.anchor,2);assert.equal(before.actual.resources.short.anchor,0);
 assert.equal(before.baseline.resources.short.reset,12);assert.equal(before.actual.resources.short.reset,10);
 assert.equal(before.actual.attempts.job.ended,true);assert.equal(ct(before.actual.resources.short.held),'0');
 const reset=(world,at)=>e('RESET','reset-'+world,at,{world,affected:['short'],nextInstances:next});
 const obs=(world,at)=>cobs('obs-'+world,at,{world,instances:next,used:{week:0,short:0},
   states:{week:'open',short:'open'},resets:{week:1000,short:at+10}});
 const trace=(middle=8,observeBaseline=true)=>[...opening,reset('actual',10),obs('actual',10),
   owner('middle',11,middle,'baseline',old),owner('middle',11,middle,'actual',next),
   reset('baseline',12),...(observeBaseline?[obs('baseline',12)]:[]),
   owner('last',13,4,'baseline',next),owner('last',13,4,'actual',next)];
 const r=chronological(f,trace());
 const record=(id,n,served)=>({id,requested:String(n),served:String(served),denied:String(n-served),
   partial:served>0&&served<n,cost:{week:'0',short:String(served)}});
 assert.deepEqual(r.baseline.requests,[record('first',8,8),record('middle',8,0),record('last',4,4)]);
 assert.deepEqual(r.actual.requests,[record('first',8,8),record('middle',8,8),record('last',4,0)]);
 assert.deepEqual(r.losses,[{id:'first',loss:'0'},{id:'middle',loss:'-8'},{id:'last',loss:'4'}]);assert.equal(r.E,true);
 assert.equal(r.denominator.count,1);assert.equal(r.actual.requests.length,3);
 // Both worlds discarded all borrower burn before the loss; only owner use in
 // differently anchored periods remains. No continuing weekly constraint binds.
 assert.equal(ct(r.actual.resources.week.used),'0');assert.equal(ct(r.actual.resources.short.used),'8');
 assert.equal(ct(r.actual.resources.short.held),'0');assert.equal(ct(r.baseline.resources.short.used),'4');
 const partial=chronological({...f,service:'divisible'},trace());
 assert.deepEqual(partial.actual.requests.at(-1),record('last',4,2));
 assert.equal(partial.losses.at(-1).loss,'2');assert.equal(partial.E,true);
 const control=chronological(f,trace(2));
 assert.deepEqual(control.actual.requests,[record('first',8,8),record('middle',2,2),record('last',4,4)]);
 assert.equal(control.E,false);assert.equal(control.actual.attempts.job.ended,true);
 const unknown=chronological(f,trace(8,false));
 assert.equal(unknown.baseline.requests.at(-1).requested,'4');assert.equal(unknown.baseline.requests.at(-1).served,null);
 assert.equal(unknown.losses.at(-1).loss,null);assert.equal(unknown.E,null);
});
