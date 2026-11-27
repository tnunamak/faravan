import {randomUUID} from 'node:crypto';

// Private host observations only. No provider text, arguments, paths or credentials.
export const PROBE_PHASES=Object.freeze({queue:'waiting for the sandbox service',preflight:'checking sandbox requirements',
  storage_qualification:'checking sandbox storage',create_ready:'starting the check sandbox',identity:'checking the account sign-in',
  first_command:'reading the account allowance',teardown:'stopping and removing the check sandbox'});
const PURPOSES=new Set(['native_identity','proxy_identity','allowance','meter']);
const OUTCOMES=new Set(['running','ok','failed','timed_out','cancelled','skipped','deferred']);
const SOURCES=new Set(['overall','caller','sandbox_wall','command','cleanup']);
const SUBJECTS=new Set(['qualification','probe','meter']);
// Closed vocabulary: never accept arbitrary error codes or diagnostic text.
const SUBCAUSES=new Set(['unknown','credential_store','credential_writer_unresolved','daemon_restart_required',
  'daemon_unavailable','daemon_unverified','daemon_owner_repair_required','systemd_unit_conflict','daemon_owner_missing',
  'option_rejected','not_signed_in','kvm','disk_full','image_unavailable','timeout','killed',
  'deadline_registration_failed','execution_gate_refused','guard_runtime_unavailable','cessation_unverified',
  'policy_unenforceable','limits_unenforceable','storage_unenforceable','credential_scope_unenforceable',
  'native_credentials_owner_only','input_copy_failed','host_disk_low','host_disk_unreadable','disk_protection_unavailable']);
const SUBCAUSE_ALIASES=Object.freeze({sandbox_credential_store_failed:'credential_store',wall_timeout:'timeout',
  sandbox_ready_timeout:'timeout',ETIMEDOUT:'timeout',daemon_hold_timeout:'timeout',SBX_DAEMON_UNVERIFIED:'daemon_unverified'});
const failureFields=value=>{
  if(value?.subcause===undefined)return {};
  const category=typeof value.subcause==='string'&&Object.hasOwn(SUBCAUSE_ALIASES,value.subcause)
    ?SUBCAUSE_ALIASES[value.subcause]:value.subcause;
  return {subcause:SUBCAUSES.has(category)?category:'unknown',
    ...(Number.isInteger(value.exit_code)&&value.exit_code>=-2147483648&&value.exit_code<=2147483647?{exit_code:value.exit_code}:{})};
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=86400000;
const utc=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s));
export const probePhaseLabel=phase=>Object.hasOwn(PROBE_PHASES,phase)?PROBE_PHASES[phase]:null;
export function sanitizeProbePhase(value) {
  if(!value||typeof value!=='object'||!probePhaseLabel(value.phase)||!SUBJECTS.has(value.subject)||
    !Number.isInteger(value.sequence)||value.sequence<1||value.sequence>24||!OUTCOMES.has(value.outcome)||
    !utc(value.started_at)||!integer(value.start_elapsed_ms))return null;
  const running=value.outcome==='running';
  if(!running&&(!utc(value.ended_at)||!integer(value.end_elapsed_ms)||value.end_elapsed_ms<value.start_elapsed_ms||Date.parse(value.ended_at)<Date.parse(value.started_at)))return null;
  const deadline=integer(value.effective_deadline_elapsed_ms)&&SOURCES.has(value.deadline_source);
  return {sequence:value.sequence,phase:value.phase,subject:value.subject,started_at:value.started_at,
    ended_at:running?null:value.ended_at,start_elapsed_ms:value.start_elapsed_ms,end_elapsed_ms:running?null:value.end_elapsed_ms,
    outcome:value.outcome,effective_deadline_elapsed_ms:deadline?value.effective_deadline_elapsed_ms:null,deadline_source:deadline?value.deadline_source:null,
    ...(['failed','timed_out','cancelled'].includes(value.outcome)?failureFields(value):{})};
}
export function sanitizeProbeDiagnostics(value) {
  if(!value||typeof value!=='object'||value.version!==1||!UUID.test(value.probe_id??'')||!PURPOSES.has(value.purpose)||
    !Array.isArray(value.phases)||value.phases.length>24)return null;
  const phases=value.phases.map(sanitizeProbePhase);
  if(phases.some(p=>!p)||phases.some((p,i)=>p.sequence!==i+1))return null;
  const failures=phases.filter(p=>['failed','timed_out','cancelled'].includes(p.outcome));
  const failed=failures.find(p=>p.sequence===value.first_failure?.sequence&&p.phase===value.first_failure?.phase&&p.outcome===value.first_failure?.outcome)
    ??failures.slice().sort((a,b)=>a.end_elapsed_ms-b.end_elapsed_ms||a.sequence-b.sequence)[0];
  const result={version:1,probe_id:value.probe_id,purpose:value.purpose,
    ...(['claude','codex','github'].includes(value.provider)?{provider:value.provider}:{}),
    ...(Number.isSafeInteger(value.generation)&&value.generation>=0?{generation:value.generation}:{}),
    ...(DIGEST.test(value.job_digest??'')?{job_digest:value.job_digest}:{}),
    ...(typeof value.attempt_id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value.attempt_id)?{attempt_id:value.attempt_id}:{}),
    phases,...(failed?{failed_phase:failed.phase,first_failure:{phase:failed.phase,sequence:failed.sequence,outcome:failed.outcome}}:{})};
  // Keep the original phase-count/byte bounds. Prefer earlier failure detail if
  // pathological repeated failures would otherwise erase the whole receipt.
  const bytes=()=>Buffer.byteLength(JSON.stringify(result));
  if(bytes()>8192)for(const phase of [...phases].reverse()){
    delete phase.subcause;delete phase.exit_code;if(bytes()<=8192)break;
  }
  return bytes()<=8192?result:null;
}
export function probeDiagnosticFields(value) {
  const receipt=sanitizeProbeDiagnostics(value?.probe_diagnostics??value);
  return receipt?.phases.length?{probe_diagnostics:receipt,...(receipt.failed_phase?{failed_phase:receipt.failed_phase}:{})}:{};
}
const advisory=(callback,value)=>{try{Promise.resolve(callback?.(value)).catch(()=>{});}catch{}};

export function createProbeDiagnostics({purpose='allowance',provider,generation,job_digest,attempt_id,
  now=Date.now,monotonic=()=>performance.now(),onEvent,onReceipt,callerBudgetMs=null}={}) {
  const origin=monotonic(),originWall=now(),phases=[];
  purpose=PURPOSES.has(purpose)?purpose:'allowance';
  const meta={version:1,probe_id:randomUUID(),purpose,provider,generation,job_digest,attempt_id};
  let complete=false,last=0,firstFailure=null;
  const elapsed=()=>{const n=Math.floor(monotonic()-origin);last=Math.max(last,Number.isFinite(n)?Math.min(86400000,Math.max(0,n)):last);return last;};
  const at=n=>new Date(Math.max(0,Math.min(8.64e15,originWall+n))).toISOString();
  const snapshot=()=>sanitizeProbeDiagnostics({...meta,phases,...(firstFailure?{first_failure:firstFailure}:{})})??{version:1,probe_id:meta.probe_id,purpose:meta.purpose,phases:[]};
  const event=row=>{const safe=snapshot();advisory(onEvent,{code:'probe_phase',probe_id:safe.probe_id,purpose:safe.purpose,
    ...(safe.provider?{provider:safe.provider}:{}),...(safe.generation===undefined?{}:{generation:safe.generation}),...(safe.job_digest?{job:safe.job_digest}:{}),...(safe.attempt_id?{attempt_id:safe.attempt_id}:{}),...row});};
  const start=(phase,{subject=purpose==='meter'?'meter':'probe',budgetMs=null,deadlineSource=null}={})=>{
    if(complete||!probePhaseLabel(phase)||!SUBJECTS.has(subject)||phases.length>=24)return null;
    const n=elapsed(),deadline=integer(budgetMs)&&SOURCES.has(deadlineSource)&&n+budgetMs<=86400000;
    const caller=phase!=='teardown'&&integer(callerBudgetMs)&&(!deadline||callerBudgetMs<=n+budgetMs);
    const row={sequence:phases.length+1,phase,subject,started_at:at(n),ended_at:null,start_elapsed_ms:n,end_elapsed_ms:null,
      outcome:'running',effective_deadline_elapsed_ms:caller?callerBudgetMs:deadline?n+budgetMs:null,deadline_source:caller?'caller':deadline?deadlineSource:null};
    phases.push(row);event({...row});return row;
  };
  const end=(row,outcome='ok',failure={})=>{
    if(!phases.includes(row)||row.outcome!=='running')return;
    if(!OUTCOMES.has(outcome)||outcome==='running')outcome='failed';
    const n=elapsed();Object.assign(row,{outcome,ended_at:at(n),end_elapsed_ms:n},
      ['failed','timed_out','cancelled'].includes(outcome)?failureFields(failure):{});
    if(!firstFailure&&['failed','timed_out','cancelled'].includes(outcome))firstFailure={phase:row.phase,sequence:row.sequence,outcome};
    event({...row});
  };
  return {start,end,snapshot,interrupt(outcome='cancelled'){for(const phase of phases)if(phase.phase!=='teardown')end(phase,outcome);},failedPhase:()=>snapshot().failed_phase??null,
    finish(outcome='ok') {if(!complete){for(const phase of phases)end(phase,outcome);complete=true;advisory(onReceipt,snapshot());}return snapshot();}};
}

// A local sidecar, never merged into the signed/public execution receipt. Optional writes cannot gate work.
export function createProbeReceiptStore({file,fs}) {
  let pending=Promise.resolve();
  const read=async()=>{try{const value=JSON.parse(await fs.readFile(file,'utf8'));return Array.isArray(value)?value.slice(-64).map(sanitizeProbeDiagnostics).filter(Boolean):[];}catch{return [];}};
  function record(value) {
    const receipt=sanitizeProbeDiagnostics(value);if(!receipt)return Promise.resolve();
    const next=pending.then(async()=>{const rows=(await read()).filter(r=>r.probe_id!==receipt.probe_id);
      const temp=file+'.'+randomUUID()+'.tmp';
      try{await fs.writeFile(temp,JSON.stringify([...rows,receipt].slice(-64)),{mode:0o600,flag:'wx'});await fs.rename(temp,file);}
      finally{try{await fs.unlink?.(temp);}catch{}}});
    pending=next.catch(()=>{});return next;
  }
  return {record,flush:()=>pending,async forJob(digest){if(!DIGEST.test(digest??''))return [];await pending;return (await read()).filter(r=>r.job_digest===digest);}};
}

/** Owner-local rendering; never presented as a verified remote execution receipt. */
export function probeReceiptDetails(value) {
  const receipt=sanitizeProbeDiagnostics(value);if(!receipt)return null;
  const label=receipt.attempt_id?'Saved job check result':'Saved check result; job not started';
  const failure=receipt.first_failure;
  const summary=failure?'The check '+(failure.outcome==='timed_out'?'timed out':failure.outcome==='cancelled'?'was cancelled':'failed')+
    ' while '+probePhaseLabel(failure.phase)+'.':receipt.phases.some(p=>p.outcome==='deferred')?'The check is waiting for cleanup.':'The check phases were recorded.';
  return {label,summary,receipt};
}

export function renderProbeReceiptDetails(values) {
  const details=(Array.isArray(values)?values:[]).slice(-64).map(probeReceiptDetails).filter(Boolean);
  if(!details.length)return 'No saved result from a local check is retained for this job.\n';
  return details.map(({label,summary,receipt})=>[label,summary,
    'Local check observations, separate from the signed saved result.',
    ...receipt.phases.map(p=>probePhaseLabel(p.phase)+': '+p.outcome.replace('_',' ')+'; '+
      p.started_at+' to '+(p.ended_at??'still running')+'; '+
      (p.effective_deadline_elapsed_ms===null?'deadline not observed':p.deadline_source+' deadline '+p.effective_deadline_elapsed_ms+' ms from check start')+'.')
  ].join('\n')).join('\n\n')+'\n';
}
