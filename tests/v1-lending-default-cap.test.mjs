import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createPace50Candidate, defaultOwnerMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd, DEFAULT_RUN_MODEL} from '../lib/v1/lending-meter.mjs';
import {createRealPace50Source} from './helpers/real-source.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
const T = Date.parse('2026-11-02T12:00:00Z');

for (const saved of [null, 4, 2]) test(`unknown plan with 14 percent weekly use and ${saved === null ? 'unset' : 'saved'} cap`, async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'default-cap-'));
  const ownerSettings = createOwnerSettings({directory:join(directory, 'owner')});
  if (saved !== null) ownerSettings.set({by:'owner', reason:'test', now:T, maxJobUsd:saved});
  const source = createRealPace50Source({
    readings:async () => ({windows:[
      {window_id:'seven_day', window_minutes:10080, used_pct:14, observed_at:T, resets_at:T + 72 * 3600e3, state:'open', source:'probe'},
      {window_id:'five_hour', window_minutes:300, used_pct:0, observed_at:T, resets_at:null, state:'not_open', source:'probe'},
    ]}),
    funding:() => ({observed_at:T, extra_usage:'disabled',
      guest_auth:{loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty'},
      identity:{account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'},
      executor:{backend_id:'test', sbx_version:'test'},
      stop:{delivered:true, fallback:null, latency_ms:1, removed:true}}),
    expectedIdentity:() => ({email_sha256_16:'aaaabbbbccccdddd'}),
    expectedExecutor:{backend_id:'test', accepts:() => true}, stopBoundMs:35_000,
  });
  const build = createSyntheticPace50Source({start:T}).objectiveInputFor;
  source.objectiveInputFor = args => {
    const objective = build(args);
    for (const window of Object.values(objective.windows)) window.conversion = 'native_window';
    objective.job.worstCallUsdMicro = Math.ceil(claudeCallHeadroomUsd(DEFAULT_RUN_MODEL.claude) * 1_000_000);
    return objective;
  };
  const pace = createPace50Candidate({directory, source, ownerSettings, now:() => T,
    account:'synthetic-account', account_week_id:'synthetic-week-1', contextFor:() => ({plan:'unknown'})});
  t.after(async () => {await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  {
    await pace.candidate.observe({provider:'claude', model:DEFAULT_RUN_MODEL.claude, now:T});
    const status = await pace.candidate.projectStatus({provider:'claude', snapshotOnly:true});
    if (saved === null) {
      assert.notEqual(status.reason, 'budget_too_small', JSON.stringify(status));
      assert.equal(status.objective.requestedUsd, 5.29);
    } else {
      assert.equal(status.reason, 'budget_too_small');
      assert.equal(status.objective.budgetLimit.source, 'owner');
      assert.equal(status.objective.budgetLimit.minimumUsd, 5.29);
    }
    if (saved === null) for (const cap of [2,4]) {
      const held = await pace.candidate.preview({provider:'claude',model:DEFAULT_RUN_MODEL.claude,ownerAbsent:true,
        jobId:'borrower-cap-' + cap,job:{budget_v1:{max_list_usd:cap},requirements:{limits:{wall_seconds:300}},expires_at:new Date(T+3600e3).toISOString()}});
      assert.equal(held.reason,'budget_too_small');
      assert.equal(held.objective.budgetLimit.source,'borrower');
      assert.match(held.objective.reasonText,/You need to do nothing/);
    }
    assert.equal(defaultOwnerMaxJobUsdForModel('claude', DEFAULT_RUN_MODEL.claude), 9.28);
    assert.equal(claudeCallHeadroomUsd(DEFAULT_RUN_MODEL.claude), 5.28);
  }
  const grant = await pace.candidate.reserve({attemptId:'default-cap', jobId:'small-job', provider:'claude',
    model:DEFAULT_RUN_MODEL.claude, automatic:true, ownerAbsent:true,
    job:{requirements:{limits:{wall_seconds:300}}, expires_at:new Date(T + 3600e3).toISOString()}});
  assert.equal(grant.ok, saved === null, JSON.stringify(grant));
  if (saved === null) {
    assert.equal(grant.lendingBudget.budget.limit, 4);
    assert.equal((await pace.candidate.admitStart('default-cap')).ok, true);
  }
  else assert.equal(grant.policyReason, 'budget_too_small', 'a saved cap is never raised');
});

test('unset limits use the same exact default for settings and admission', () => {
  assert.equal(defaultOwnerMaxJobUsdForModel('claude', DEFAULT_RUN_MODEL.claude), 9.28);
  assert.equal(defaultOwnerMaxJobUsdForModel('claude', 'claude-haiku-5-5'), 4);
  assert.equal(defaultOwnerMaxJobUsdForModel('codex', DEFAULT_RUN_MODEL.codex), 4);
});
