import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {lendingBlockers} from '../../lib/v1/blockers.mjs';
import {lendingStatus,usageEstimateNote} from '../../lib/v1/lending-status-copy.mjs';
import {formatLendingProjection} from '../../lib/v1/lending-summary.mjs';

test('retired qualification failure does not block otherwise ready lending',()=>{
  const view=lendingBlockers({docker:{installed:true,running:true,signedIn:true},intent:{on:true},
    agents:[{id:'synthetic',enabled:true,installed:true,signedIn:true}],isolationFailure:'synthetic old failure'});
  assert.equal(view.canLend,true);
  assert.ok(!view.items.some(row=>row.key==='isolation_check'));
});

test('missing history and aged usage are estimate notes without repair actions',()=>{
  for(const reason of ['history_unknown','reading_stale','usage_unknown','conversion_unknown','executor_unknown','stop_bound_unknown','seam_unknown_meter_age','fluid_invalid_history']){
    const status=lendingStatus({reason,detail:{ageMs:1500000}});
    assert.equal(status.id,'usage_estimate',reason);
    assert.match(status.line,/1500000 ms old/);
    assert.equal(status.recovery,undefined);
    assert.doesNotMatch(status.line,/Holding|waiting|blocked|refresh/i);
  }
  assert.match(usageEstimateNote({hasReading:false}),/no aggregate reading.*starting estimate/);
});

test('actual guard, account mismatch and provider limit remain truthful failures',()=>{
  assert.equal(lendingStatus({reason:'guard_runtime_unavailable'}).recovery.who,'owner');
  assert.equal(lendingStatus({reason:'identity_mismatch'}).recovery.who,'owner');
  assert.equal(lendingStatus({reason:'arm_failed'}).recovery.who,'owner');
  assert.equal(lendingStatus({reason:'launch_not_authorized'}).recovery.who,'owner');
  assert.equal(lendingStatus({reason:'funding_unknown',detail:{fundingReason:'limit_reached'}}).line.includes('usage limit'),true);
});

test('local Docker readiness does not claim borrowing is unavailable',()=>{
  for(const admissionReason of ['sandbox_not_ready','setup_required','docker_signed_out']){
    const view=formatLendingProjection({schemaVersion:2,kind:'lending',intent:'on',admission:'blocked',admissionReason,execution:'idle',executionJob:null,evidence:{intentState:'blocked',dailyLimitReached:false,executionState:'idle'},version:null});
    assert.equal(view.headline,'Lending can’t start here');
    assert.match(view.reason,/still send jobs to another lender/);
    assert.doesNotMatch(view.reason,/No job can start/);
  }
});

test('shared summary uses a 25-minute aged reading as a note with no repair action',async()=>{
  const {lendingSummary}=await import('../../lib/v1/lending-summary.mjs');
  const now=2000000;
  const summary=lendingSummary({schemaVersion:2,kind:'lending',intent:'on',admission:'allowed',admissionReason:null,
    execution:'idle',executionJob:null,evidence:{intentState:'ready',dailyLimitReached:false,executionState:'idle'},version:null},
    {now,selectedAgents:['codex'],lendingAccounts:[{provider:'codex',decision:{admitted:false,reason:'reading_stale',
      windows:[{state:'open',window_id:'codex:10080',used_pct:20,observed_at:new Date(now-1500000).toISOString()}]}}]});
  assert.equal(summary.action,null);
  assert.equal(summary.headline,'Lending on');
  assert.match(summary.reason,/80%.*1500000 ms old/);
});

test('shared summary keeps real account failures ahead of estimates in either order',async()=>{
  const {lendingSummary}=await import('../../lib/v1/lending-summary.mjs');
  const projection={schemaVersion:2,kind:'lending',intent:'on',admission:'allowed',admissionReason:null,
    execution:'idle',executionJob:null,evidence:{intentState:'ready',dailyLimitReached:false,executionState:'idle'},version:null};
  const estimate={provider:'codex',decision:{admitted:false,reason:'reading_stale'}};
  const summarize=lendingAccounts=>lendingSummary(projection,{selectedAgents:['codex','claude-code-subscription'],lendingAccounts});
  for(const reason of ['guard_runtime_unavailable','identity_mismatch']){
    const failure={provider:'claude',decision:{admitted:false,reason,status:lendingStatus({reason})}};
    const expected=summarize([failure]);
    for(const accounts of [[estimate,failure],[failure,estimate]]){
      const actual=summarize(accounts);
      assert.deepEqual(actual,expected,reason);
      assert.notEqual(actual.action,null,reason);
    }
  }
  const allEstimates=summarize([estimate,{provider:'claude',decision:{admitted:false,reason:'history_unknown'}}]);
  assert.equal(allEstimates.headline,'Lending on');
  assert.equal(allEstimates.action,null);
  assert.match(allEstimates.reason,/Usage estimate/);
});
