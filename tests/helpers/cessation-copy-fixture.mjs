import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {CESSATION_FIX, cessationHoldMessage} from '../../lib/sandbox-remediation.mjs';
import {projectReadinessBlockers} from '../../lib/v1/blockers.mjs';
import {createDeadlineRecoveryGate} from '../../lib/v1/deadline-recovery-gate.mjs';

// Component boundary for computeEffective: execute its real body and the real
// effectiveState projection without booting an app, provider or host sandbox.
const source=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
function section(text,start,end) {
  const a=text.indexOf(start),b=text.indexOf(end,a);
  assert.ok(a>=0&&b>a,'production function boundary: '+start);
  return text.slice(a,b);
}
export function cessationCopyFixture({existing=null,resumeFailure=false}={}) {
  const app=source('lib/v1/app.mjs'),registry=source('lib/v1/ops/registry.mjs');
  const stateSource=source('lib/v1/lending-state.mjs').replace(/^import .*;\n/gm,'').replace(/export /g,'');
  const context=vm.createContext({structuredClone,options:{},hostProfiles:new Map(),projectReadinessBlockers,CESSATION_FIX,cessationHoldMessage,backend:{cleanupStatus:()=>({items:[]})},
    // app.mjs reads cleanup rows through this module-level helper; the fake backend has no snapshot API.
    cleanupDisplaySummary:backend=>backend.cleanupStatus(),
    // Every machine prerequisite is known ready; no external checks run.
    lendingBlockers:()=>({items:[]}),RUNNING_JOB:'A job is running.',
    todayCounters:()=>null,now:()=>1000,executionEvidence:()=>({current:null,stage:null}),
    device:{listCircles:async()=>[{id:'circle'}]},projectMembership:()=>({phase:'approved'}),blockerInputs:async()=>({}),
    dailyLimitReached:()=>false,settings:{intent:'on',activeCircle:'circle',enabled:!resumeFailure,limits:{},agents:{codex:true}},
    timedResume:null,safetyIntentEpoch:1,launchedAt:0,memberTooOld:()=>null,backgroundCheck:null,
    resumeFailed:resumeFailure?{code:'cessation_unverified'}:null,
    // The real app-lifecycle gate with a backend that reports no recovery hold.
    deadlineRecovery:createDeadlineRecoveryGate({backend:{},signal:new AbortController().signal}),
    approvals:new Map(),chatgptActions:()=>[],lender:{cessation:()=>({proven:true})},
    // The already-proven job is still pending its remaining durable work:
    // lender admissionReason keeps refusing new jobs until pending is cleared.
    lenderAdmission:()=> 'cessation_unverified',
    admissionIntent:reason=>({state:'blocked',reason,until:null}),
    agentDisplayName:id=>id,borrowingWorkflow:async()=>({}),
    createLendingProjection:x=>x,projectLendingState:()=>({intent:'on',execution:'idle'}),accountHolds:()=>[],
  });
  vm.runInContext(stateSource+'\nglobalThis.project=effectiveState;',context);
  if(existing)context.project=()=>({intent:{on:true,state:'blocked'},execution:{state:'idle'},blockers:[existing]});
  // Keep the projection real except in the explicit shared-object safety case.
  vm.runInContext('effectiveState=globalThis.project;\n'+
    section(app,'  function hostCircleState(','  async function blockerInputs(')+
    section(app,'  async function computeEffective(','\n  // P1b:')+'\n'+
    section(registry,'const FIX = {','\nasync function borrowingWorkflow')+'\n'+
    section(registry,'async function blockersWorkflow(ctx) {','\n}\n')+'\n}\n'+
    'globalThis.compute=computeEffective;globalThis.list=blockersWorkflow;',context);
  const remediation=[{name:'wf-0123456789abcdef',reason:'cleanup_incomplete'}];
  return {
    async raw(){return context.compute({status:'stopping',reason:'cessation_unverified',remediation},
      [{spec:{harness_id:'codex'},installed:true,signedIn:true}]);},
    async listed(){return context.list({call:async id=>id==='status.get'
      ?{intent:{on:true},blockers:[{kind:'cessation_unverified'}],lending:{remediation}}
      :id==='readiness.get'?{ready:true,checks:[]}:[]});},
    fix:CESSATION_FIX,
  };
}
