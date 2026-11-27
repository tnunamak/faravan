import test from 'node:test';
import assert from 'node:assert/strict';
import {LENDING_POLICY_DEFAULTS} from '../../../lib/v1/lending-policy.mjs';
import {DIALS, CHOOSER_DIALS, CHOOSER_EXPLAINER, RECOVERY, lendingStatus} from '../../../lib/v1/lending-status-copy.mjs';
import {objectiveExplanationVM, policyDraft, validatePolicy, policySummary, PROTECTION_POSITIONS, LENDING_STRATEGIES, PLAN_OPTIONS, planHint, migrationVM, POLICY_LABELS,
  rulesVM, ruleDraft, validateRule, nextRules, rulePeople, whenText} from './lending-policy-view.mjs';
import {ZONE, NOW} from './lending-policy.fixture.mjs';

const forbidden = [/busy_week/, /session_tail/, /hourly_rate/, /per_job/, /preset/i];

test('protection dial exposes only the three objective positions and defaults to Keep more for me', () => {
  assert.deepEqual(PROTECTION_POSITIONS.map(({id, label}) => [id, label]), [
    ['keep_more_for_me', 'Keep more for me'], ['balanced', 'Balanced'], ['share_more', 'Share more'],
  ]);
  assert.deepEqual(Object.fromEntries(PROTECTION_POSITIONS.map(({id, description}) => [id, description])), CHOOSER_DIALS);
  assert.match(CHOOSER_EXPLAINER, /aims for, not a measured rate/);
  assert.doesNotMatch(JSON.stringify([CHOOSER_DIALS, CHOOSER_EXPLAINER]), /expected harm|objective rule/);
  assert.equal(policyDraft().protectionPosition, 'keep_more_for_me');
  assert.deepEqual(LENDING_STRATEGIES.map(({id})=>id), ['automatic','fixed_share','custom']);
  assert.equal(policyDraft().strategy, 'automatic');
  assert.equal(policySummary(LENDING_POLICY_DEFAULTS), 'Keep more for me.');
  assert.equal(policySummary({...LENDING_POLICY_DEFAULTS,strategy:'fixed_share'}), 'Keep more for me.',
    'the internal engine strategy does not replace the owner’s three-position dial copy');
  for (const {id} of PROTECTION_POSITIONS) {
    const result = validatePolicy({...policyDraft(), protectionPosition:id});
    assert.equal(result.ok, true);
    assert.equal(result.policy.protectionPosition, id);
  }
  const invalid = validatePolicy({...policyDraft(), protectionPosition:'unlikely_to_need'});
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.protectionPosition, /three lending settings/);
  for (const strategy of LENDING_STRATEGIES) {
    const selected=validatePolicy({...policyDraft(),strategy:strategy.id});
    assert.equal(selected.ok,true);
    assert.equal(selected.policy.strategy,strategy.id);
  }
  assert.equal(validatePolicy({...policyDraft(),strategy:'lend_all'}).ok,false,'unknown engine strategy values remain invalid');
});
test('the chooser and internal hold use current product language', () => {
  assert.doesNotMatch(CHOOSER_EXPLAINER, /\x53parekin/);
  assert.equal(RECOVERY.internal.action, 'restart Faravan');
  assert.match(lendingStatus({reason:'invalid_input'}).line, /restart Faravan/);
  assert.doesNotMatch([CHOOSER_EXPLAINER, RECOVERY.internal.action].join(' '), /\x53parekin/);
});
test('dial copy names each figure a risk target', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(DIALS).map(([key,value])=>[key,value.detail])), {
    keep_more_for_me:'The biggest reserve stays with you; friends may use the allowance the model permits. Risk target: 10%. Under Faravan\'s model, this is the chance that your own use needs what was lent.',
    balanced:'You keep a reserve and friends may use what the model leaves after it. Risk target: 25%. Under Faravan\'s model, this is the chance that your own use needs what was lent.',
    share_more:'Your reserve is smallest, so friends get the most and your own use is more likely to need what was lent. Risk target: 50%.',
  });
  assert.deepEqual(CHOOSER_DIALS, {
    keep_more_for_me:'The biggest reserve stays with you; friends may use the allowance the model permits. Risk target: 10%. Under Faravan\'s model, this is the chance that your own use needs what was lent.',
    balanced:'You keep a reserve and friends may use what the model leaves after it. Risk target: 25%. Under Faravan\'s model, this is the chance that your own use needs what was lent.',
    share_more:'Your reserve is smallest, so friends get the most and your own use is more likely to need what was lent. Risk target: 50%.',
  });
  assert.doesNotMatch(JSON.stringify([DIALS,CHOOSER_DIALS,CHOOSER_EXPLAINER]), /\b(?:guarantee|safe|insurance|won't need)\b/i);
});

test('policy draft drops retired preset and volume fields instead of recreating them', () => {
  const draft = policyDraft({preset:'unlikely_to_need', e0:0.3, perJobPct:5, hourlyRatePct:2, personWeeklyPct:5,
    protectionPosition:'share_more', accountSlots:2, providerConsent:{claude:true}, accountPlans:{claude:'max20'}});
  assert.equal(draft.protectionPosition, 'share_more');
  assert.equal(draft.accountSlots, 2);
  assert.deepEqual(draft.providerConsent, {claude:true});
  assert.deepEqual(draft.accountPlans, {claude:'max20', codex:'unknown'});
  for (const key of ['preset', 'e0', 'perJobPct', 'hourlyRatePct', 'personWeeklyPct']) assert.equal(key in draft, false);
  const saved = validatePolicy(draft);
  assert.equal(saved.ok, true);
  for (const key of ['preset', 'perJobPct', 'hourlyRatePct', 'personWeeklyPct']) assert.equal(key in saved.policy, false);
});

test('lending explanation uses plain status and basis copy without engine labels', () => {
  const rows = objectiveExplanationVM({priorVersion:'optimistic-default-v1', accounts:[
    {id:'claude', provider:'claude', label:'Claude', decision:{admitted:true, reason:'objective_lend', objective:{
      admission:'allowed', reasonCode:'objective_lend', reasonText:'engine detail', strategyId:'automatic',
      strategyExplanation:'Automatic uses finite whole-week history or the configured demand model.', protectionSource:{seven_day:'model',five_hour:'model'}, nativeMaxBudgetUsd:0}}},
    {id:'codex', provider:'codex', decision:{admitted:true, objective:{admission:'allowed', reasonCode:'objective_lend',
      strategyId:'fixed_share', strategyExplanation:'Fixed share lends up to 20% and keeps at least 30%.',
      reasonText:'Lending after protecting the history band.', protectionSource:{weekly:'strategy',short:'strategy'}, nativeMaxBudgetUsd:2.5}}},
  ]});
  assert.deepEqual(rows.map(row => [row.title, row.admitted, row.reasonCode, row.line, row.basisLine, row.href, row.linkLabel]), [
    ['Claude', true, 'objective_lend', 'Ready to lend to a friend when a job arrives.', 'Using an initial usage estimate. Your lending limits still apply.', '#starting-assumption', 'Starting assumption for new users'],
    ['Codex', true, 'objective_lend', 'Ready to lend to a friend when a job arrives.', 'Using the share you chose.', null, null],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /strategyExplanation|Protection source|declared demand model/);
  assert.doesNotMatch(JSON.stringify(rows), /optimistic-default-v1/, 'the internal model id does not appear in the explanation');
  assert.equal(objectiveExplanationVM({accounts:[{provider:'claude',decision:{objective:{reasonCode:'unknown'}}}]}).length, 0,
    'a partial response does not invent an explanation');
});

test('plan choices round-trip; unknown plans explain the evidence hold without calibration promises', () => {
  const draft = policyDraft({accountPlans:{claude:'max20',codex:'business'}});
  const saved = validatePolicy(draft);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.policy.accountPlans, {claude:'max20',codex:'business'});
  assert.deepEqual(PLAN_OPTIONS.claude.map(([id]) => id), ['unknown','max20','max5','pro']);
  assert.deepEqual(PLAN_OPTIONS.codex.map(([id]) => id), ['unknown','pro','plus','business','team']);
  assert.match(planHint('claude','unknown'), /lends now/);
  assert.match(planHint('codex','pro'), /lends now/);
});

// Was "unsupported plans stay on hold"; no plan holds now: every account lends natively until local logs measure its rate.
test('the plan hint says every plan lends now and that the plan never sets a rate', () => {
  for (const provider of ['claude', 'codex']) for (const [plan] of PLAN_OPTIONS[provider]) {
    const hint = planHint(provider, plan);
    assert.match(hint, /lends now/, provider + ' ' + plan);
    assert.match(hint, /plan label never sets a usage rate/);
    assert.doesNotMatch(hint, /on hold|isn’t supported|certified/);
  }
});

test('legacy migration notice appears only while the server marker is unacknowledged', () => {
  const vm = migrationVM({migration:{fromLegacyPolicy:true, acknowledged:false}});
  assert.match(vm.text, /saved lending strategy was migrated/);
  assert.match(vm.text, /consent and lending rules were preserved/);
  assert.equal(migrationVM({migration:{fromLegacyPolicy:true, acknowledged:true}}), null);
  assert.equal(migrationVM({migration:{fromReserve:30, acknowledged:false}}), null,
    'the deleted reserve migration action does not return');
  for (const pattern of forbidden) assert.doesNotMatch(vm.text, pattern);
});

test('a startup reset uses the page labels, shows old and new values, and never a raw field name', () => {
  const reset = [{field:'warningPct', was:150}, {field:'strategyParams.perJobPct', was:9000}, {field:'machineSlots', was:99},
    {field:'protectionPosition', was:'bogus'}, {field:'stopOnReturn', was:'yes'}, {field:'accountPlans', was:{claude:'x'}}, {field:'surprise', was:1}];
  const vm = migrationVM({migration:{resetAtStartup:true, consentReset:false, acknowledged:false, reset}});
  assert.match(vm.text, /Warning level: 150%, reset to 10%/);
  assert.match(vm.text, /Per-job cap: 9000%, reset to 10%/);
  assert.match(vm.text, new RegExp(POLICY_LABELS.machineSlots + ': 99 jobs, reset to the detected capacity'));
  assert.ok(vm.text.includes(POLICY_LABELS.protectionPosition));
  assert.ok(vm.text.includes(POLICY_LABELS.stopOnReturn));
  assert.match(vm.text, /a saved agent plan could not be read/);
  assert.match(vm.text, /one unrecognized setting was removed/);
  assert.match(vm.text, /Your other settings were kept\./);
  assert.doesNotMatch(vm.text, /Lending was turned off/);
  assert.doesNotMatch(vm.text, /\b[a-z]+[A-Z][A-Za-z]*\b/, 'no camelCase key such as warningPct or perJobPct');
  assert.doesNotMatch(vm.text, /strategyParams|\{|\}|\[object/);
  for (const pattern of forbidden) assert.doesNotMatch(vm.text, pattern);
  for (const word of ['verdict', 'receipt', 'attempt', 'settled', 'lease']) assert.doesNotMatch(vm.text, new RegExp(word, 'i'));
  const off = migrationVM({migration:{resetAtStartup:true, consentReset:true, acknowledged:false, reset:[{field:'providerConsent', was:{claude:'yes'}}]}});
  assert.match(off.text, /Lending was turned off\. Turn it on again and choose the agents to lend\./);
  assert.doesNotMatch(off.text, /providerConsent|claude/);
  const whole = migrationVM({migration:{resetAtStartup:true, consentReset:true, acknowledged:false, reset:[{field:'lendingPolicy', was:'broken'}]}});
  assert.match(whole.text, /could not be read/);
  assert.doesNotMatch(whole.text, /broken/);
});

test('standing rules: named people, agents, limits and expiry; create, edit, renew and revoke as one list', () => {
  const devices = {fingerprint: 'me', circles: [{circle: 'c1', members: [{key_id: 'me', device_name: 'Laptop'}, {key_id: 'k-sam', localName: 'Sam'}, {key_id: 'k-ana', ownerName: 'Ana'}]}]};
  assert.deepEqual(rulePeople('c1', devices), [{id: 'k-sam', name: 'Sam'}, {id: 'k-ana', name: 'Ana'}], 'this computer is never a person in a rule');
  const draft = ruleDraft(null, {circle: 'c1', people: rulePeople('c1', devices), agents: ['codex']});
  assert.deepEqual([draft.maxWallSeconds, draft.jobs, draft.dailyMinutes], [null, '', ''], 'new rules have no picked wall-time or daily volume caps');
  const made = validateRule(draft, {now: NOW, makeId: () => 'r1'});
  assert.equal(made.ok, true);
  assert.deepEqual(made.rule, {id: 'r1', circle: 'c1', people: ['k-sam', 'k-ana'], agents: ['codex'], maxWallSeconds: null, dailyJobs: null, weeklyJobs: null,
    dailyMinutes: null, weeklyMinutes: null, schedule: null, expiresAt: NOW + 30 * 86400000});
  const vm = rulesVM([made.rule], {devices, circles: [{id: 'c1', name: 'Friends'}], now: NOW, zone: ZONE})[0];
  assert.deepEqual([vm.who, vm.scope, vm.until, vm.circleName, vm.endingSoon], ['Sam and Ana', 'Codex · jobs that fit before reset · no daily job cap', 'until Nov 20', 'Friends', false]);
  assert.equal(rulesVM([{...made.rule, expiresAt: NOW + 86400000}], {devices, now: NOW, zone: ZONE})[0].endingSoon, true);
  assert.equal(rulesVM([{...made.rule, expiresAt: NOW - 1}], {devices, now: NOW, zone: ZONE}).length, 0, 'expired rules are not shown as active');
  assert.deepEqual(validateRule({...draft, people: [], maxWallSeconds: 0}, {now: NOW}).errors, {people: 'Choose at least one person.', maxWallSeconds: 'The saved job time limit is not valid.'});
  assert.equal(validateRule({...draft, days: '31'}, {now: NOW}).ok, false, 'no rule lasts longer than 30 days');
  const bounded = validateRule({...draft, jobs: '3', dailyMinutes: '60'}, {now: NOW, makeId: () => 'bounded'});
  assert.deepEqual([bounded.rule.maxWallSeconds, bounded.rule.dailyJobs, bounded.rule.weeklyJobs, bounded.rule.dailyMinutes, bounded.rule.weeklyMinutes], [null, 3, 21, 60, 420]);
  const legacy = {...bounded.rule, id:'legacy', maxWallSeconds:1200};
  assert.equal(validateRule(ruleDraft(legacy), {now:NOW}).rule.maxWallSeconds, 1200, 'editing preserves an explicit saved per-job cap');
  const other = {...made.rule, id: 'r2'}, old = {...made.rule, id: 'r0', expiresAt: NOW - 1};
  assert.deepEqual(nextRules([made.rule, other, old], {revoke: 'r1', now: NOW}).map(r => r.id), ['r2']);
  assert.deepEqual(nextRules([made.rule, other], {put: {...made.rule, dailyJobs: 5}, now: NOW}).map(r => [r.id, r.dailyJobs]), [['r2', null], ['r1', 5]]);
  const edit = ruleDraft(bounded.rule);
  assert.deepEqual([edit.id, edit.maxWallSeconds, edit.jobs, edit.dailyMinutes, edit.days], ['bounded', null, '3', '60', '30']);
  assert.match(rulesVM([{...made.rule, people: ['gone']}], {devices, now: NOW, zone: ZONE})[0].who, /someone who left/);
});

test('whenText: today, tomorrow, weekday within the week, then a date', () => {
  assert.equal(whenText(NOW + 3600000, {now: NOW, zone: ZONE}), 'tomorrow 12 AM');
  assert.equal(whenText(NOW - 60 * 60000, {now: NOW, zone: ZONE}), 'today 10 PM');
  assert.equal(whenText(NOW + 2 * 86400000, {now: NOW, zone: ZONE}), 'Fri 11 PM');
});

test('F4: numeric policy controls expose units and connect fixed-share validation errors',async()=>{
 const {StrategyChooser,Concurrency}=await import('./lending-policy-view.jsx');
 const {renderFixture}=await import('./render.test-helper.mjs');
 const p={...policyDraft(),strategy:'fixed_share',strategyParams:{fixedSharePct:101}};
 const out=renderFixture(StrategyChooser,{p,setP(){},errors:{'strategyParams.fixedSharePct':'Choose a valid percentage.'}});
 assert.match(out,/aria-label="Share of each week friends can use, percent"/);
 assert.match(out,/aria-invalid="true"/);
 assert.match(out,/aria-describedby="fixed-share-error"/);
 assert.match(out,/id="fixed-share-error"[^>]*role="alert"[^>]*>Choose a valid percentage\./);
 const valid=renderFixture(StrategyChooser,{p:{...p,strategyParams:{fixedSharePct:20}},setP(){},errors:{}});
 assert.doesNotMatch(valid,/aria-invalid="true"|aria-describedby="fixed-share-error"/);
 const concurrency=renderFixture(Concurrency,{p,setP(){},errors:{},machineCapacity:4,providers:['claude']});
 assert.match(concurrency,/aria-label="Your computer runs at most, jobs"/);
});

test('presence default migration names both opt-ins and the new off values', () => {
  const vm=migrationVM({migration:{presenceDefaultsChanged:true,acknowledged:false,
    reset:[{field:'idleOnly',was:true},{field:'stopOnReturn',was:true}]}});
  assert.equal(vm.text,'Lending now runs while you use your computer, limited by your quota. To lend only while you are away, open What you lend and under When you use your computer turn on Only lend when I am away. To stop a running job when you return, turn on Stop a running job when I return.');
  assert.deepEqual(vm.lines,['Only lend when I am away: on, reset to off','Stop a running job when I return: on, reset to off']);
  assert.doesNotMatch(vm.text,/—|presenceDefaults|idleOnly|stopOnReturn/);
  assert.doesNotMatch(vm.text,/could not be used|one unrecognized|Lending was turned off/);
  assert.equal(migrationVM({migration:{presenceDefaultsChanged:true,acknowledged:true}}),null);
});

test('ambiguous activity settings stay saved and use the existing review notice', () => {
  const vm=migrationVM({migration:{presenceDefaultsUncertain:true,acknowledged:false}});
  assert.match(vm.text,/saved activity settings were kept/);
  assert.match(vm.text,/Only lend when I am away/);
  assert.match(vm.text,/Stop a running job when I return/);
  assert.doesNotMatch(vm.text,/reset to off|were reset/);
  assert.equal(migrationVM({migration:{presenceDefaultsUncertain:true,acknowledged:true}}),null);
});

test('presence notice uses the actual page and toggle labels and retains the per-job cap line',async()=>{
  const {readFile}=await import('node:fs/promises');
  const page=await readFile(new URL('./limits.jsx',import.meta.url),'utf8');
  assert.match(page,/>What you lend<\/h1>/);
  assert.match(page,/<h2>When you use your computer<\/h2>/);
  assert.match(page,/<Switch label="Only lend when I am away"/);
  const {StopOnReturn}=await import('./lending-policy-view.jsx');
  const {renderFixture}=await import('./render.test-helper.mjs');
  const toggle=renderFixture(StopOnReturn,{p:policyDraft(),setP(){}});
  assert.match(toggle,/aria-label="Stop a running job when I return"/);
  const vm=migrationVM({migration:{presenceDefaultsChanged:true,perJobCapChanged:true,acknowledged:false,
    reset:[{field:'idleOnly',was:true},{field:'stopOnReturn',was:true},{field:'strategyParams.perJobPct'}]}});
  assert.match(vm.text,/open What you lend and under When you use your computer turn on Only lend when I am away/);
  assert.match(vm.text,/turn on Stop a running job when I return/);
  assert.match(vm.text,/Per-job cap: no cap, reset to 10%\./);
  assert.equal(vm.lines.length,3);
  assert.doesNotMatch(vm.text,/—|presenceDefaults|idleOnly|stopOnReturn/);
});

test('app-owned rules show a current deadline, never ending soon', () => {
  const devices = {fingerprint:'me', circles:[]};
  const base = {id:'ra', circle:'c', people:['me'], agents:[], maxWallSeconds:1200, dailyJobs:null, dailyMinutes:null, schedule:null};
  const owned = rulesVM([{...base, appOwned:true, expiresAt:NOW + 86400000}], {devices, now:NOW, zone:ZONE})[0];
  assert.equal(owned.appOwned, true);
  assert.equal(owned.endingSoon, false);
  assert.match(owned.until, /^currently until .*renews after a verified, non-empty membership refresh/);
  const custom = rulesVM([{...base, expiresAt:NOW + 86400000}], {devices, now:NOW, zone:ZONE})[0];
  assert.equal(custom.endingSoon, true);
  assert.match(custom.until, /^until /);
});

test('an unchanged edit of a scheduled rule keeps its schedule and time zone', () => {
  const schedule = {days: [1, 2, 3], from: '22:00', to: '07:00', weekends_all_day: false};
  const rule = {id: 'ra', circle: 'c', people: ['me'], agents: ['codex'], maxWallSeconds: 1200, dailyJobs: 2, weeklyJobs: 14, dailyMinutes: null, weeklyMinutes: null,
    schedule, timeZone: 'America/Chicago', expiresAt: NOW + 5 * 86400000};
  const out = validateRule(ruleDraft(rule), {now: NOW});
  assert.equal(out.ok, true);
  assert.deepEqual(out.rule.schedule, schedule);
  assert.equal(out.rule.timeZone, 'America/Chicago');
  assert.equal(validateRule(ruleDraft(null, {circle: 'c', people: [{id: 'me'}], agents: ['codex']}), {now: NOW}).rule.schedule, null);
});
