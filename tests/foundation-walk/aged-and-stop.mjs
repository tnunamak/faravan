// W07/W08 local subwalk. Dependency: fv-outcome-walk-send-and-file-1114.
// Conservative assumption: the host supplies normal product-port command
// descriptors and an isolated fixture instrumentation adapter. These observations
// are a LOCAL test boundary, not invented wire fields or provider qualification.
// Never execute operation handlers, calculate lending policy, or infer cessation
// from a job state. A synthetic pass is not a real-product W07/W08 PASS.
const fault=code=>Object.assign(new Error(code),{code});
const requireThat=(condition,code)=>{if(!condition)throw fault(code);};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const steps=['none','aged','reload','prepare','stopPreparing','resume','reclaim','stopRunning'];

export async function runAgedAndStop({product,commands,fixture,clock,identity,signal}={}) {
  requireThat(typeof product?.call==='function'&&typeof clock?.now==='function'&&typeof clock?.sleep==='function','walk_ports_required');
  requireThat(fixture?.isolated===true&&['setAggregate','observe','restart','cleanup'].every(k=>typeof fixture[k]==='function'),'isolated_fixture_required');
  requireThat(identity&&['accountId','jobId','attemptId'].every(k=>typeof identity[k]==='string'&&identity[k]),'walk_identity_required');
  for(const step of steps)requireThat(typeof commands?.[step]?.id==='string'&&commands[step].id&&commands[step].input&&typeof commands[step].input==='object','command_binding_required');
  requireThat(typeof commands.reclaim.options?.operationKey==='string'&&commands.reclaim.options.operationKey,'reclaim_operation_key_required');
  const bound=structuredClone(commands);
  const now=()=>{const value=clock.now();requireThat(integer(value),'invalid_clock');return value;};
  const call=async step=>{
    if(signal?.aborted)throw signal.reason??fault('cancelled');
    const command=bound[step];
    // Normal product-port validation/authorization remains in force. Only
    // reclaim is deliberately replayed, using the SAME explicit operationKey.
    return product.call(command.id,structuredClone(command.input),{...command.options,signal});
  };
  const observe=async stage=>{
    const e=await fixture.observe(stage);
    requireThat(e?.accountId===identity.accountId&&e.jobId===identity.jobId,'evidence_identity_mismatch');
    return e;
  };
  const latency=(at,start,target,code)=>{
    requireThat(integer(at)&&at>=start,'missing_stop_evidence');
    const elapsed=at-start;
    requireThat(elapsed<=target,code);
    requireThat(at<=now(),'future_stop_evidence');
    return elapsed;
  };
  let result,primary;
  try {
    await fixture.setAggregate(null);
    await call('none');
    const none=await observe('none');
    requireThat(none.started===true,'job_not_started');
    requireThat(none.mode==='cold_pace'&&none.usage?.accountId===identity.accountId&&none.usage.reading===null&&none.usage.ageMs===null,'missing_reading_not_preserved');

    const observedAtMs=now()-25*60000;
    requireThat(integer(observedAtMs),'clock_before_fixture_epoch');
    await fixture.setAggregate({schemaVersion:1,accountId:identity.accountId,observedAtMs});
    await call('aged');
    const aged=await observe('aged');
    requireThat(aged.started===true,'job_not_started');
    requireThat(aged.mode==='aged'&&aged.usage?.accountId===identity.accountId&&aged.usage.reading?.accountId===identity.accountId&&aged.usage.reading?.observedAtMs===observedAtMs,'aged_observation_changed');
    requireThat(aged.usage.ageMs===now()-observedAtMs,'aged_age_incorrect');
    requireThat(typeof aged.usage.readerId==='string'&&aged.usage.readerId&&integer(aged.usage.readCount)&&integer(aged.usage.nextReadAtMs)&&aged.usage.nextReadAtMs>now(),'backoff_evidence_missing');
    await call('reload');
    const reload=await observe('reloaded');
    requireThat(reload.usage?.readerId===aged.usage.readerId&&reload.usage.readCount===aged.usage.readCount&&reload.usage.nextReadAtMs===aged.usage.nextReadAtMs,'shared_reader_changed');
    requireThat(reload.usage.reading?.observedAtMs===observedAtMs&&reload.usage.ageMs===now()-observedAtMs,'aged_observation_changed');

    await call('prepare');
    const preparing=await observe('preparing');
    requireThat(preparing.attemptId===identity.attemptId&&preparing.state==='preparing'&&preparing.launchCount===0,'not_preparing');
    const requestedAtMs=now();
    await call('stopPreparing');
    const stopped=await observe('stoppedPreparing');
    requireThat(stopped.attemptId===identity.attemptId&&stopped.cessation?.kind==='never_started'&&stopped.cessation.attemptId===identity.attemptId&&stopped.removed===true,'preparing_cleanup_unproven');
    const preparingRevocationMs=latency(stopped.revokedAtMs,requestedAtMs,1000,'revocation_target_missed');
    requireThat(integer(stopped.releaseAtMs)&&stopped.releaseAtMs>=requestedAtMs&&stopped.releaseAtMs<=now()&&integer(stopped.cooldownUntilMs)&&stopped.cooldownUntilMs>=stopped.releaseAtMs,'invalid_cooldown');
    await fixture.restart();
    const restarted=await observe('restarted');
    requireThat(restarted.attemptId===identity.attemptId&&restarted.launchCount===0&&restarted.cooldownUntilMs===stopped.cooldownUntilMs,'cooldown_not_preserved');
    let eligibleAtMs=Math.max(stopped.releaseAtMs,stopped.cooldownUntilMs);
    if(now()<eligibleAtMs)await clock.sleep(eligibleAtMs-now(),{signal});
    requireThat(now()>=eligibleAtMs,'cooldown_not_elapsed');
    await call('resume');
    const resumed=await observe('resumed');
    requireThat(resumed.eligible===true&&integer(resumed.evaluatedAtMs)&&resumed.evaluatedAtMs>=eligibleAtMs&&resumed.evaluatedAtMs<=now(),'healthy_reevaluation_missing');
    eligibleAtMs=Math.max(eligibleAtMs,resumed.evaluatedAtMs);
    await call('reclaim');
    await call('reclaim');
    const reclaimed=await observe('reclaimed');
    requireThat(typeof reclaimed.attemptId==='string'&&reclaimed.attemptId&&reclaimed.attemptId!==identity.attemptId&&reclaimed.launchCount===1&&integer(reclaimed.startedAtMs)&&reclaimed.startedAtMs>=eligibleAtMs&&reclaimed.startedAtMs<=now()&&reclaimed.startedAtMs-eligibleAtMs<=5000,'reclaim_not_exact');

    const runningRequestedAtMs=now();
    await call('stopRunning');
    const running=await observe('stoppedRunning');
    requireThat(running.attemptId===reclaimed.attemptId&&running.removed===true,'running_cleanup_unproven');
    // Independent events: neither timestamp is inferred from Stop acknowledgement.
    const revocationLatencyMs=latency(running.revokedAtMs,runningRequestedAtMs,1000,'revocation_target_missed');
    const cessationLatencyMs=latency(running.ceasedAtMs,runningRequestedAtMs,10000,'cessation_target_missed');
    requireThat(running.ceasedAtMs>=running.revokedAtMs,'stop_event_order');
    result={evidenceKind:'synthetic-subwalk',dependency:'fv-outcome-walk-send-and-file-1114',
      aged:{observedAtMs,ageMs:aged.usage.ageMs,readerId:aged.usage.readerId,readCount:aged.usage.readCount,nextReadAtMs:aged.usage.nextReadAtMs},
      reclaim:{jobId:identity.jobId,attemptId:reclaimed.attemptId,launchCount:reclaimed.launchCount,eligibleAtMs,startedAtMs:reclaimed.startedAtMs},
      stop:{preparingRevocationMs,requestedAtMs:runningRequestedAtMs,revokedAtMs:running.revokedAtMs,ceasedAtMs:running.ceasedAtMs,revocationLatencyMs,cessationLatencyMs}};
  } catch(error){primary=error;}
  finally {
    try{
      const cleanup=await fixture.cleanup();
      requireThat(cleanup?.accountId===identity.accountId&&cleanup.jobId===identity.jobId&&cleanup.cessationVerified===true&&cleanup.resourcesRemoved===true&&cleanup.rosterRemoved===true&&cleanup.remainingProcesses===0&&cleanup.remainingSandboxes===0,'cleanup_unproven');
      if(result)result.cleanup=cleanup;
    }catch(error){if(primary&&typeof primary==='object')primary.cleanupError=error;else primary=error;}
  }
  if(primary)throw primary;
  return result;
}
