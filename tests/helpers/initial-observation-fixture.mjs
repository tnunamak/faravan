import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPace50Candidate} from '../../lib/v1/lender-pace50.mjs';
import {createRealPace50Source} from './real-source.mjs';
import {createLendingLedger} from '../../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../../lib/v1/lending-probe.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';

/* Diagnostic controls supply the declared jobRunning input; they do not model
 * an installed lender preparing event or establish a real failure cause. */
export async function initialObservationFixture(t, {busy = false, utilization = 20, weeklyUtilization = utilization,
  shortUtilization = utilization, status = 200, startAt = Date.UTC(2026,9,29), weeklyResetAt = null,
  shortResetAt = null, maxJobUsd = 2,
  kappaForUsage = () => ({upper_micro:100000,binding:{account_sha256_16:'1111222233334444'},provenance:{method:'fixture'}})} = {}) {
  let at = startAt, runs = 0, running = busy;
  weeklyResetAt ??= at + 7 * 86400000;
  shortResetAt ??= at + 5 * 3600000;
  const directory = mkdtempSync(join(tmpdir(),'initial-observation-'));
  const ledger = createLendingLedger({file:join(directory,'ledger.json'),now:()=>at});
  const probe = createLendingProbe({ledger,now:()=>at,runGuest:async()=>{
    runs++;
    return {stdout:JSON.stringify({faravan_probe:1,status,body:{
      five_hour:{utilization:shortUtilization,resets_at:shortResetAt},
      seven_day:{utilization:weeklyUtilization,resets_at:weeklyResetAt},extra_usage:{is_enabled:false}},
      identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaa0000bbbb1111'},
      guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),
      executor:{backend_id:'docker-sbx',sbx_version:'sbx version v0.49.2'},
      stop:{delivered:true,fallback:null,latency_ms:1,removed:true}};
  }});
  const readings = createLendingReadings({ledger,probe,plans:()=>({claude:'max20'}),
    jobRunning:()=>running,now:()=>at});
  const source = createRealPace50Source({readings,funding:p=>probe.funding(p),
    expectedIdentity:()=>({email_sha256_16:'aaaa0000bbbb1111'}),
    expectedExecutor:{backend_id:'docker-sbx',accepts:()=>true},stopBoundMs:35_000,
    windowOrigin:()=>new Map([['seven_day','owner'],['five_hour','owner']]),
    kappaForUsage});
  source.objectiveInputFor = createSyntheticPace50Source({start:at,
    resets:{weekly:weeklyResetAt-at,short:shortResetAt-at},
    used:{weekly:weeklyUtilization*1e6,short:shortUtilization*1e6},kappa:{weekly:100000,short:100000}}).objectiveInputFor;
  const {candidate,adapter} = createPace50Candidate({directory,account:'1111222233334444',
    account_week_id:`1111222233334444:weekly:${weeklyResetAt}`,source,now:()=>at,
    contextFor:()=>({consent:true,ownerAbsent:true,plan:'max20'})});
  t.after(async()=>{await adapter.close();await probe.close();rmSync(directory,{recursive:true,force:true});});
  const args = {provider:'claude',model:'claude-haiku-5-5',plan:'max20'};
  const job = () => ({budget_v1:{max_list_usd:maxJobUsd},requirements:{limits:{wall_seconds:60}},
    expires_at:new Date(at+3600000).toISOString()});
  const reserve = () => candidate.reserve({attemptId:'initial',jobId:'initial',provider:args.provider,
    model:args.model,automatic:false,ownerAbsent:true,job:job()});
  const preview = () => candidate.preview({jobId:'preview-initial',provider:args.provider,
    model:args.model,automatic:false,ownerAbsent:true,job:job()});
  return {candidate,adapter,probe,readings,args,job,reserve,preview,runs:()=>runs,
    busy:value=>{running=value;},advance:ms=>{at+=ms;},
    time:()=>at,rollShortWindow:()=>{shortResetAt=at+5*3600000;shortUtilization=0;},
    rollWeeklyWindow:()=>{weeklyResetAt=at+7*86400000;weeklyUtilization=0;}};
}
