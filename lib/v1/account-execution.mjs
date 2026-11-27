import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {accountProxyRequestListener} from './guest-broker-tunnel.mjs';
import {createLaunchBackend} from './launch-backend.mjs';
import {createLendingLaunch,createLendingLedger} from './lending-launch.mjs';
import {decideLending} from './lending-decision.mjs';
import {windowHistoryRows} from './account-usage.mjs';
import {ok} from './accounts.mjs';
import {shellQuote} from '../harnesses/job-framing.mjs';
import {isGitCandidateScript} from '../git-candidate.mjs';

const unwrap=result=>{if(!result.ok)throw Object.assign(Error(result.error.code),result.error);return result.value;};
// A no-can-run decision reached at launch keeps its real shape: the hold/wait code, the next action and the
// retry time. admissionDecline marks it as an admission answer, never an execution fault, so the lender
// declines the attempt (the job reopens for other lenders) instead of failing it with a masked reason.
const admissionRefusal=decision=>{
  const code=decision.kind==='wait'?'no_spare':decision.code??'no_spare';
  return Object.assign(Error(code),{code,admissionDecline:true,
    ...(decision.kind==='wait'
      ?{waitReason:decision.reason,nextAction:decision.nextAction,retryAtMs:decision.nextEvaluationAtMs}
      :{nextAction:decision.nextAction??null,retryAtMs:null})});
};
// The executor still owns source materialization, output handoff and cleanup.
// Its prepare/start calls enter the existing durable launch coordinator. No
// native credential discovery is part of this path.
export function createAccountExecution({directory,store,broker,providers,settings,clock=Date.now,onLendabilityChange=null,onLease=null}) {
  const journal={directory};mkdirSync(directory,{recursive:true,mode:0o700});
  const lendabilityKinds=new Map();
  const ledger=createLendingLedger({journal,settings,nativeUnits:providers.listProviders().flatMap(d=>d.nativeUnits),usageSource:id=>broker.getAccountUsage(id).snapshot(clock())});
  let nativeBackend,clientForCircle,pending=Promise.resolve(),closed=false,reconciling=false;
  const subscriptions=new Map();
  // The authority that issued each attempt's lease: the job's signed designated member, kept with the
  // attempt in the durable launch journal. Recovery and lease confirmation resolve it against the
  // accepted signed roster; an attempt that names none keeps the circle's incumbent host.
  const designatedByAttempt=new Map();
  const recoveryLaunch=()=>createLendingLaunch({ledger,broker,providers,settings,journal,clock,
    backend:createLaunchBackend({backend:nativeBackend,journalDirectory:join(directory,'backend'),clock,
      resolveJob:async()=>{throw Error('recovery_cannot_prepare');},bindRun:async()=>{throw Error('recovery_cannot_start');},
      recoverHandle:async binding=>await nativeBackend.recoverAccountRun?.(binding)??null}),
    coordinator:{release:async({attempt,reason,operationId})=>{
      try{if(!attempt.circle)return ok({kind:'uncertain'});const client=await clientForCircle(attempt.circle,{designatedMember:attempt.designatedMember});
        const result=await client.release({attempt_id:attempt.attemptId,job_digest:attempt.jobId,generation:attempt.generation},reason,{idempotencyKey:operationId});
        return ok({kind:result.state==='released'?'released':'uncertain'});
      }catch{return ok({kind:'uncertain'});}
    }}});
  function watch(accountId){
    if(subscriptions.has(accountId))return;
    subscriptions.set(accountId,broker.getAccountUsage(accountId).subscribe(()=>{void api.reconcile().catch(()=>{});}));
  }
  // The same accounting boundary at both moments: with a job it is the launch decision; without one it is
  // the claim-time answer the advertisement reads. Saved window observations calibrate the burn-rate bound.
  const decideFor=async(account,job)=>{
    const policy=await settings(),at=clock(),snapshot=await ledger.snapshot(account.id);
    const usage=broker.getAccountUsage(account.id).snapshot(at);
    const decision=decideLending({schemaVersion:1,nowMs:at,account,usage,policy,ledger:snapshot,
      history:{accountId:account.id,rows:windowHistoryRows(usage,at)},job,
      eligibility:{evaluatedAtMs:at,settingsRevision:policy.revision,enabledNow:policy.enabled,nextChangeAtMs:null},
      runtime:{canStart:true}});
    return {decision,policy,at,snapshot};
  };
  const api={
    reconcile({backend=nativeBackend,clientFor=clientForCircle,requestRead=false,recover=false}={}) {
      if(closed||!backend)return Promise.resolve([]);
      if(requestRead)void broker.requestUsageReads('settlement').catch(()=>{});
      if(reconciling)return pending;
      reconciling=true;nativeBackend=backend;clientForCircle=clientFor;
      pending=pending.catch(()=>{}).then(async()=>{
        const launch=recoveryLaunch(),results=[];
        for(const row of await launch.pending()){
          watch(row.selection.accountId);
          if(row.attempt.designatedMember!==undefined)designatedByAttempt.set(row.attempt.attemptId,row.attempt.designatedMember);
          if(row.state==='preparing'||!row.dispatched){
            if(!recover)continue;
            const result=await launch.releaseBeforeStart({attemptId:row.attempt.attemptId,reason:row.releaseReason??'preparation_failed',
              operationId:row.releaseOperation??row.operationId+'/restart-release'});
            results.push({attemptId:row.attempt.attemptId,result});continue;
          }
          if(!Number.isSafeInteger(row.ceasedAtMs)&&!recover&&!row.stopping)continue;
          if(!Number.isSafeInteger(row.ceasedAtMs))await launch.stopLend({attemptId:row.attempt.attemptId,reason:'restart_recovery'});
          const usage=broker.getAccountUsage(row.selection.accountId);
          const snapshot=requestRead?await usage.requestRead({reason:'settlement'}):usage.snapshot(clock());
          results.push({attemptId:row.attempt.attemptId,result:await launch.settleUsage({attemptId:row.attempt.attemptId,usage:snapshot})});
        }
        return results;
      }).finally(()=>{reconciling=false;});
      return pending;
    },
    /** The claim-time answer for one account: what it would lend now. The advertisement offers only
     * accounts this call says would lend, so a lender that cannot run an account job never claims it and
     * the borrower's wait reason stays truthful. A structural defect is a hold that names it.
     * A transition into 'lend' reports itself: the lender then re-screens open offers at once, the same
     * wake a raised limit uses, instead of waiting out the offers poll's deadline. */
    async lendability({accountId}) {
      const account=store.get(accountId);
      if(closed||!account)return null;
      let decision;
      try{decision=(await decideFor(account,null)).decision;}
      catch(error){decision={schemaVersion:1,kind:'hold',code:String(error?.code??'invalid_decision_input'),
        nextAction:error?.nextAction??{id:'repair_settings',label:'Check lending settings',target:{accountId}}};}
      if(lendabilityKinds.get(accountId)!==decision.kind){
        lendabilityKinds.set(accountId,decision.kind);
        if(decision.kind==='lend')onLendabilityChange?.(accountId,decision);
      }
      return decision;
    },
    /** The subset of advertised accounts this lender can run right now: the claim-time rule, one place. */
    async lendableAccounts(accounts) {
      const decided=await Promise.all((Array.isArray(accounts)?accounts:[]).map(async account=>{
        try{return [account,await this.lendability({accountId:account.accountId})];}
        catch{return [account,null];}
      }));
      return decided.filter(([,decision])=>decision?.kind==='lend').map(([account])=>account);
    },
    /** The designated member that issued this attempt's lease, when the signed job named one. */
    designatedMemberOf(attemptId){return designatedByAttempt.get(attemptId);},
    async close(){closed=true;for(const unsubscribe of subscriptions.values())unsubscribe();subscriptions.clear();await pending.catch(()=>{});},
    async wrap({client,attempt,selection,job,promptText,spec,backend,signal}) {
      const lease=await client.accountLease(attempt,selection,{signal});
      onLease?.(lease);
      const launchAttempt={attemptId:attempt.attempt_id,jobId:attempt.job_digest,generation:attempt.generation,circle:job.circle,leaseProof:lease.proof,
        ...(job.designated_member!==undefined?{designatedMember:job.designated_member}:{})};
      if(launchAttempt.designatedMember!==undefined)designatedByAttempt.set(launchAttempt.attemptId,launchAttempt.designatedMember);
      nativeBackend=backend;watch(selection.accountId);
      const account=store.get(selection.accountId);
      if(!account||account.providerId!==selection.providerId)throw Error('job_binding_mismatch');
      const reader=broker.getAccountUsage(account.id);
      void reader.requestRead({reason:'admission'}).catch(()=>{});
      const {decision,policy,at,snapshot}=await decideFor(account,{id:attempt.job_digest,attemptId:attempt.attempt_id,selection});
      if(decision.kind!=='lend')throw admissionRefusal(decision);
      const receipt={schemaVersion:1,accountId:account.id,jobId:attempt.job_digest,attemptId:attempt.attempt_id,
        policyVersion:decision.policyVersion,quotedLedgerRevision:snapshot.revision,settingsRevision:policy.revision,
        evaluatedAtMs:at,amount:decision.amount,mode:decision.mode};
      const enforcement={amount:decision.amount,wallLimitMs:Math.min(job.requirements.limits.wall_seconds*1000,
        policy.strategyParams.wallLimitMs??60000),stopOnBudget:true,metering:'estimated',limitations:decision.diagnostics};
      let handle,running,brokerOrigin,observation=Promise.resolve(),executionOptions,prepared,removalReceipt,dispatched=false,stopped=false;
      // The caller's lease clock, when it owns one: preparation then runs on its own bounded clock and wall_seconds starts at
      // the protected handoff. Any caller that does not pass it keeps the one combined wall from prepare entry.
      let leaseClock={};
      const coordinator={
        reconcile:async()=>{try {const current=await client.accountLease(attempt,selection,{signal});
            onLease?.(current);
            return ok({kind:'owned',leaseProof:current.proof});}
          catch{return ok({kind:'fenced'});}},
        release:async({reason,operationId})=>{try {const result=await client.release(attempt,reason,{idempotencyKey:operationId});
          return ok({kind:result.state==='released'?'released':'fenced'});}catch{return ok({kind:'uncertain'});}},
      };
      const native=new Proxy(backend,{get(target,name){
        if(name==='prepare')return async value=>{
          // The host backend must explicitly support broker-only preparation;
          // a legacy backend cannot silently import its current account.
          if(typeof target.prepareAccountRun!=='function')throw Error('adapter_unsupported');
          handle=await target.prepareAccountRun(value,{signal,selection,attempt:launchAttempt,brokerOrigin,...leaseClock});return handle;
        };
        if(name==='destroy')return async(...args)=>{removalReceipt=await target.destroy(...args);return removalReceipt;};
        if(name==='start')return (h,opts)=>{running=(async()=>{
          if((await settings()).revision!==receipt.settingsRevision)throw Object.assign(Error('settings_conflict'),{code:'settings_conflict'});
          // A tunneled guest reaches the host broker only for this run: opened before the agent starts, closed when it ends.
          const tunnel=brokerOrigin===target.accountTunnelOrigin?.()?
            await target.openAccountTunnel(h,{signal,handler:accountProxyRequestListener({providerId:selection.providerId,providers,broker})}):null;
          try{return await target.start(h,{...opts,...executionOptions,
          onExecutionStarted:()=>{observation=Promise.resolve().then(async()=>{
            await opts.onExecutionStarted?.();
            unwrap(await launch.markAgentStarted({attemptId:attempt.attempt_id,atMs:clock(),operationId:attempt.attempt_id+'/observed'}));
            await executionOptions?.onExecutionStarted?.();
          });observation.catch(()=>{});return observation;}});}
          finally{tunnel?.close();}})();return running;};
        const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
      }});
      const bridge=createLaunchBackend({backend:native,journalDirectory:join(directory,'backend'),clock,
        resolveJob:async({run})=>{brokerOrigin=run.proxy.origin;return {...spec,job_id:attempt.job_digest,
          resources:{...spec.resources,wall_seconds:Math.ceil(enforcement.wallLimitMs/1000)}};},
        recoverHandle:async binding=>handle??await backend.recoverAccountRun?.(binding)??null,
        bindRun:async({handle:h,run})=>{
          if(run.proxy.providerId!==selection.providerId)throw Error('job_binding_mismatch');
          h._entrypoint='env '+Object.entries(run.env).map(([k,v])=>shellQuote(k+'='+v)).join(' ')+' '+
            [run.command,...run.args].map(shellQuote).join(' ');
        }});
      const launch=createLendingLaunch({ledger,broker,providers,backend:bridge,coordinator,settings,journal,clock});
      return new Proxy(backend,{get(target,name){
        // Every job this wrapper runs is a broker account job: its guest key is the one-job broker key.
        if(name==='admitJob')return (job,options)=>target.admitJob(job,{...options,accountBroker:true});
        if(name==='prepare')return async(_spec,prepareOptions)=>{
          if(prepareOptions?.separatePreparationClock===true&&typeof prepareOptions.wallRemainingMs==='function')
            leaseClock={separatePreparationClock:true,wallRemainingMs:prepareOptions.wallRemainingMs};
          prepared=unwrap(await launch.prepareLend({attempt:launchAttempt,selection,receipt,enforcement,
            operationId:attempt.attempt_id+'/prepare',signal,job:{...job,selection,promptText}}));
          return handle;
        };
        if(name==='start')return async(h,opts)=>{
          if(h!==handle||h._bookkeeping||h._sourcePreparation||isGitCandidateScript(h._entrypoint))return target.start(h,opts);
          executionOptions=opts;
          unwrap(await launch.startLend({attemptId:attempt.attempt_id,operationId:attempt.attempt_id+'/start',signal}));
          dispatched=true;
          if(!running)throw Error('launch_uncertain');
          let result;
          try{result=await running;await observation;}
          finally{
            const adapter=providers.getProvider(selection.providerId).value,usage=broker.getAccountUsage(selection.accountId);
            let sequence=0;
            for(const line of String(handle._lastExecStdout??'').split(/\r?\n/)){
              let raw;try{raw=JSON.parse(line);}catch{continue;}
              const eventId=createHash('sha256').update(JSON.stringify([attempt.attempt_id,sequence+1,raw])).digest('hex');
              const previous=usage.snapshot(clock()).jobReadings.find(event=>event.eventId===eventId);
              const parsed=adapter.parseJobUsage({accountId:selection.accountId,attemptId:attempt.attempt_id,
                event:{raw,eventId,sequence:sequence+1,meterEpoch:attempt.attempt_id,atMs:previous?.atMs??clock()}});
              if(parsed.ok){sequence++;unwrap(await usage.ingestJobReading(parsed.value));}
            }
          }
          return {...result,accountObservation:broker.executionObservation({selection,jobId:attempt.job_digest,attemptId:attempt.attempt_id})};
        };
        if(name==='cancel')return async h=>{
          if(h!==handle)return target.cancel(h);
          stopped=true;await launch.stopLend({attemptId:attempt.attempt_id,reason:'cancelled'});
        };
        if(name==='destroy')return async(...args)=>{
          if(prepared&&!stopped){stopped=true;await launch.stopLend({attemptId:attempt.attempt_id,reason:'finished'});}
          if(prepared&&dispatched)await launch.settleUsage({attemptId:attempt.attempt_id,usage:broker.getAccountUsage(selection.accountId).snapshot(clock())});
          if(prepared&&!dispatched)await launch.releaseBeforeStart({attemptId:attempt.attempt_id,reason:'preparation_failed',operationId:attempt.attempt_id+'/release'});
          if(removalReceipt)return removalReceipt;
          // The executor has already persisted output before destroy. Unknown
          // cessation keeps the launch reservation; it never grants a refund.
          const result=await target.destroy(...args);
          if(prepared&&args[0]===handle)bridge.recordRemoval({handle,receipt:result});
          return result;
        };
        const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
      }});
    },
  };
  return api;
}
