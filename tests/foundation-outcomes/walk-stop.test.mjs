import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgedAndStop} from '../foundation-walk/aged-and-stop.mjs';

// Conservative assumption: these are LOCAL fixture commands/evidence, not
// asserted production operation schemas. Host bindings still need qualification.
function setup(change=()=>{}) {
  let now=2000000, aggregate=null, cleaned=0;
  const identity={accountId:'a',jobId:'j',attemptId:'before'};
  const calls=[],states=[];
  const commands=Object.fromEntries(['none','aged','reload','prepare','stopPreparing','resume','reclaim','stopRunning'].map(name=>[name,{id:name,input:{},options:{operationKey:name}}]));
  const fixture={isolated:true,
    setAggregate:async value=>{aggregate=value;},
    restart:async()=>{},
    observe:async stage=>{
      states.push(stage);
      const common={accountId:'a',jobId:'j'};
      let evidence;
      if(['none','aged','reloaded'].includes(stage)) evidence={...common,
        started:true,mode:stage==='none'?'cold_pace':'aged',
        usage:{accountId:'a',reading:aggregate,ageMs:aggregate?now-aggregate.observedAtMs:null,
          readerId:'shared',readCount:1,nextReadAtMs:now+60000}};
      else if(stage==='preparing')evidence={...common,attemptId:'before',state:'preparing',launchCount:0};
      else if(stage==='stoppedPreparing')evidence={...common,attemptId:'before',
        revokedAtMs:now,releaseAtMs:now,cooldownUntilMs:now+5000,
        cessation:{kind:'never_started',attemptId:'before'},removed:true};
      else if(stage==='restarted')evidence={...common,attemptId:'before',cooldownUntilMs:now+5000,launchCount:0};
      else if(stage==='resumed')evidence={...common,eligible:true,evaluatedAtMs:now};
      else if(stage==='reclaimed')evidence={...common,attemptId:'after',launchCount:1,startedAtMs:now};
      else if(stage==='stoppedRunning')evidence={...common,attemptId:'after',
        revokedAtMs:now,ceasedAtMs:now,removed:true};
      change(stage,evidence);
      return evidence;
    },
    cleanup:async()=>{cleaned++;const result={accountId:'a',jobId:'j',cessationVerified:true,resourcesRemoved:true,rosterRemoved:true,remainingProcesses:0,remainingSandboxes:0};change('cleanup',result);return result;}
  };
  return {args:{identity,commands,fixture,clock:{now:()=>now,sleep:async ms=>{now+=ms;}},
    product:{call:async(id,input)=>{calls.push({id,input});}}},calls,states,get cleaned(){return cleaned;}};
}
test('conservative local subwalk exercises original aged observation, restart/cooldown, one reclaim and separate Stop clocks',async()=>{
  const f=setup();const result=await runAgedAndStop(f.args);
  assert.equal(result.evidenceKind,'synthetic-subwalk');
  assert.equal(result.aged.observedAtMs,500000);
  assert.equal(result.aged.ageMs,1500000);
  assert.equal(result.stop.revocationLatencyMs,0);
  assert.equal(result.stop.cessationLatencyMs,0);
  assert.deepEqual(f.calls.map(x=>x.id),['none','aged','reload','prepare','stopPreparing','resume','reclaim','reclaim','stopRunning']);
  assert.equal(f.cleaned,1);
});
for(const [name,stage,mutate,code] of [
  ['restamped aged observation','aged',e=>e.usage.reading={...e.usage.reading,observedAtMs:2000000},'aged_observation_changed'],
  ['reload starts another reader','reloaded',e=>e.usage.readCount++,'shared_reader_changed'],
  ['idle acknowledgement is not cessation','stoppedPreparing',e=>{delete e.cessation;e.state='idle';},'preparing_cleanup_unproven'],
  ['restart loses cooldown','restarted',e=>e.cooldownUntilMs=0,'cooldown_not_preserved'],
  ['resume has no healthy reevaluation','resumed',e=>e.eligible=false,'healthy_reevaluation_missing'],
  ['same job launches twice','reclaimed',e=>e.launchCount=2,'reclaim_not_exact'],
  ['revocation misses 1s target','stoppedRunning',e=>e.revokedAtMs+=1001,'revocation_target_missed'],
  ['cessation misses 10s target','stoppedRunning',e=>e.ceasedAtMs+=10001,'cessation_target_missed'],
  ['canceled is not cleanup proof','cleanup',e=>{delete e.cessationVerified;e.state='canceled';},'cleanup_unproven'],
])test(name,async()=>{
  const f=setup((s,e)=>{if(s===stage)mutate(e);});
  await assert.rejects(runAgedAndStop(f.args),error=>error.code===code);
  assert.equal(f.cleaned,1);
});
test('first failure remains primary when cleanup also fails',async()=>{
  const f=setup((s,e)=>{if(s==='aged')e.started=false;if(s==='cleanup')e.resourcesRemoved=false;});
  await assert.rejects(runAgedAndStop(f.args),e=>e.code==='job_not_started'&&e.cleanupError?.code==='cleanup_unproven');
});
