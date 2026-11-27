import {isDeepStrictEqual} from 'node:util';

// Internal integration helper, not a replacement for the frozen LaunchBackend.
// resolveJob({jobId, attemptId}) must return Result<JobSpec> from authenticated,
// attempt-bound integration state. It must not reconstruct a job from display data.
// This helper does not verify signatures, issue keys, launch, or assert cessation.
export function createExecutionRunAdapter({providers, resolveJob}) {
  const fault=(code,jobId)=>({ok:false,error:{code,retryAtMs:null,
    nextAction:{id:'review_execution',label:'Review job execution',target:jobId?{jobId}:{}}}});
  const text=value=>typeof value==='string'&&value.length>0;
  const selectionOK=s=>s&&['providerId','accountId','modelId'].every(k=>text(s[k]))&&(s.effortId===null||text(s.effortId));
  const amountOK=a=>a&&['window_micro_points','native'].includes(a.unit)&&
    (a.unit!=='native'||text(a.nativeUnit))&&Array.isArray(a.byResource)&&a.byResource.length>0&&
    a.byResource.every(r=>text(r.id)&&(r.instance===null||text(r.instance))&&Number.isSafeInteger(r.amount)&&r.amount>=0)&&
    a.byResource.some(r=>r.amount>0);
  return {
    async makeRun(input) {
      const jobId=typeof input?.attempt?.jobId==='string'?input.attempt.jobId:undefined;
      const signal=input?.signal;
      if(signal?.aborted)return fault('cancelled',jobId);
      let attempt,selection,receipt,enforcement,jobKey;
      try {
        ({attempt,selection,receipt,enforcement,jobKey}=structuredClone({
          attempt:input.attempt,selection:input.selection,receipt:input.receipt,
          enforcement:input.enforcement,jobKey:input.jobKey}));
      } catch {return fault('invalid_execution_input',jobId);}
      if(!text(attempt?.jobId)||!text(attempt?.attemptId)||!selectionOK(selection)||!text(jobKey)||
        receipt?.schemaVersion!==1||receipt.accountId!==selection.accountId||
        receipt.jobId!==attempt.jobId||receipt.attemptId!==attempt.attemptId||
        !amountOK(receipt.amount)||!isDeepStrictEqual(receipt.amount,enforcement?.amount)||
        !Number.isSafeInteger(enforcement?.wallLimitMs)||enforcement.wallLimitMs<=0||
        enforcement.stopOnBudget!==true||!['measured','estimated'].includes(enforcement.metering)||
        !Array.isArray(enforcement.limitations)||!enforcement.limitations.every(x=>typeof x==='string'))
        return fault('job_binding_mismatch',jobId);
      let provider;
      try {
        const result=providers.getProvider(selection.providerId);
        if(!result?.ok)return fault('adapter_unsupported',jobId);
        provider=result.value;
      } catch {return fault('adapter_unsupported',jobId);}
      if(provider?.descriptor?.id!==selection.providerId||typeof provider.makeRun!=='function')
        return fault('adapter_unsupported',jobId);
      let job;
      try {
        const resolved=await resolveJob({jobId:attempt.jobId,attemptId:attempt.attemptId});
        if(signal?.aborted)return fault('cancelled',jobId);
        if(!resolved?.ok)return fault('job_binding_mismatch',jobId);
        job=structuredClone(resolved.value);
      } catch {return fault(signal?.aborted?'cancelled':'job_binding_mismatch',jobId);}
      if(!isDeepStrictEqual(job?.selection,selection)||job?.runRequest?.schemaVersion!==1)
        return fault('job_binding_mismatch',jobId);
      const request=job.runRequest;
      if(request.models!=='any'&&(!Array.isArray(request.models)||request.models.length===0||
        !request.models.every(m=>text(m?.providerId)&&text(m?.modelId))||
        !request.models.some(m=>m.providerId===selection.providerId&&m.modelId===selection.modelId)))
        return fault('model_unavailable',jobId);
      if(!Array.isArray(provider.descriptor.models))return fault('invalid_provider_response',jobId);
      const model=provider.descriptor.models.find(m=>m?.id===selection.modelId&&m.enabled===true);
      if(!model)return fault('model_unavailable',jobId);
      if(!Array.isArray(model.efforts)||(request.effortId!==null&&!text(request.effortId)))
        return fault('effort_unavailable',jobId);
      const effective=request.effortId===null?model.defaultEffort:request.effortId;
      if(selection.effortId!==effective||
        (model.efforts.length===0?effective!==null:!model.efforts.some(e=>e.id===effective)))
        return fault('effort_unavailable',jobId);
      if(signal?.aborted)return fault('cancelled',jobId);
      try {
        // Give adapter only frozen-contract values, not the integration context.
        // Clones prevent an adapter mutation from changing the caller's authority.
        const result=provider.makeRun(structuredClone({selection,jobKey,job,receipt,enforcement}));
        if(!result?.ok)return fault('adapter_unsupported',jobId);
        const run=result.value;
        if(run?.schemaVersion!==1||!text(run.command)||!Array.isArray(run.args)||
          !run.args.every(x=>typeof x==='string')||!run.env||typeof run.env!=='object'||Array.isArray(run.env)||
          !Object.values(run.env).every(x=>typeof x==='string')||!run.proxy||typeof run.proxy!=='object'||
          !isDeepStrictEqual(run.receipt,receipt)||!isDeepStrictEqual(run.enforcement,enforcement))
          return fault('invalid_provider_response',jobId);
        if(signal?.aborted)return fault('cancelled',jobId);
        return {ok:true,value:structuredClone(run)};
      } catch {return fault('invalid_provider_response',jobId);}
    },
  };
}
