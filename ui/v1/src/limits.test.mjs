import '../../../tests/helpers/no-browser.mjs';
import {mount, teardown} from './mounted.test-helper.mjs';
import {h} from 'preact';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api as fixtureApi} from '../../../tests/helpers/v1-app-fixture.mjs';
import {normalizeLendingPolicy} from '../../../lib/v1/lending-policy.mjs';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {LimitsPage, saveBody, SaveFailed} from './limits.jsx';
import {renderFixture, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';
import {limitsDraft, validateLimits, limitsPreview, HOURS} from './view-models.mjs';
import {pageDraft, validatePage} from './limits-model.mjs';
import {DIAL_EXPLAINER, PROTECTION_POSITIONS} from './lending-policy-view.mjs';
import {mockFixture, NOW} from './lending-policy.fixture.mjs';
import {SANDBOX_LEARN_MORE, STRATEGY_HELP_COPY} from './safety-copy.mjs';

const lending = {mode:'ask', circle:'weekend', configVersion:3,
  limits:{timeZone:'UTC', dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, quotaReserve:30, idleOnly:true}};
const schedule = {days:[1,2,3,4,5], from:'22:00', to:'07:00', weekends_all_day:true};
const scheduled = {...lending, limits:{...lending.limits, schedule}};
const page = (home = {}, l = lending, props = {}) => renderFixture(LimitsPage,
  {lending:l, circle:'weekend', now:NOW, mutate:async()=>({}), data:{home:{lending:l, ...home}}, ...props});
const computerZone = (t, zone) => {
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  t.mock.method(Intl.DateTimeFormat.prototype, 'resolvedOptions', function () {
    return {...resolvedOptions.call(this), timeZone:zone};
  });
};

// Daily request admission limits remain separate from objective lending capacity.
test('daily request limits remain editable while R6.1 allocation controls stay removed', () => {
  const draft = limitsDraft(lending, {});
  assert.deepEqual([draft.dailyJobs, draft.dailyMinutes, draft.maxMinutes, draft.quotaReserve], ['3', '60', '20', 30]);
  assert.deepEqual(validateLimits(draft).limits,
    {dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, quotaReserve:30, idleOnly:true, timeZone:'UTC'});
  const out = page(), text = renderedText(out);
  assert.match(out, /aria-label="Jobs a day"[^>]*value="3"/);
  assert.match(out, /aria-label="Minutes a day"[^>]*value="60"/);
  assert.match(text, /Daily request limits/);
  for (const label of ['Each job uses at most', 'Try it first', 'Watch only', 'quotaReserve'])
    assert.doesNotMatch(text, new RegExp(label));
});

test('fresh lending limits have no daily volume or picked per-job wall cap', () => {
  const fresh = {limits:{dailyJobs:null, dailyMinutes:null, maxWallSeconds:null, quotaReserve:30, idleOnly:false, timeZone:'UTC'}};
  const draft = limitsDraft(fresh, {});
  assert.deepEqual([draft.dailyJobs, draft.dailyMinutes, draft.maxMinutes], ['', '', '']);
  assert.deepEqual(validateLimits(draft).limits,
    {dailyJobs:null, dailyMinutes:null, maxWallSeconds:null, quotaReserve:30, idleOnly:false, timeZone:'UTC'});
});

// The control reads the same saved field that limits.set writes from the command line and MCP.
test('the effort control shows the saved highest effort friends can ask for', () => {
  const shows = (saved, selected) => {
    const out = page({lendingPolicy:mockFixture()}, {...lending, limits:{...lending.limits, lendingPolicy:saved}});
    assert.match(out, /aria-label="Highest effort friends can ask for"/);
    assert.match(out, new RegExp('aria-label="Highest effort friends can ask for"[^>]*>(?:<option [^>]*>[^<]*</option>)*?<option selected value="' + selected + '"'));
    assertNoBannedWords(out);
    assert.match(renderedText(out), /Friends can ask for up to/);
  };
  shows({effortMax:'medium'}, 'medium');
  shows({effortMax:'low'}, 'low');
  shows({}, 'high');
  shows({effortMax:'max'}, 'high');
});

test('a changed highest effort is saved, comes back after a reload, and shows in the control', () => {
  const selected = out => out.match(/aria-label="Highest effort friends can ask for"[^>]*>(.*?)<\/select>/s)[1].match(/<option selected value="(\w+)"/)[1];
  const reloaded = saved => ({...lending, limits:{...lending.limits, lendingPolicy:saved}});
  // Change: the owner picks Low on a page that saved High.
  const start = pageDraft(reloaded({effortMax:'high'}), {});
  const changed = {...start, policy:{...start.policy, effortMax:'low'}};
  const {ok, limits} = validatePage(changed);
  assert.equal(ok, true);
  // Save: the body sent to the server carries the new value.
  const body = saveBody(changed, {limits, version:3});
  assert.equal(body.lendingPolicy.effortMax, 'low');
  // Reload: the server returns what was saved, and the control shows it.
  const back = reloaded(body.lendingPolicy);
  assert.equal(pageDraft(back, {}).policy.effortMax, 'low');
  assert.equal(selected(page({lendingPolicy:mockFixture()}, back)), 'low');
  // A saved level above High reloads and shows as High.
  for (const above of ['xhigh', 'max']) {
    const saved = validatePage(pageDraft(reloaded({effortMax:above}), {}));
    assert.equal(saved.ok, true);
    assert.equal(selected(page({lendingPolicy:mockFixture()}, reloaded(saved.limits.lendingPolicy))), 'high');
  }
});

test('protection choices and latest explanation come from the objective contract', () => {
  const snapshot = mockFixture();
  const out = page({lendingPolicy:snapshot});
  const text = renderedText(out);
  assertDomOrder(out, ['<h2 id="lending-explanation-h">Lending explanation</h2>', '<b>Claude</b>',
    '<a href="#starting-assumption"', 'Using an initial usage estimate. Your lending limits still apply.', '<h2 id="protection-h">Lending setting</h2>',
    'Keep more for me', 'Balanced', 'Share more', 'At the same time:', 'Who', '<h2>When</h2>']);
  assert.ok(text.includes(DIAL_EXPLAINER));
  for (const position of PROTECTION_POSITIONS) assert.ok(text.includes(position.description.replace('Risk target:', 'Model target (not a measured rate):')));
  assert.doesNotMatch(text, /expected harm|objective rule|declared demand model/);
  assert.doesNotMatch(text, /Custom|objective rule|expected harm/, 'the strategy chooser offers Automatic and Fixed share only');
  assert.match(out, /name="protectionPosition" value="keep_more_for_me" checked/);
  assert.match(out, /<b>Keep more for me<\/b><span class="protection-tag">Default<\/span>/);
  assert.match(text, /Risk target based on your own weeks\./);
  assert.match(text, /Faravan can start lending before the first quota reading, within your lending limits\./);
  assert.match(text, /With a reading, it starts by lending up to a fifth of each window/);
  assert.doesNotMatch(text, /new requests stay on hold/i);
  assert.match(text, /It cannot see your use on other devices, the web, or the app/);
  assert.match(text, /These limits bound what friends use, not how much of your own work may need that quota\./);
  assert.match(out, /<summary>Starting assumption for new users<\/summary>/);
  assert.doesNotMatch(out, /optimistic-default-v1/);
  assert.doesNotMatch(text, /Protection source|Chunk admitted|objective rule|declared demand model/);
  assert.doesNotMatch(text, /busy_week|session_tail|hourly_rate|per_job|unlikely_to_need/);
  assertNoBannedWords(out);
});
test('lending explanation gives plain help for each strategy and a collapsed Learn more', () => {
  const out=page({lendingPolicy:mockFixture()}), text=renderedText(out);
  for(const line of STRATEGY_HELP_COPY)assert.ok(text.includes(line),line);
  assert.match(out,/<summary>Learn more<\/summary>/);
  assert.ok(text.includes(SANDBOX_LEARN_MORE));
});

test('when lending is off, the explanation says so without an objective hold or internal source label', () => {
  const out = page({lendingPolicy:mockFixture(), lendingProjection:{intent:'off'}});
  const text = renderedText(out);
  assert.match(text, /Lending is off\./);
  assert.doesNotMatch(text, /Held|Protection source|Holding/);
});

test('missing objective data explains the starting estimate without inventing an allowance', () => {
  const text = renderedText(page({lendingPolicy:{accounts:[], migration:null}}));
  assert.match(text, /Faravan can use a starting estimate until a quota reading is available\./);
  assert.doesNotMatch(text, /new requests stay on hold/i);
  assert.doesNotMatch(text, /We can’t see your .*allowance|friends can use about/);
});

test('legacy migration notice appears once from the server marker and has no old-setting action', () => {
  const pending = page({lendingPolicy:{...mockFixture(), migration:{fromLegacyPolicy:true, acknowledged:false}}});
  const acknowledged = page({lendingPolicy:{...mockFixture(), migration:{fromLegacyPolicy:true, acknowledged:true}}});
  assert.match(renderedText(pending), /Your saved lending strategy was migrated\. Review the strategy below; your consent and lending rules were preserved\./);
  assert.doesNotMatch(pending, /Keep my old|quotaReserve/);
  assert.doesNotMatch(renderedText(acknowledged), /settings were migrated/);
});

test('startup repair notice survives app restart and refused saves until a policy save is acknowledged', async t => {
  t.after(teardown);
  const f = await appFixture(t);
  const homeDir = await f.home('owner');
  const dir = join(homeDir, 'v1');
  await mkdir(dir, {recursive:true});
  await writeFile(join(dir, 'app-settings.json'), JSON.stringify({
    version:1, name:'Saved settings', enabled:false, intent:'off', agents:{}, modes:{},
    limits:{dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, quotaReserve:30, idleOnly:true,
      timeZone:'UTC', schedule:null, lendingPolicy:{...normalizeLendingPolicy(), warningPct:150}},
  }));
  let {app} = await f.start('owner');
  const readHome = () => fixtureApi(app, '/api/home');
  const notice = /Warning level: 150%, reset to 10%/;
  const off = /Lending was turned off\. Turn it on again and choose the agents to lend\./;
  const view = home => h(LimitsPage, {data:{home}, lending:home.lending, now:NOW});
  const first = await readHome();
  assert.deepEqual(first.lendingPolicy.migration.reset, [{field:'warningPct', was:150}]);
  assert.equal(first.lending.limits.lendingPolicy.providerConsent, undefined);
  assert.equal(first.lending.enabled, false);
  const initial = await mount(view(first));
  assert.match(initial.text(), notice);
  assert.match(initial.text(), off);
  await initial.unmount();
  await app.close();
  ({app} = await f.start('owner'));

  const reloaded = await readHome();
  assert.deepEqual(reloaded.lendingPolicy.migration, first.lendingPolicy.migration);
  assert.equal(reloaded.lending.enabled, false);
  assert.equal(reloaded.lending.limits.lendingPolicy.providerConsent, undefined);
  const page = await mount(view(reloaded));
  assert.match(page.text(), notice, 'fresh mount reads the unacknowledged notice from the server');
  const save = version => fixtureApi(app, '/api/lending/limits', {method:'POST', body:{
    version, lendingPolicy:reloaded.lending.limits.lendingPolicy,
  }});
  await assert.rejects(() => save(reloaded.lending.configVersion + 1));
  const refused = await readHome();
  assert.equal(refused.lendingPolicy.migration.acknowledged, false);
  assert.equal(refused.lending.configVersion, reloaded.lending.configVersion);
  await page.rerender(view(refused));
  assert.match(page.text(), notice);
  assert.match(page.text(), off);

  await save(refused.lending.configVersion);
  const acknowledged = await readHome();
  assert.equal(acknowledged.lendingPolicy.migration, null);
  assert.equal(acknowledged.lending.enabled, false, 'acknowledgement does not turn lending back on');
  assert.equal(acknowledged.lending.limits.lendingPolicy.providerConsent, undefined);
  await page.rerender(view(acknowledged));
  assert.doesNotMatch(page.text(), /Some saved lending settings could not be used/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'app-settings.json'), 'utf8')).lendingPolicyMigration.acknowledged, true);
  await app.close();
  ({app} = await f.start('owner'));
  const restarted = await readHome();
  assert.equal(restarted.lendingPolicy.migration, null);
  assert.equal(restarted.lending.enabled, false);
  assert.equal(restarted.lending.limits.lendingPolicy.providerConsent, undefined);
  await page.rerender(view(restarted));
  assert.doesNotMatch(page.text(), /Some saved lending settings could not be used/);
});

test('account plan, concurrency, Stop-on-return, people and hours remain editable', t => {
  computerZone(t, 'America/Chicago');
  const configured = {...scheduled, limits:{...scheduled.limits, idleOnly:true, lendingPolicy:{accountPlans:{claude:'max20',codex:'pro'}}}};
  const out = page({lendingPolicy:mockFixture()}, configured);
  const text = renderedText(out);
  for (const label of ['Claude plan', 'Codex plan', 'Jobs per account',
    'Your computer runs at most', 'Stop a running job when I return', 'Only lend in set hours', 'Lending hours', 'Days'])
    assert.match(out, new RegExp('aria-label="' + label + '"|<b>' + label + '</b>'), label);
  // Was the certified-plan hint; every plan now lends in native-window mode, and the plan never sets a rate.
  assert.match(text, /This account lends now in its own allowance points using the starting estimate\./);
  assert.match(text, /Your saved hours use UTC\. Use your time \(Chicago\)\?/);
  assert.match(text, /Every request shows you what it asks before anything runs\./);
  assert.match(out, /class="day on"/);
  assertNoBannedWords(out);
});

test('Save carries the balanced objective position and retains supported schedule fields', () => {
  const draft = pageDraft({...scheduled, mode:'auto', limits:{...scheduled.limits, lendingPolicy:{protectionPosition:'balanced'}}}, {});
  const {ok, limits} = validatePage(draft);
  assert.equal(ok, true);
  const body = saveBody(draft, {limits, version:3});
  assert.equal(body.lendingPolicy.protectionPosition, 'balanced');
  assert.equal(body.lendingPolicy.strategy, 'automatic');
  assert.equal('preset' in body.lendingPolicy, false);
  assert.equal('perJobPct' in body.lendingPolicy, false);
  assert.deepEqual(body.schedule, schedule);
  assert.equal(body.version, 3);
  assert.equal('mode' in body, false);
  assert.equal(saveBody({...draft, schedule:{...draft.schedule, on:false}}, {limits, version:3}).schedule, null);
});

test('Save carries an explicitly selected bounded strategy and its declarative parameters', () => {
  const policy={strategy:'custom',strategyParams:{e0:0.3,perJobPct:5}};
  const draft=pageDraft({...scheduled,mode:'auto',limits:{...scheduled.limits,lendingPolicy:policy}},{});
  const {ok,limits}=validatePage(draft);
  assert.equal(ok,true);
  const body=saveBody(draft,{limits,version:3});
  assert.equal(body.lendingPolicy.strategy,'custom');
  assert.deepEqual(body.lendingPolicy.strategyParams,policy.strategyParams);
});

test('the lending schedule validates and previews in its saved time zone', t => {
  computerZone(t, 'America/Chicago');
  const draft = limitsDraft(scheduled, {});
  assert.equal(HOURS.length, 48);
  assert.deepEqual([HOURS[0].label, HOURS[1].label, HOURS[44].label], ['12 AM', '12:30 AM', '10 PM']);
  assert.match(limitsPreview(draft, 'America/Chicago').map(x=>x.text).join(''), /^Weeknights 10 PM–7 AM \(UTC time\) and all weekend\./);
  const out = page({}, scheduled);
  assert.doesNotMatch(renderedText(out), /Use America\/Chicago/);
  assert.equal(validateLimits({...draft, schedule:{...draft.schedule, days:[], weekendsAllDay:false}}).errors.days, 'Choose at least one day.');
});

test('save failure copy keeps the draft and offers the current settings after a conflict', () => {
  const changed = renderFixture(SaveFailed, {error:{code:'config_changed'}, onShow(){}});
  assert.match(renderedText(changed), /Nothing was saved.*Your changes are still here.*Show the current settings/);
  assert.match(changed, /role="alert"/);
  const other = renderFixture(SaveFailed, {error:{code:'lending_busy'}, onShow(){}});
  assert.match(renderedText(other), /Nothing was saved Review the current job before starting another\./);
  assert.doesNotMatch(other, /Show the current settings/);
  const ambiguous = renderedText(renderFixture(SaveFailed, {error:{code:'network'}}));
  assert.match(ambiguous, /We could not confirm whether your changes were saved\./);
  assert.doesNotMatch(ambiguous, /Nothing was saved/);
});

test('standing rules still name people and agents and keep expiry controls', t => {
  computerZone(t, 'America/Chicago');
  const devices = {fingerprint:'me', circles:[{circle:'weekend', members:[{key_id:'k-sam', localName:'Sam'}, {key_id:'k-ana', ownerName:'Ana'}]}]};
  const rules = [{id:'r1', circle:'weekend', people:['k-sam','k-ana'], agents:['codex','claude-code-subscription'], maxWallSeconds:1200,
    dailyJobs:3, weeklyJobs:21, dailyMinutes:60, weeklyMinutes:420, schedule:null, expiresAt:NOW + 2 * 86400000}];
  const out = renderFixture(LimitsPage, {lending:{...lending, standingRules:rules}, circle:'weekend', now:NOW, mutate:async()=>({}),
    circles:[{id:'weekend', name:'Weekend'}], agents:[{id:'codex'}], data:{devices, home:{lending:{...lending, standingRules:rules}}}});
  const text = renderedText(out);
  assert.match(text, /Anyone without a rule: Faravan shows you the request first\. A rule ends after at most 30 days/);
  assert.match(text, /Sam and Ana: run without asking Codex and Claude Code · jobs up to 20 min · 3 jobs a day · 60 minutes a day · Weekend · until Fri 11 PM Renew Edit Remove/);
  assert.match(text, /Add a rule/);
  assert.match(out, /class="rule-ending"/);
});

test('app-owned Automatic rule has no Renew button and says it renews itself', t => {
  computerZone(t, 'America/Chicago');
  const devices = {fingerprint:'me', circles:[{circle:'weekend', members:[{key_id:'k-sam', localName:'Sam'}]}]};
  const rules = [{id:'r1', circle:'weekend', people:['k-sam'], agents:[], maxWallSeconds:1200, dailyJobs:3, dailyMinutes:60, schedule:null,
    expiresAt:NOW + 2 * 86400000, appOwned:true}];
  const out = renderFixture(LimitsPage, {lending:{...lending, standingRules:rules}, circle:'weekend', now:NOW, mutate:async()=>({}),
    circles:[{id:'weekend', name:'Weekend'}], agents:[{id:'codex'}], data:{devices, home:{lending:{...lending, standingRules:rules}}}});
  const text = renderedText(out);
  assert.match(text, /Automatic permission renews while Automatic is on; a rule you make yourself ends after at most 30 days/);
  assert.match(text, /currently until .*renews after a verified, non-empty membership refresh/);
  assert.doesNotMatch(text, /Renew Edit/);
  assert.doesNotMatch(out, /class="rule-ending"/);
});

test('P1 ambiguous saves explain uncertainty and keep the check action without a false failure claim',()=>{
  const html=renderFixture(SaveFailed,{error:{code:'network'},onCheck(){}});
  const text=renderedText(html);
  assert.match(text,/We could not confirm whether your changes were saved\./);
  assert.match(text,/Check the saved settings before you change anything else\./);
  assert.match(text,/Check saved settings/);
  assert.doesNotMatch(text,/Nothing was saved|Changes saved|No limit has been saved/);
  const definite=renderedText(renderFixture(SaveFailed,{error:{code:'config_changed'},onShow(){}}));
  assert.match(definite,/Nothing was saved/);
});

test('P1 every owner-limit ambiguous branch keeps the same uncertainty warning',()=>{
  const source=readFileSync(new URL('./limits.jsx',import.meta.url),'utf8');
  const warning='We could not confirm whether your changes were saved. Check the saved settings before you change anything else.';
  assert.equal(source.split(warning).length-1,5);
  assert.ok(source.includes('setUncertain(ambiguous)'));
  assert.ok(source.includes('limitsSaveAmbiguous(error)'));
  assert.ok(source.includes('>Check saved limit</button>'));
  assert.doesNotMatch(source,/No limit has been saved yet/);
});

test('fresh presence switches are opt-ins and show their delays', () => {
  const out=page({lendingPolicy:mockFixture()}, {limits:{idleOnly:false}});
  assert.match(out.match(/<[^>]*aria-label="Only lend when I am away"[^>]*>/)?.[0] ?? '', /aria-checked="false"/);
  assert.doesNotMatch(out,/Stop a running job when I return/);
  assert.match(renderedText(out),/Off by default/);
  assert.match(renderedText(out),/5 minutes without keyboard or mouse activity/);
  const away = page({lendingPolicy:mockFixture()}, {limits:{idleOnly:true}});
  assert.match(renderedText(away),/2 minutes of activity/);
  const draft=limitsDraft({},{});
  assert.equal(draft.idleOnly,false);
});
