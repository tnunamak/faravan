import './helpers/no-browser.mjs';
import {tempDir} from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createLogAttributionStore, localLogRoots, measurementExpired, measurementFor} from '../lib/v1/lending-log-attribution.mjs';
import {importLendingHistory, readLocalAgentSessionLogsInWorker} from '../lib/v1/lending-history-import.mjs';
import {liveReservationSpent} from '../lib/v1/lender-pace50.mjs';
import {calibrationMissingCopy, learningCopy, learningCreatorUnknownLine, learningExpiredLine, learningLine, LEARNING_OFF_LINE} from '../lib/v1/lending-status-copy.mjs';

const hx = value => createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex').slice(0, 16);
const LENT = 'lent-account-uuid', OTHER = 'other-account-uuid', CODEX = 'codex-account-id';
const jwt = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const scratch = t => { const dir = tempDir('log-attribution-'); t.after(() => rmSync(dir, {recursive:true, force:true})); return dir; };
const claudeAccount = (uuid, tier = 'default_claude_max_20x') => JSON.stringify({oauthAccount:{accountUuid:uuid,
  organizationRateLimitTier:tier, userRateLimitTier:tier, seatTier:null, billingType:'stripe_subscription'}});

// A home with three Claude folders on two accounts and one Codex folder. Account values are synthetic.
function home(t, {defaultAccount = OTHER, lent = LENT, plan = 'pro'} = {}) {
  const root = scratch(t);
  for (const dir of ['.claude/projects/p', '.claude-lent/projects/p', '.claude-other/projects/p', '.codex/sessions/2026/10']) mkdirSync(join(root, dir), {recursive:true});
  writeFileSync(join(root, '.claude.json'), claudeAccount(defaultAccount));
  writeFileSync(join(root, '.claude', '.claude.json'), claudeAccount(defaultAccount));
  writeFileSync(join(root, '.claude-lent', '.claude.json'), claudeAccount(lent));
  writeFileSync(join(root, '.claude-other', '.claude.json'), claudeAccount(OTHER));
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({tokens:{account_id:CODEX,
    id_token:jwt({'https://api.openai.com/auth':{chatgpt_plan_type:plan}})}}));
  return root;
}
const pins = {claude:{account_sha256_16:hx(LENT)}, codex:{account_sha256_16:hx(CODEX)}};

test('every Claude config folder and the Codex home are found with only a hash of their account', t => {
  const root = home(t);
  const roots = localLogRoots(root, {env:{}});
  const byPath = Object.fromEntries(roots.map(r => [r.path.slice(root.length), r]));
  assert.deepEqual(Object.keys(byPath).sort(), ['/.claude-lent/projects', '/.claude-other/projects', '/.claude/projects', '/.codex/sessions']);
  assert.equal(byPath['/.claude/projects'].account_sha256_16, hx(OTHER));
  assert.equal(byPath['/.claude/projects'].default, true);
  assert.equal(byPath['/.claude-lent/projects'].account_sha256_16, hx(LENT));
  assert.equal(byPath['/.claude-lent/projects'].default, false);
  assert.equal(byPath['/.codex/sessions'].account_sha256_16, hx(CODEX));
  assert.doesNotMatch(JSON.stringify(roots), /uuid|codex-account-id|max_20x|pro"/, 'no account or plan value leaves the folder');
  // A default folder whose two account files disagree has no account.
  writeFileSync(join(root, '.claude', '.claude.json'), claudeAccount(LENT));
  assert.equal(localLogRoots(root, {env:{}}).find(r => r.default && r.provider === 'claude').account_sha256_16, null);
  // CLAUDE_CONFIG_DIR names one more folder.
  mkdirSync(join(root, 'elsewhere'), {recursive:true});
  writeFileSync(join(root, 'elsewhere', '.claude.json'), claudeAccount(LENT));
  assert.ok(localLogRoots(root, {env:{CLAUDE_CONFIG_DIR:join(root, 'elsewhere')}}).some(r => r.path === join(root, 'elsewhere', 'projects')));
});

test('only folders on the lent account are attributed, from the first time they are seen on it', t => {
  const root = home(t);
  let at = 1_000;
  const store = createLogAttributionStore({directory:scratch(t), now:() => at});
  const first = store.update(localLogRoots(root, {env:{}}), pins);
  const read = Object.fromEntries(first.roots.map(r => [r.path.slice(root.length), r]));
  // The default folders are always read for scoring; the other-account folder is not read at all.
  assert.deepEqual(Object.keys(read).sort(), ['/.claude-lent/projects', '/.claude/projects', '/.codex/sessions']);
  assert.equal(read['/.claude/projects'].since, null, 'the default folder is another account: scoring only');
  assert.equal(read['/.claude/projects'].scoring, true);
  assert.equal(read['/.claude-lent/projects'].since, 1_000);
  assert.equal(read['/.claude-lent/projects'].scoring, false, 'a non-default folder is read only to measure');
  assert.deepEqual(store.current('claude'), {account_sha256_16:hx(LENT), since:1_000});
  assert.deepEqual(store.current('codex'), {account_sha256_16:hx(CODEX), since:1_000});
  // Unchanged folders keep their start. A restart with no reading yet keeps the last lent account.
  at = 2_000;
  store.update(localLogRoots(root, {env:{}}), {});
  assert.deepEqual(store.current('claude'), {account_sha256_16:hx(LENT), since:1_000});
  // A plan change restarts the start: older use was another plan's.
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({tokens:{account_id:CODEX,
    id_token:jwt({'https://api.openai.com/auth':{chatgpt_plan_type:'plus'}})}}));
  at = 3_000;
  store.update(localLogRoots(root, {env:{}}), pins);
  assert.deepEqual(store.current('codex'), {account_sha256_16:hx(CODEX), since:3_000});
  assert.deepEqual(store.current('claude'), {account_sha256_16:hx(LENT), since:1_000});
  // The lent account changes: no folder is on it, so nothing is attributed.
  store.update(localLogRoots(root, {env:{}}), {claude:{account_sha256_16:hx('someone-else')}});
  assert.equal(store.current('claude'), null);
  // A folder that re-signs in to the lent account starts again from then.
  at = 4_000;
  store.update(localLogRoots(root, {env:{}}), pins);
  assert.deepEqual(store.current('claude'), {account_sha256_16:hx(LENT), since:4_000});
});

test('the attribution file keeps no folder path and is forgotten on clear', t => {
  const root = home(t), directory = scratch(t);
  const store = createLogAttributionStore({directory, now:() => 1});
  store.update(localLogRoots(root, {env:{}}), pins);
  const saved = readFileSync(join(directory, 'lending-log-attribution.json'), 'utf8');
  assert.doesNotMatch(saved, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(saved, /\.claude|\.codex/);
  store.clear();
  assert.equal(existsSync(join(directory, 'lending-log-attribution.json')), false);
  assert.equal(store.current('claude'), null);
});

test('two folders on the lent account with different plan tiers attribute nothing', t => {
  const root = home(t, {defaultAccount:LENT});
  writeFileSync(join(root, '.claude.json'), claudeAccount(LENT, 'default_claude_pro'));
  writeFileSync(join(root, '.claude', '.claude.json'), claudeAccount(LENT, 'default_claude_pro'));
  const store = createLogAttributionStore({directory:scratch(t), now:() => 1});
  const out = store.update(localLogRoots(root, {env:{}}), pins);
  assert.equal(store.current('claude'), null);
  assert.ok(out.roots.filter(r => r.provider === 'claude').every(r => r.since === null));
});

test('a saved measurement counts only on the current attribution', () => {
  const current = {account_sha256_16:'aaaaaaaaaaaaaaaa', since:5};
  const measured = {upper_micro:900_000, binding:{...current}, expires_at:1_000};
  assert.equal(measurementFor(measured, current, 999), measured);
  assert.equal(measurementFor(measured, null, 999), null);
  assert.equal(measurementFor(measured, {...current, since:6}, 999), null);
  assert.equal(measurementFor({...measured, binding:undefined}, current, 999), null);
  assert.equal(measurementFor({...measured, upper_micro:null}, current, 999), null);
  assert.equal(measurementExpired(measured, current, 999), false);
  // At its expiry the measurement stops counting and reads as expired, not as never measured.
  assert.equal(measurementFor(measured, current, 1_000), null);
  assert.equal(measurementExpired(measured, current, 1_000), true);
  // A measurement saved before expiry existed has no date: it never counts, but it is missing, not "expired".
  const {expires_at, ...undated} = measured;
  assert.equal(measurementFor(undated, current, 0), null);
  assert.equal(measurementExpired(undated, current, 0), false);
  assert.equal(measurementExpired({...measured, expires_at:NaN}, current, 0), false);
  // Another account's or another period's old measurement is not this account's expired one: it is simply missing.
  assert.equal(measurementExpired(measured, {...current, since:6}, 1_000), false);
  assert.equal(measurementExpired(undefined, current, 0), false);
  // With the verified account named, an old account's expired entry is not the new account's.
  assert.equal(measurementExpired(measured, current, 1_000, 'aaaaaaaaaaaaaaaa'), true);
  assert.equal(measurementExpired(measured, current, 1_000, 'bbbbbbbbbbbbbbbb'), false);
});

const assistant = (id, at, input = 1_000_000) => JSON.stringify({type:'assistant', timestamp:new Date(at).toISOString(),
  message:{id, model:'claude-haiku-4-5-20251001', usage:{input_tokens:input, output_tokens:0}}});

test('the log reader reads the named folders, and only the lent account\'s use measures its meter', async t => {
  const root = home(t);
  const now = Date.UTC(2026, 9, 31), day = 86_400_000;
  writeFileSync(join(root, '.claude', 'projects', 'p', 'a.jsonl'), assistant('default-use', now - day / 2, 50_000_000) + '\n');
  writeFileSync(join(root, '.claude-lent', 'projects', 'p', 'b.jsonl'), [assistant('lent-old', now - 3 * day),
    assistant('lent-new', now - day / 2)].join('\n') + '\n');
  writeFileSync(join(root, '.claude-other', 'projects', 'p', 'c.jsonl'), assistant('other-use', now - day / 2, 50_000_000) + '\n');
  const store = createLogAttributionStore({directory:scratch(t), now:() => now - 2 * day});
  const attribution = store.update(localLogRoots(root, {env:{}}), pins);
  const loaded = await readLocalAgentSessionLogsInWorker(root, {logRoots:attribution.roots});
  assert.equal(loaded.incomplete, false);
  const sources = loaded.logs.map(log => log.source.slice(root.length)).sort();
  assert.deepEqual(sources, ['/.claude-lent/projects/p/b.jsonl', '/.claude/projects/p/a.jsonl'], 'the other-account folder is never read');
  const estimates = [];
  const window = {account:'claude', resource:'claude:seven_day', start_at:now - 4 * day, observed_at:now, meter_points:2,
    account_week_id:'w', week_start:now - 4 * day};
  const result = importLendingHistory({consent:true, now, loadSessionLogs:() => loaded.logs, currentWindows:[window],
    logAttribution:attribution, onKappa:row => estimates.push(row)});
  // Only lent-new prices the meter: lent-old is before the start, default-use is another account's.
  // Haiku 4.5 list input is $1 per million tokens: $1 of use, (2 + 1) points.
  assert.equal(estimates[0].estimate.upper_micro, 3_000_000);
  assert.deepEqual(estimates[0].estimate.binding, store.current('claude'));
  // Weekly scoring keeps its old input: the default folder only.
  assert.equal(result.unmapped_sessions, 1);
});

test('a message copied into a resumed session file is priced once', t => {
  const root = home(t);
  const now = Date.UTC(2026, 9, 31), day = 86_400_000;
  const line = assistant('lent-new', now - day / 2);
  writeFileSync(join(root, '.claude-lent', 'projects', 'p', 'b.jsonl'), line + '\n');
  writeFileSync(join(root, '.claude-lent', 'projects', 'p', 'b-resumed.jsonl'), line + '\n');
  const store = createLogAttributionStore({directory:scratch(t), now:() => now - 2 * day});
  const attribution = store.update(localLogRoots(root, {env:{}}), pins);
  const logs = ['b.jsonl', 'b-resumed.jsonl'].map(name => {
    const source = join(root, '.claude-lent', 'projects', 'p', name);
    return {provider:'claude', account:'claude', source, contents:readFileSync(source, 'utf8'), mtimeMs:now};
  });
  const estimates = [];
  importLendingHistory({consent:true, now, loadSessionLogs:() => logs, logAttribution:attribution, onKappa:row => estimates.push(row),
    currentWindows:[{account:'claude', resource:'claude:seven_day', start_at:now - 4 * day, observed_at:now, meter_points:2,
      account_week_id:'w', week_start:now - 4 * day}]});
  assert.equal(estimates[0].estimate.upper_micro, 3_000_000, '$1 of use, not $2');
});

test('a guard reading stops a lent job once a reserved window rose by the whole reservation', () => {
  const resources = [{id:'seven_day', baseline_used_micro:20_000_000, initial_micro:3_000_000},
    {id:'five_hour', baseline_used_micro:40_000_000, initial_micro:9_000_000}];
  assert.equal(liveReservationSpent(resources, [{window_id:'seven_day', used_pct:22.999}, {window_id:'five_hour', used_pct:48}]), false);
  assert.equal(liveReservationSpent(resources, [{window_id:'seven_day', used_pct:23}]), true);
  assert.equal(liveReservationSpent(resources, [{window_id:'five_hour', used_pct:49}]), true);
  assert.equal(liveReservationSpent(resources, [{window_id:'seven_day', used_pct:5}]), false, 'a window reset is not a rise');
  assert.equal(liveReservationSpent(resources, []), false);
  assert.equal(liveReservationSpent(resources, undefined), false);
  assert.equal(liveReservationSpent(undefined, [{window_id:'seven_day', used_pct:99}]), false);
  // A later window instance counts from zero; jitter in the reset time does not.
  const reset = Date.UTC(2026, 10, 3);
  const reserved = [{id:'seven_day', resets_at:reset, baseline_used_micro:20_000_000, initial_micro:3_000_000}];
  assert.equal(liveReservationSpent(reserved, [{window_id:'seven_day', used_pct:3, resets_at:new Date(reset + 7 * 86_400_000).toISOString()}]), true);
  assert.equal(liveReservationSpent(reserved, [{window_id:'seven_day', used_pct:2.5, resets_at:new Date(reset + 7 * 86_400_000).toISOString()}]), false);
  assert.equal(liveReservationSpent(reserved, [{window_id:'seven_day', used_pct:3, resets_at:new Date(reset + 900).toISOString()}]), false);
});

// Was the measuring hold's copy; no history now lends natively, so the copy says it lends in points until local logs measure a rate.
test('the learning line says the account lends in points until local logs measure a rate', () => {
  assert.deepEqual(learningCopy({reason:'learning', provider:'codex', window:'weekly'}), {line:learningLine('weekly')});
  // No dollar amount is promised, and nothing reads as a hold.
  assert.equal(learningLine('weekly'), "Faravan has no measured usage rate for this account's weekly allowance yet. Until your local agent logs measure a rate, it lends in allowance points using the starting estimate.");
  assert.match(learningLine('five_hour'), /this account's 5-hour allowance yet/);
  for (const line of [learningLine('weekly'), learningExpiredLine('weekly'), LEARNING_OFF_LINE])
    assert.doesNotMatch(line, /dollar|\$|on hold|won't lend|until/);
  // An expired measurement says so, rather than reading as a first measurement.
  assert.deepEqual(learningCopy({reason:'learning', provider:'claude', window:'weekly', expired:true}), {line:learningExpiredLine('weekly')});
  assert.equal(learningCopy({reason:'learning', provider:'other'}), null);
  assert.equal(learningCopy({reason:'learning', provider:'claude', learning_off:true}).line, LEARNING_OFF_LINE);
  // The old measuring detail is no longer a recognized hold.
  assert.equal(calibrationMissingCopy({reason:'measuring', provider:'codex', window:'weekly'}), null);
});

// One Claude week window over the last 4 days: 2 shown points.
const claudeWindow = now => ({account:'claude', resource:'claude:seven_day', start_at:now - 4 * 86_400_000, observed_at:now,
  meter_points:2, account_week_id:'w', week_start:now - 4 * 86_400_000});
const measureFrom = (root, logs, now, attribution) => {
  const estimates = [];
  importLendingHistory({consent:true, now, loadSessionLogs:() => logs, logAttribution:attribution,
    onKappa:row => estimates.push(row), currentWindows:[claudeWindow(now), codexWindow(now)]});
  return Object.fromEntries(estimates.map(row => [row.account, row.estimate]));
};
const logFile = (root, rel, provider, now) => {
  const source = join(root, rel);
  return {provider, account:provider, source, contents:readFileSync(source, 'utf8'), mtimeMs:now};
};

test('a Claude folder with an API key set up is not on any lent account, so none of its use counts', t => {
  const now = Date.UTC(2026, 9, 31), day = 86_400_000;
  const setups = [
    ['settings.json', {apiKeyHelper:'/bin/print-key'}],
    ['settings.json', {env:{ANTHROPIC_API_KEY:'synthetic'}}],
    ['settings.json', {env:{CLAUDE_CODE_USE_BEDROCK:'1'}}],
    ['settings.local.json', {apiKeyHelper:'/bin/print-key'}],
    ['settings.local.json', {env:{ANTHROPIC_API_KEY:'synthetic'}}],
    ['settings.local.json', {env:{CLAUDE_CODE_USE_VERTEX:'true'}}],
    ['.claude.json', {...JSON.parse(claudeAccount(LENT)), primaryApiKey:'synthetic'}],
    ['.claude.json', {...JSON.parse(claudeAccount(LENT)), customApiKeyResponses:{approved:['synthetic'], rejected:[]}}],
  ];
  for (const [file, value] of setups) {
    const root = home(t);
    writeFileSync(join(root, '.claude-lent', file), JSON.stringify(value));
    writeFileSync(join(root, '.claude-lent', 'projects', 'p', 'b.jsonl'), assistant('api-key-use', now - day / 2) + '\n');
    const found = localLogRoots(root, {env:{}}).find(r => r.path.endsWith('/.claude-lent/projects'));
    assert.equal(found.account_sha256_16, null, `${file} ${Object.keys(value).join(',')}`);
    const store = createLogAttributionStore({directory:scratch(t), now:() => now - 2 * day});
    const attribution = store.update(localLogRoots(root, {env:{}}), pins);
    assert.equal(attribution.providers.claude, undefined, 'no folder on the lent account, so no attribution');
    const logs = [logFile(root, '.claude-lent/projects/p/b.jsonl', 'claude', now)];
    assert.equal(measureFrom(root, logs, now, attribution).claude, null, 'no measurement, not a low one');
  }
});

test('Faravan\'s own environment does not take a Claude folder off the lent account; a cloud flag that is off is off', t => {
  const root = home(t);
  const lentFolder = env => localLogRoots(root, {env}).find(r => r.path.endsWith('/.claude-lent/projects')).account_sha256_16;
  assert.equal(lentFolder({}), hx(LENT));
  // The shell that started Faravan says nothing about how the logged runs were paid.
  for (const env of [{ANTHROPIC_API_KEY:'synthetic'}, {CLAUDE_CODE_USE_BEDROCK:'1'}]) assert.equal(lentFolder(env), hx(LENT), Object.keys(env)[0]);
  // A cloud-provider flag that is off in settings is not an API-key setup.
  for (const off of ['0', 'false', 'FALSE', ' ', '']) {
    writeFileSync(join(root, '.claude-lent', 'settings.json'), JSON.stringify({env:{CLAUDE_CODE_USE_BEDROCK:off}}));
    assert.equal(lentFolder({}), hx(LENT), `settings ${JSON.stringify(off)}`);
  }
});

test('a copy in a folder that cannot count never hides the copy that can', t => {
  const root = home(t);
  const now = Date.UTC(2026, 9, 31), day = 86_400_000;
  const line = assistant('shared', now - day / 2);
  // The default folder is on another account and is read first; the lent folder holds the same message.
  writeFileSync(join(root, '.claude', 'projects', 'p', 'a.jsonl'), line + '\n');
  writeFileSync(join(root, '.claude-lent', 'projects', 'p', 'b.jsonl'), line + '\n');
  const attribution = createLogAttributionStore({directory:scratch(t), now:() => now - 2 * day}).update(localLogRoots(root, {env:{}}), pins);
  const logs = [logFile(root, '.claude/projects/p/a.jsonl', 'claude', now), logFile(root, '.claude-lent/projects/p/b.jsonl', 'claude', now)];
  assert.equal(measureFrom(root, logs, now, attribution).claude.upper_micro, 3_000_000);
});

test('folders whose names differ only in case are different folders', t => {
  const root = home(t);
  let at = 1_000;
  const store = createLogAttributionStore({directory:scratch(t), now:() => at});
  store.update(localLogRoots(root, {env:{}}), pins);
  assert.equal(store.current('claude').since, 1_000);
  // Renaming the lent folder to another case is a new folder: its attribution starts again.
  renameSync(join(root, '.claude-lent'), join(root, '.claude-Lent'));
  at = 2_000;
  store.update(localLogRoots(root, {env:{}}), pins);
  assert.equal(store.current('claude').since, 2_000);
});

// Codex rollout lines. Account values are synthetic; gpt-6-sol lists $2 per million input tokens.
const codexLines = ({session = 'session-1', creator = CODEX, rateLimits = {primary:{used_percent:3}}, at}) => {
  const lines = [];
  if (session !== undefined || creator !== undefined)
    lines.push({type:'session_meta', timestamp:new Date(at - 1000).toISOString(), payload:{
      ...(session ? {id:session} : {}), ...(creator ? {creator_account_id:creator} : {})}});
  lines.push({type:'turn_context', timestamp:new Date(at - 500).toISOString(), payload:{model:'gpt-6-sol'}});
  const usage = {input_tokens:1_000_000, cached_input_tokens:0, output_tokens:0, reasoning_output_tokens:0, total_tokens:1_000_000};
  lines.push({type:'event_msg', timestamp:new Date(at).toISOString(), payload:{type:'token_count',
    info:{total_token_usage:usage, last_token_usage:usage}, ...(rateLimits ? {rate_limits:rateLimits} : {})}});
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
};
const codexWindow = now => ({account:'codex', resource:'codex:codex:10080', start_at:now - 4 * 86_400_000, observed_at:now,
  meter_points:2, account_week_id:'w', week_start:now - 4 * 86_400_000});

test('Codex use counts only with plan rate limits, the lent sign-in and an identity that survives a copy', t => {
  const now = Date.UTC(2026, 9, 31), day = 86_400_000;
  const measureCodex = (files, auth) => {
    const root = home(t);
    if (auth) writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify(auth));
    for (const [name, contents] of files) writeFileSync(join(root, '.codex', 'sessions', '2026', '10', name), contents);
    const attribution = createLogAttributionStore({directory:scratch(t), now:() => now - 2 * day}).update(localLogRoots(root, {env:{}}), pins);
    const logs = files.map(([name]) => logFile(root, `.codex/sessions/2026/10/${name}`, 'codex', now));
    return measureFrom(root, logs, now, attribution).codex;
  };
  const at = now - day / 2;
  // $2 of plan use for (2 + 1) points.
  assert.equal(measureCodex([['a.jsonl', codexLines({at})]]).upper_micro, 1_500_000);
  // A copied file with no event ids is priced once: its events are named by their session and running totals.
  assert.equal(measureCodex([['a.jsonl', codexLines({at})], ['a-copy.jsonl', codexLines({at})]]).upper_micro, 1_500_000);
  // Events that cannot be tied to the plan add no cost, so they never make the rate lower.
  assert.equal(measureCodex([['a.jsonl', codexLines({at})], ['b.jsonl', codexLines({at, session:'s-2', rateLimits:null})]]).upper_micro, 1_500_000);
  assert.equal(measureCodex([['a.jsonl', codexLines({at})], ['b.jsonl', codexLines({at, session:'s-3', creator:'someone-else'})]]).upper_micro, 1_500_000);
  assert.equal(measureCodex([['a.jsonl', codexLines({at})], ['b.jsonl', codexLines({at, session:'s-4', creator:null})]]).upper_micro, 1_500_000);
  assert.equal(measureCodex([['a.jsonl', codexLines({at})], ['b.jsonl', codexLines({at, session:null})]]).upper_micro, 1_500_000);
  // With only such events there is no measurement.
  assert.equal(measureCodex([['b.jsonl', codexLines({at, rateLimits:null})]]), null);
  assert.equal(measureCodex([['b.jsonl', codexLines({at, session:null})]]), null);
  // A Codex home signed in with an API key is on no lent account.
  assert.equal(measureCodex([['a.jsonl', codexLines({at})]], {OPENAI_API_KEY:'synthetic', tokens:{account_id:CODEX}}), null);
  assert.equal(measureCodex([['a.jsonl', codexLines({at})]], {auth_mode:'apikey', tokens:{account_id:CODEX}}), null);
});

test('Codex plan use with no account named in its sessions says so, apart from the first measurement', t => {
  const now = Date.UTC(2026, 9, 31), day = 86_400_000, at = now - day / 2;
  const reasonFor = (creator, rateLimits) => {
    const root = home(t);
    writeFileSync(join(root, '.codex', 'sessions', '2026', '10', 'a.jsonl'), codexLines({at, creator, rateLimits}));
    const attribution = createLogAttributionStore({directory:scratch(t), now:() => now - 2 * day}).update(localLogRoots(root, {env:{}}), pins);
    const rows = [];
    importLendingHistory({consent:true, now, loadSessionLogs:() => [logFile(root, '.codex/sessions/2026/10/a.jsonl', 'codex', now)],
      logAttribution:attribution, onKappa:row => rows.push(row), currentWindows:[codexWindow(now)]});
    return rows.find(row => row.account === 'codex');
  };
  const old = reasonFor(null);
  assert.equal(old.estimate, null);
  assert.equal(old.reason, 'creator_unknown');
  // Another account's session, no plan limits, or a measurable session is not this case.
  assert.equal(reasonFor('someone-else').reason, null);
  assert.equal(reasonFor(null, null).reason, null);
  assert.equal(reasonFor(CODEX).reason, null);
  assert.ok(reasonFor(CODEX).estimate);
  // The learning copy names the cause and the fix; the account still lends (it was a 'measuring' hold before native-window mode).
  const copy = learningCopy({reason:'learning', provider:'codex', window:'weekly', creator_unknown:true});
  assert.equal(copy.line, learningCreatorUnknownLine('weekly'));
  assert.match(copy.line, /Updating the Codex CLI/);
  assert.match(copy.line, /lends now/);
  assert.doesNotMatch(copy.line, /as usual/);
});

test('only the Codex bucket the lent meter reads counts as plan use', t => {
  const now = Date.UTC(2026, 9, 31), day = 86_400_000, at = now - day / 2;
  const measureWith = rateLimits => {
    const root = home(t);
    writeFileSync(join(root, '.codex', 'sessions', '2026', '10', 'a.jsonl'), codexLines({at, rateLimits}));
    const attribution = createLogAttributionStore({directory:scratch(t), now:() => now - 2 * day}).update(localLogRoots(root, {env:{}}), pins);
    return measureFrom(root, [logFile(root, '.codex/sessions/2026/10/a.jsonl', 'codex', now)], now, attribution).codex;
  };
  const window = {primary:{used_percent:3, window_minutes:10080}};
  assert.ok(measureWith({...window, limit_id:'codex'}));
  assert.ok(measureWith({...window, limit_id:null}));
  assert.ok(measureWith(window));
  assert.equal(measureWith({...window, limit_id:'codex_other'}), null);
});

test('an unreadable attribution file is unknown: update refuses to replace it and the bytes survive', t => {
  const root = home(t), directory = scratch(t), file = join(directory, 'lending-log-attribution.json');
  writeFileSync(file, '{"version":1,"roots":{"truncated');
  const before = readFileSync(file);
  const store = createLogAttributionStore({directory, now:() => 1});
  assert.throws(() => store.update(localLogRoots(root, {env:{}}), pins), {code:'state_unknown'});
  assert.deepEqual(readFileSync(file), before);
  assert.equal(store.current('claude'), null);
  // A file that parses but has another shape is also not ours to replace.
  writeFileSync(file, JSON.stringify({version:2, roots:{}}));
  assert.throws(() => store.update(localLogRoots(root, {env:{}}), pins), {code:'state_unknown'});
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({version:2, roots:{}}));
});

test('an attribution file that cannot be opened is unknown, not absent', t => {
  if (process.getuid?.() === 0) return t.skip('root ignores file modes');
  const root = home(t), directory = scratch(t), file = join(directory, 'lending-log-attribution.json');
  writeFileSync(file, JSON.stringify({version:1, roots:{}, providers:{}}));
  chmodSync(file, 0);
  t.after(() => { try { chmodSync(file, 0o600); } catch {} });
  const store = createLogAttributionStore({directory, now:() => 1});
  assert.throws(() => store.update(localLogRoots(root, {env:{}}), pins), {code:'state_unknown'});
});

test('an unreadable funding or identity file leaves its folder on no lent account', t => {
  const root = home(t);
  const lentFolder = roots => roots.find(r => r.provider === 'claude' && r.path === join(root, '.claude-lent', 'projects'));
  assert.equal(lentFolder(localLogRoots(root, {env:{}})).account_sha256_16, hx(LENT), 'control: readable files attribute');
  writeFileSync(join(root, '.claude-lent', 'settings.json'), '{not json');
  assert.equal(lentFolder(localLogRoots(root, {env:{}})).account_sha256_16, null, 'unknown API-key settings');
  rmSync(join(root, '.claude-lent', 'settings.json'));
  writeFileSync(join(root, '.claude-lent', 'settings.local.json'), '{not json');
  assert.equal(lentFolder(localLogRoots(root, {env:{}})).account_sha256_16, null, 'unknown local settings');
  const codex = () => localLogRoots(root, {env:{}}).find(r => r.provider === 'codex' && r.default);
  assert.equal(codex().account_sha256_16, hx(CODEX));
  writeFileSync(join(root, '.codex', 'auth.json'), '{not json');
  assert.equal(codex().account_sha256_16, null, 'unknown Codex auth');
});
