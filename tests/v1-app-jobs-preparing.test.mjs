import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/offers-jobs-fixture.mjs';

test('an accepted incoming job stays listed while preparing without counting as a run', {timeout:90000}, async t => {
  const f = await appFixture(t, {hold:true});
  const {owner,lender,circle} = await f.connect();
  let releasePreparation, enteredPreparation;
  const preparing = new Promise(resolve => {enteredPreparation = resolve;});
  const held = new Promise(resolve => {releasePreparation = resolve;});
  const prepare = lender.backend.prepare.bind(lender.backend);
  t.after(() => {releasePreparation();lender.backend.release();});
  try {
    const input = {circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
      prompt:'Keep the accepted request visible',harness:'codex'};
    const sent = await api(owner.app,'/api/jobs',{method:'POST',body:input});
    await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
    await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
    await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
    await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
    const card = await waitFor(async () => (await api(lender.app,'/api/approvals'))[0],'review card');
    assert.deepEqual(await api(lender.app,'/api/jobs'),[],'a request awaiting approval is not accepted work');
    lender.backend.prepare = async spec => {
      enteredPreparation();
      await held;
      return prepare(spec);
    };
    await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
    await preparing;
    const queued = await api(owner.app,'/api/jobs',{method:'POST',body:{...input,prompt:'An unrelated waiting request'}});
    const rows = await api(lender.app,'/api/jobs');
    const row = rows.find(job => job.job_digest === sent.jobDigest);
    assert.ok(row,'accepted job is reachable while sandbox preparation is held');
    assert.equal(row.role,'received');
    assert.notEqual(row.ran,true,'acceptance does not claim execution');
    assert.equal(row.current_attempt.holder,lender.app.device.keyId);
    assert.equal(row.current_attempt.execution_started_at,null);
    assert.equal(lender.backend.calls.some(([kind]) => kind === 'run'),false);
    assert.equal(rows.some(job => job.job_digest === queued.jobDigest),false,'an unowned waiting request stays out of Jobs');
    const sentRows = await api(owner.app,'/api/jobs');
    assert.equal(sentRows.find(job => job.job_digest === sent.jobDigest).role,'sent');
    const detail = await api(lender.app,'/api/jobs/'+sent.jobDigest+'?circle='+encodeURIComponent(circle.id));
    assert.equal(detail.current_attempt.attempt_id,row.current_attempt.attempt_id,'the row links to the same accepted attempt');
    releasePreparation();
    await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'),'execution begins');
    const running = await waitFor(async () => (await api(lender.app,'/api/jobs')).find(job => job.job_digest === sent.jobDigest && job.ran === true),'observed execution');
    assert.equal(running.role,'ran');
    assert.equal(running.current_attempt.attempt_id,row.current_attempt.attempt_id);
    await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
    lender.backend.release();
    await waitFor(async () => !(await api(lender.app,'/api/lending')).current,'completed execution');
  } finally {
    releasePreparation();
    lender.backend.release();
  }
});
