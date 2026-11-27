import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {deadlineRecoveryHold,deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';
// The optional root runs the identical assertions against untouched pinned
// probe code for behavioral RED. No backend/executor graph is imported.
const probeUrl=process.env.FARAVAN_DEADLINE_PROBE_BASE
  ?pathToFileURL(resolve(process.env.FARAVAN_DEADLINE_PROBE_BASE,'lib/v1/lending-probe.mjs'))
  :new URL('../lib/v1/lending-probe.mjs',import.meta.url);
const {createLendingProbe,sanitizeProbeFailure}=await import(probeUrl.href);
const at=1_000_000;
const good=()=>({stdout:JSON.stringify({faravan_probe:1,status:200,body:{rate_limit:{allowed:true,limit_reached:false,
  primary_window:{used_percent:20,limit_window_seconds:604800,reset_at:2000000},secondary_window:null}}})});

test('recovery refusal reports a hold, never a sandbox-start failure or ledger write',async()=>{
  let writes=0;const hold=deadlineRecoveryHold(false,{rowCount:44});
  const probe=createLendingProbe({now:()=>at,ledger:{recordReadings:()=>writes++},
    runGuest:async()=>{throw deadlineRecoveryError(hold);}});
  const result=await probe.probe('codex');
  assert.equal(result.reason,'cessation_unverified');assert.equal(result.recovery_hold.row_count,44);
  assert.equal(writes,0);assert.equal(probe.outcome('codex').reason,'cessation_unverified');
  const view=sanitizeProbeFailure(result,'codex');assert.equal(view.reason,'cessation_unverified');
  assert.equal(view.failure_class,'probe_deferred');assert.doesNotMatch(JSON.stringify(view),/sandbox_start_failed/);
  await probe.close();
});

test('a held check does not impose failed-create cadence after recovery',async()=>{
  let held=false,calls=0;const hold=deadlineRecoveryHold(false,{rowCount:1});
  const probe=createLendingProbe({now:()=>at,runGuest:async()=>{calls++;if(held)throw deadlineRecoveryError(hold);return good();}});
  assert.equal((await probe.probe('codex')).ok,true);assert.equal(probe.due('codex',{pageOpen:true}),false);
  held=true;await probe.probe('codex');held=false;
  assert.equal(probe.due('codex'),false);
  assert.equal(probe.due('codex',{pageOpen:true}),true);
  assert.equal((await probe.probe('codex')).ok,true);assert.equal(calls,3);await probe.close();
});

test('returned hold results retain their code without parsing empty guest output',async()=>{
  const hold=deadlineRecoveryHold(false,{rowCount:2});
  const probe=createLendingProbe({now:()=>at,runGuest:async()=>({exitCode:1,stdout:'',probe_failure:'cessation_unverified',recovery_hold:hold})});
  assert.equal((await probe.probe('codex')).reason,'cessation_unverified');await probe.close();
});
