import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DIALS, EXPLAINER, LIMIT, LINES, STRATEGY_COPY, CHOOSER_DIALS, CHOOSER_EXPLAINER, lendingStatus, retainedJobStatus} from "../lib/v1/lending-status-copy.mjs";

// The reviewed lending copy (evidence/ui-copy-1024/LENDING-COPY.md) and its binding wording rules. Synthetic only.
const BANNED = /guarantee|\bsafe|insurance|won['’]t need|finish/i;
const shipped = () => [...Object.values(LINES), EXPLAINER, LIMIT.sentence, LIMIT.adjacent,
  ...Object.values(DIALS).flatMap(dial => [dial.description, dial.detail]),
  ...Object.values(CHOOSER_DIALS), CHOOSER_EXPLAINER,
  ...Object.values(STRATEGY_COPY).flatMap(strategy => [strategy.label, strategy.description])];

test('no shipped lending copy uses a banned word, and none says the job "finishes"', () => {
  for (const text of shipped()) assert.doesNotMatch(text, BANNED, text);
});

// The paper sentence ships with "promise" where the paper says "guarantee" (UX 6). No shipped copy uses the banned word.
test('the paper sentence ships with "promise" in place of "guarantee", and no shipped copy uses a banned word', () => {
  assert.equal(LIMIT.sentence, 'Your setting aims to keep the chance of lending reducing your service at 10%, 25%, or 50% per week '
    + 'under Faravan\'s model of usage; that model is still being checked against real weeks, so this is a target, not a measured '
    + 'rate or a promise, and heavy or unexpected demand can exceed it.');
  assert.doesNotMatch(LIMIT.sentence, BANNED);
});

test('the protection dial and its explanation call each figure a risk target, never a measured frequency', () => {
  assert.deepEqual(DIALS, {
    keep_more_for_me: {description: 'Keep the most for yourself; lend the share the model permits.',
      detail: 'The biggest reserve stays with you; friends may use the allowance the model permits. Risk target: 10%. Under Faravan\'s model, this is the chance that your own use needs what was lent.'},
    balanced: {description: 'A fair split between you and your friends.',
      detail: 'You keep a reserve and friends may use what the model leaves after it. Risk target: 25%. Under Faravan\'s model, this is the chance that your own use needs what was lent.'},
    share_more: {description: 'Friends get the most; you keep the least.',
      detail: 'Your reserve is smallest, so friends get the most and your own use is more likely to need what was lent. Risk target: 50%.'},
  });
  assert.equal(EXPLAINER, 'The risk target is what the setting aims for, not a measured rate. It is the chance, under Faravan\'s '
    + 'model of how usage varies, that your own use needs the part already lent out. That model is still being checked against real '
    + 'weeks, so treat the number as a setting, not a forecast. You can stop new lending at any moment. Running jobs keep their '
    + 'saved limits; use Stop to ask Faravan to end one. A job may use quota from your next window if it cannot be stopped before '
    + 'reset. Faravan holds new jobs when it cannot confirm stop support.');
});

test('each named cause says whether the owner must act or the next read clears it', () => {
  for (const id of ['identity', 'funding', 'executor', 'executor_failed', 'queue', 'controls',
    'model_unavailable', 'model_evidence']) {
    assert.match(LINES[id], /This needs you:|clears on its own/, id);
  }
  assert.equal(LINES.paused, 'Paused for new jobs; running jobs continue within their saved limits.');
  assert.equal(LINES.stopped, 'Stopped for new jobs; running jobs continue within their saved limits.');
  for(const id of ['stop_bound','evidence','invalid_evidence','history','conversion']) {
    assert.match(LINES[id],/Usage estimate:/);
    assert.doesNotMatch(LINES[id],/Holding|waiting|This needs you/i);
  }
  assert.doesNotMatch(LINES.evidence + LINES.invalid_evidence, /trusted evidence|evidence for this job|failed its checks/i);
});

test('a strategy ceiling points the owner to the lending controls', () => {
  const status = lendingStatus({reason: 'strategy_limit'});
  assert.equal(status.id, 'strategy_limit');
  assert.match(status.line, /lending limit you set/);
  assert.deepEqual(status.recovery, {who: 'owner', action: 'review the Lend page'});
});

test('unknown strategy settings give the owner one action on Limits', () => {
  const status = lendingStatus({reason: 'strategy_config_unknown', reasonCode: 'objective_strategy_config_unknown'});
  assert.equal(status.id, 'strategy_config_unknown');
  assert.match(status.line, /settings for your lending strategy/);
  assert.deepEqual(status.recovery, {who: 'owner', action: 'review your strategy on the Limits page'});
  assert.equal(lendingStatus({reason: 'objective_evidence_unknown'}).id, 'usage_estimate');
});

test('the owner state wins and imported history carries its basis line and explainer', () => {
  assert.equal(lendingStatus({lendingOn: false, admitted: true}).id, 'stopped');
  assert.equal(lendingStatus({intentOn: false, admitted: true}).id, 'paused');
  assert.equal(lendingStatus({admitted: true, active: true}).line, LINES.lend);
  assert.equal(lendingStatus({admitted: true}).id, 'ready', 'an admitted quote alone is readiness, not lending');
  const own = lendingStatus({reason: 'owner_band', protectionSource: 'history'});
  assert.equal(own.line, LINES.reserve);
  assert.equal(own.basis.line, LINES.own_weeks);
  assert.equal(own.explainer, EXPLAINER);
  assert.equal(lendingStatus({reason: 'owner_band'}).basis, null, 'no own-weeks basis without a history source');
});

test('no dial or explainer line states a frequency the replay cannot support', () => {
  for (const text of [...Object.values(DIALS).map(d => d.detail), EXPLAINER, LIMIT.sentence])
    assert.doesNotMatch(text, /of the time|almost never|\bcap:/i, text);
});

test('missing conversion is an estimate note and cannot override lifecycle or actual holds',()=>{
  const detail={reason:'calibration_missing',scope:'plan',provider:'codex',plan:'plus',model:'gpt-6-sol',window:'weekly'};
  const result=lendingStatus({reason:'conversion_unknown',detail});
  assert.match(result.line,/starting estimate/);
  assert.equal(result.recovery,undefined);
  const model=lendingStatus({reason:'conversion_unknown',detail:{...detail,scope:'model_window',plan:'pro',window:'five_hour'}});
  assert.match(model.line,/starting estimate/);
  assert.equal(model.recovery,undefined);
  for (const options of [{admitted:true},{admitted:true,active:true},{lendingOn:false},{intentOn:false},{reason:'refresh_failed'}]) {
    assert.deepEqual(lendingStatus({reason:'conversion_unknown',...options,detail}),
      lendingStatus({reason:'conversion_unknown',...options}));
  }
  assert.deepEqual(lendingStatus({reason:'conversion_unknown',detail:{...detail,plan:'bad\\nplan'}}),
    lendingStatus({reason:'conversion_unknown'}));
});

test('missing model-window calibration permits a starting estimate without a repair action',()=>{
  for (const [provider,model] of [['codex','gpt-6-sol'],['claude','claude-sonnet-5-5']]) {
    const result=lendingStatus({reason:'conversion_unknown',detail:{
      reason:'calibration_missing',scope:'model_window',provider,model,plan:'pro',window:'five_hour'}});
    assert.equal(result.id,'usage_estimate');
    assert.match(result.line,/starting estimate/);
    assert.equal(result.recovery,undefined);
  }
});

test('retained job copy safely names failure class and does not invent unknown times', async () => {
  const {retainedJobStatus} = await import('../lib/v1/lending-status-copy.mjs');
  const status = lendingStatus({reason:'refresh_failed'});
  const at = Date.parse('2026-11-01T18:54:00Z');
  const result = retainedJobStatus({status,assessedAt:at,now:at+120_000,
    probe:{provider:'codex',failure_class:'usage_http_503',body:'SECRET_BODY'}});
  assert.match(result.line,/2026-11-01T18:54:00.000Z \(2 minutes ago\)/);
  assert.match(result.line,/Codex usage check returned HTTP 503/);
  assert.doesNotMatch(result.line,/SECRET_|verdict|receipt|attempt|settled|lease|clears on its own/i);
  for (const assessedAt of [null,undefined,NaN,at+1]) {
    const unknown = retainedJobStatus({status,assessedAt,now:at,
      probe:{provider:'SECRET_PROVIDER',failure_class:'SECRET_CLASS'}});
    assert.equal(unknown.assessedAt,null);
    assert.equal(unknown.ageMs,null);
    assert.match(unknown.line,/at an unknown time/);
    assert.doesNotMatch(unknown.line,/SECRET_|ago/);
  }
});

test('retained deferrals explain the historical cause without a live holding sentence',()=>{
  const now=Date.UTC(2026,9,29);
  for(const reason of ['account_busy','probe_deferred']) {
    const probe={reason,provider:'codex',failure_class:reason==='account_busy'?'probe_busy':'probe_deferred',
      ...(reason==='probe_deferred'?{retry_at:now+60_000,deferral_cause:'rate_limited'}:{})};
    const status=lendingStatus({reason,detail:probe});
    const retained=retainedJobStatus({status,probe,assessedAt:now-60_000,now});
    assert.match(retained.line,/The last job was held at .* because /);
    assert.ok(retained.line.includes(reason==='account_busy'
      ? 'because the account was busy, so its allowance was not checked then'
      : 'because the allowance check was waiting for its next run'));
    assert.match(retained.line,/usage check was (busy|deferred)/);
    assert.doesNotMatch(retained.line,/Holding —|It clears on its own|verdict|receipt|attempt|settled|lease/i);
    assert.match(retained.line,/The next job is checked again before it can run\.$/);
  }
});

test('identity holds name the affected agent and keep unknown distinct from mismatch', () => {
  for (const [provider, name] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    const unknown = lendingStatus({reason:'identity_unknown', detail:{provider}});
    const mismatch = lendingStatus({reason:'identity_mismatch', detail:{provider}});
    assert.match(unknown.line, new RegExp(name));
    assert.match(unknown.line, /could not confirm/);
    assert.doesNotMatch(unknown.line, /different account|This needs you/);
    assert.equal(unknown.recovery.who, 'automatic');
    assert.match(mismatch.line, new RegExp(name));
    assert.match(mismatch.line, /different account/);
    assert.match(mismatch.line, /Sign in/);
    assert.equal(mismatch.recovery.who, 'owner');
    assert.doesNotMatch(unknown.line + mismatch.line, /verdict|receipt|attempt|settled|lease/i);
  }
});

test('fixed share describes the protected balance without promising unused capacity', () => {
  assert.equal(STRATEGY_COPY.fixed_share.description,
    'Friends use at most a fixed share of each week, and new jobs are checked against your protected balance before they start.');
});

test('budget holds identify who can change each limit', async () => {
  const {budgetLimitCopy} = await import('../lib/v1/lending-status-copy.mjs');
  const base = {model:'claude-sonnet-5-5', minimumUsd:5.29, limitUsd:2};
  for (const limitUsd of [2,4]) {
    const detail = {...base,source:'borrower',limitUsd};
    const lender = lendingStatus({reason:'budget_too_small',detail});
    assert.match(lender.line, /job's own limit/);
    assert.match(lender.line, /You need to do nothing/);
    assert.equal(lender.recovery.who, 'borrower');
    assert.match(budgetLimitCopy(detail,{borrower:true}).line, /Raise the job limit to at least \$6/);
  }
  const strategy = lendingStatus({reason:'budget_too_small',detail:{...base,source:'strategy'}});
  assert.match(strategy.line, /limit you set for this lending strategy allows \$2\.00 for this job/);
  assert.doesNotMatch(strategy.line, /per-job limit/);
  assert.equal(strategy.recovery.who, 'owner');
  for (const copy of [strategy]) assert.doesNotMatch(copy.line + copy.recovery.action, /clear/);
  const spare = lendingStatus({reason:'budget_too_small',detail:{...base,source:'spare'}});
  assert.match(spare.line,/spare allowance cannot cover one Claude Sonnet 5.5 call right now \(\$5.29\)/);
  assert.equal(spare.recovery.who, 'automatic');
});

test('funding detail changes only copy and recovery for a held account at its Codex limit', () => {
  const detail = {fundingReason:'limit_reached'};
  const held = lendingStatus({reason:'funding_unknown', detail});
  assert.equal(held.id, 'funding');
  assert.equal(held.line, LINES.codex_limit);
  assert.deepEqual(held.recovery, {who:'automatic', when:'the limit resets'});
  for (const options of [{admitted:true}, {admitted:true, active:true}, {lendingOn:false}, {intentOn:false}])
    assert.deepEqual(lendingStatus({reason:'funding_unknown', ...options, detail}),
      lendingStatus({reason:'funding_unknown', ...options}));
  assert.equal(lendingStatus({reason:'funding_unknown', detail:{fundingReason:'plan_unobserved'}}).line, LINES.funding);
  assert.equal(lendingStatus({reason:'executor_unknown', detail}).line, LINES.executor);
});

test('retired proof holds remain readable as historical assessments', () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const line = retainedJobStatus({status:{id:'evidence'}, assessedAt:now - 5_000, now}).line;
  assert.match(line, /because it was waiting for a current quota reading\. The next job/);
  assert.match(retainedJobStatus({status:{id:'reserve'}, assessedAt:now - 5_000, now}).line, /because your reserve covered everything spare then\./);
});

test('age-free retained history depends on the stored timestamp, not the read clock',()=>{
  const at=Date.UTC(2026,10,8,6);
  const status={id:'evidence'};
  const history=retainedJobStatus({status,assessedAt:at,includeAge:false});
  assert.equal(history.assessedAt,at);
  assert.equal(Object.hasOwn(history,'ageMs'),false);
  assert.match(history.line,/at 2026-11-08T06:00:00.000Z because/);
  assert.doesNotMatch(history.line,/ago/);
  for (const now of [at-1,at,at+3,at+60_001,at+3_600_001])
    assert.deepEqual(retainedJobStatus({status,assessedAt:at,now,includeAge:false}),history);
  for (const assessedAt of [null,undefined,NaN,-1,1.5,8.64e15+1]) {
    const unknown=retainedJobStatus({status,assessedAt,includeAge:false});
    assert.equal(unknown.assessedAt,null);
    assert.match(unknown.line,/at an unknown time/);
    assert.equal(Object.hasOwn(unknown,'ageMs'),false);
  }
});
