import {freshLink} from '../../tests/helpers/fresh-link.mjs';
// Ship check S6: two isolated Faravan app homes (owner lends, friend asks), lending ON in automatic mode.
// Orchestrator. Usage: node smoke.mjs <source-checkout> <--synthetic|--live> <run-dir> [--owner-home <dir>]
//
// User actions use the UI. The ops API reads back state and supplies the one documented admission-mode setting gap.
// IPC reads the original Stop attempt through the running app and handles shutdown and synthetic run controls.
// Evidence readers (evidence.mjs) are the same in both modes: the app's pace50 state file and its sbx process scan.
// See README.md for what each check means.
import {fork, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {MICRO, convertUsd, judgeOwnerStop, readPace50Attempt, readPace50Attempts, pointsFor, breachesFor, sumPointsAsUsdMicro, cumulativeProviderGate, compareSpendLedger,
  installedDataHome, sandboxScan, judgeNothingRunning, agentModelMatches, readPreparedStopIdentity, judgeRecordedStopRemoval} from './evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const [SRC_ARG, MODE_ARG, RUN_ARG] = args;
const live = MODE_ARG === '--live';
const ownerHomeFlag = args.indexOf('--owner-home');
const OWNER_HOME = ownerHomeFlag >= 0 ? resolve(args[ownerHomeFlag + 1] ?? '') : null;
const SRC = resolve(SRC_ARG ?? '');
const RUN = resolve(RUN_ARG ?? '');

const HAIKU = 'claude-haiku-5-5';
const CLAUDE = 'claude-code-subscription';
const JOB_CAP_USD = live ? 1.5 : 2; // Live: just above the $1.32 worst-case Haiku call the app requires per job; synthetic mirrors the reference smoke.
const TOTAL_CAP_USD = live ? 2 : 4;
const CAP_USD_MICRO = JOB_CAP_USD * MICRO, TOTAL_CAP_USD_MICRO = TOTAL_CAP_USD * MICRO;
const SYNTHETIC_COST_USD = 0.37;  // what the synthetic meter reports per run (synthetic mode only)
const SETTLE_MS = 8000;           // after a Stop, before the owner's state is read (both modes)
const TOKENS = {input: 1200, output: 300};
const ACTIVE = new Set(['queued', 'claimed', 'preparing', 'running', 'accepted', 'starting']);
const FAULT_STATES = /^(error|failed|blocked|unreachable|degraded|crashed)$/i;

const started = new Date().toISOString();
const log = (...parts) => console.error(new Date().toISOString(), ...parts);
function refuse(message) { console.log(JSON.stringify({pass: false, error: message})); process.exit(2); }

// ---- guards -------------------------------------------------------------------------------------------------------
if (!SRC_ARG || !MODE_ARG || !RUN_ARG) refuse('usage: smoke.mjs <source-checkout> <--synthetic|--live> <run-dir> [--owner-home <dir>]');
if (!fs.existsSync(join(SRC, 'tests/helpers/v1-app-fixture.mjs'))) refuse('not a Faravan checkout: ' + SRC);
if (!['--synthetic', '--live'].includes(MODE_ARG)) refuse('mode must be --synthetic or --live');
if (live) {
  if (process.env.SMOKE_LIVE_CONFIRM !== '1') refuse('refusing --live: set SMOKE_LIVE_CONFIRM=1 to run against the real Claude account');
  if (!ownerHomeFlag || !OWNER_HOME) refuse('--live needs --owner-home <dedicated owner home directory>');
  if (!fs.existsSync(OWNER_HOME)) refuse('owner home does not exist: ' + OWNER_HOME);
  const realHome = process.env.HOME ? resolve(process.env.HOME) : null;
  if (realHome && (OWNER_HOME === realHome || OWNER_HOME.startsWith(realHome + '/.claude') || OWNER_HOME.startsWith(realHome + '/.codex')))
    refuse('refusing --owner-home inside the operator HOME or its account config directories');
}
fs.mkdirSync(RUN, {recursive: true, mode: 0o700});
fs.mkdirSync(join(RUN, 'tmp'), {recursive: true, mode: 0o700}); // TMPDIR for the apps; created only after the guards pass

// ---- run directories ----------------------------------------------------------------------------------------------
const dirs = {};
for (const role of ['owner', 'friend']) {
  const base = join(RUN, role);
  const home = join(dirname(RUN), role, 'home');
  dirs[role] = {base, home, tmp: join(base, 'tmp'), codex: join(base, 'codex'), claude: join(base, 'claude'),
    faravan: join(home, '.faravan'), coordinator: join(base, 'coordinator'), run: join(base, 'run')};
  for (const d of Object.values(dirs[role])) fs.mkdirSync(d, {recursive: true, mode: 0o700});
}
if (live) {
  // The owner runs against the dedicated owner home the operator supplied; its Claude sign-in lives under <owner-home>/claude.
  // Only the sign-ins carry over: Faravan data, HOME and the circle service start fresh, like a new install.
  Object.assign(dirs.owner, {codex: join(OWNER_HOME, 'codex'), claude: join(OWNER_HOME, 'claude')});
  for (const d of [dirs.owner.codex, dirs.owner.claude]) fs.mkdirSync(d, {recursive: true, mode: 0o700});
}

// A minimal environment: nothing from the operator's shell (no tokens, no real HOME) reaches an app process.
// The containerd socket under <home>/.wfsbx is longer than the 104-character limit for this owner home, so in live mode
// the owner's sandbox service lives at a short directory of its own (SMOKE_OWNER_SBX_HOME, default ~/.s6sbx).
const OWNER_SBX_OVERRIDE = live ? (process.env.SMOKE_OWNER_SBX_HOME || join(process.env.HOME ?? '/nonexistent', '.s6sbx')) : '';
function childEnv(role) {
  const d = dirs[role];
  return {...(role === 'owner' && OWNER_SBX_OVERRIDE ? {FARAVAN_SBX_HOME: OWNER_SBX_OVERRIDE} : {}),PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: process.env.TZ ?? 'UTC',
    ...(process.env.JOURNEY_SBX_SHORT_HOME_BASE ? {FARAVAN_SBX_SHORT_HOME_BASE: process.env.JOURNEY_SBX_SHORT_HOME_BASE} : {}),
    TMPDIR: d.tmp, HOME: d.home, CODEX_HOME: d.codex, CLAUDE_CONFIG_DIR: d.claude,
    FARAVAN_COORDINATOR_HOME: d.coordinator, XDG_RUNTIME_DIR: d.run, DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    DISPLAY: '', WAYLAND_DISPLAY: '', FARAVAN_NO_BROWSER: '1', FARAVAN_NO_UPDATE: '1'};
}

// ---- processes ----------------------------------------------------------------------------------------------------
const procs = {};
const processLog = [];
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out: ' + label)), ms); })])
    .finally(() => clearTimeout(timer));
}
function spawnApp(role) {
  const installRoot = join(dirs[role].home, '.local', 'lib', 'faravan');
  const cfg = {src: SRC, installRoot, role, lender: 'owner', live, costUsd: SYNTHETIC_COST_USD, tokens: TOKENS, model: HAIKU};
  const out = fs.openSync(join(RUN, role + '.log'), 'a', 0o600);
  fs.writeFileSync(join(RUN, 'started.'+role+'.app'), '', {mode:0o600});
  const child = fork(join(HERE, 'smoke-child.mjs'), [JSON.stringify(cfg)], {execPath: join(installRoot, 'runtime/bin/node'),
    env: childEnv(role), cwd: dirs[role].base, stdio: ['ignore', out, out, 'ipc']});
  fs.closeSync(out);
  let nextId = 0; const pending = new Map();
  const rec = {role, pid: child.pid, startedAt: new Date().toISOString(), stoppedAt: null, exit: null, forcedKill: false};
  processLog.push(rec);
  child.on('message', m => {
    const waiter = pending.get(m.id);
    if (!waiter) return;
    pending.delete(m.id);
    m.error ? waiter.reject(new Error(m.error)) : waiter.resolve(m.value);
  });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => {
    rec.stoppedAt = new Date().toISOString(); rec.exit = {code, signal};
    for (const w of pending.values()) w.reject(new Error(role + ' process exited'));
    pending.clear();
    resolveExit({code, signal});
  }));
  const readyPromise = new Promise((resolveReady, reject) => {
    child.on('message', m => { if (m.ready) resolveReady(m.ready); });
    child.once('exit', () => reject(new Error(role + ' exited before it was ready; see ' + join(RUN, role + '.log'))));
  });
  const control = (command, payload) => new Promise((resolveCtl, reject) => {
    if (!child.connected) return reject(new Error(role + ' IPC closed'));
    const id = ++nextId;
    pending.set(id, {resolve: resolveCtl, reject});
    child.send({id, command, payload}, e => { if (e) { pending.delete(id); reject(e); } });
  });
  const shutdown = async () => {
    if (child.exitCode === null && child.signalCode === null && child.connected) {
      try { await withTimeout(control('shutdown'), 30000, role + ' shutdown'); } catch (error) { log('graceful shutdown failed', role, error.message); }
    }
    if (child.exitCode === null && child.signalCode === null) await withTimeout(exited, 5000, role + ' exit').catch(() => {});
    if (child.exitCode === null && child.signalCode === null) { rec.forcedKill = true; child.kill('SIGKILL'); }
    await withTimeout(exited, 10000, role + ' forced exit');
  };
  const info = {child, control, shutdown, exited, readyPromise};
  procs[role] = info;
  return info;
}
async function startApp(role) {
  const info = spawnApp(role);
  const ready = await withTimeout(info.readyPromise, 90000, role + ' startup');
  info.origin = ready.origin;
  info.token = ready.token;
  if (!info.token) throw new Error(role + ' ready without a session token');
  const raw = fs.readFileSync(`/proc/${ready.pid}/environ`, 'utf8');
  const env = Object.fromEntries(raw.split('\0').filter(Boolean).map(item => {
    const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)];
  }));
  const faravan = resolve(dirs[role].faravan) + '/';
  const xdgInsideData = Object.entries(env).filter(([key, value]) => key.startsWith('XDG_') &&
    (resolve(value) + '/').startsWith(faravan)).map(([key]) => key);
  const channelFile = join(dirs[role].home, '.local', 'channel');
  const installDataHome = installedDataHome(fs.readFileSync(channelFile, 'utf8'));
  const profile = {homeMatches: env.HOME === dirs[role].home && installDataHome === dirs[role].faravan &&
      fs.existsSync(join(dirs[role].faravan, 'v1', 'state.json')), expectedHome: dirs[role].home,
    installChannel: fs.readFileSync(channelFile, 'utf8').match(/^channel=(.+)$/m)?.[1] ?? null, installDataHome,
    xdgInsideFaravanData: xdgInsideData,
    installedRuntimeMatches: resolve(fs.readlinkSync(`/proc/${ready.pid}/exe`).replace(/ \(deleted\)$/, '')) ===
      resolve(join(dirs[role].home, '.local', 'lib', 'faravan', 'runtime/bin/node')),
    installedAppModuleMatches: ready.installedAppModule === join(dirs[role].home, '.local', 'lib', 'faravan', 'lib/v1/app.mjs')};
  summary.profiles[role] = profile;
  if (!profile.homeMatches || xdgInsideData.length || !profile.installedRuntimeMatches || !profile.installedAppModuleMatches)
    throw new Error(`${role} /proc/install profile check failed: ${JSON.stringify(profile)}`);
  return ready;
}

// ---- HTTP operations ----------------------------------------------------------------------------------------------
async function op(role, id, input = {}, {write = false, confirm = false} = {}) {
  const app = procs[role];
  const headers = {'x-faravan-session-token': app.token, 'content-type': 'application/json'};
  if (confirm) headers['faravan-confirm'] = 'yes';
  if (write) headers['idempotency-key'] = randomUUID();
  const response = await fetch(app.origin + '/api/ops/' + id, {method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(60000)});
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${role} ${id} -> ${response.status}: ${text.slice(0, 600)}`);
  return body;
}
// The tray reports how long the owner has been idle; automatic lending runs only while the owner is away. Live mode has
// no tray, so the smoke reports the owner away (15 minutes idle) every 20 s, as the tray does on an idle desktop.
let presenceTimer = null;
async function reportOwnerAway() {
  const app = procs.owner;
  if (!app?.token) return;
  await fetch(app.origin + '/api/desktop/presence', {method: 'POST', headers: {'x-faravan-session-token': app.token, 'content-type': 'application/json'},
    body: JSON.stringify({idleSeconds: 900}), signal: AbortSignal.timeout(15000)}).catch(error => log('presence report failed', error.message));
}
function startPresence() {
  if (!live || presenceTimer) return;
  reportOwnerAway();
  presenceTimer = setInterval(reportOwnerAway, 20000);
}
function stopPresence() { if (presenceTimer) clearInterval(presenceTimer); presenceTimer = null; }
// Synthetic-only controls. Live mode has no synthetic run, so these return null there.
async function ipc(command, payload) {
  if (live) return null;
  return procs.owner.control(command, payload);
}

// ---- helpers ------------------------------------------------------------------------------------------------------
async function waitUntil(label, check, timeoutMs = 60000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = null, lastError = null;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; }
    catch (error) { lastError = error.message; }
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error('timed out waiting for ' + label + (lastError ? ' (last error: ' + lastError.slice(0, 300) + ')' : ''));
}
const stateOf = job => job?.state ?? null;
const attemptOf = job => job?.current_attempt ?? null;
// The owner's job ledger: every job it can see, with its digest and final state.
async function readJobs(role) {
  const list = await op(role, 'jobs.list', {circle: summary.circle});
  const rows = Array.isArray(list) ? list : (list.jobs ?? []);
  return rows.map(j => ({digest: j.digest ?? j.job_digest ?? j.jobDigest ?? null, state: j.state ?? null})).sort((a, b) => String(a.digest).localeCompare(String(b.digest)));
}
function readSpendLedger(digests) {
  const spend = [];
  for (const digest of digests) {
    const {attempts} = readPace50Attempts(dirs.owner.faravan, digest);
    if (!attempts.length) return null;
    for (const attempt of attempts) {
      if (!Array.isArray(attempt.resources) || attempt.resources.length === 0) return null;
      for (const row of attempt.resources) {
        if (![row.kappa_micro, row.baseline_used_micro, row.aggregate_used_micro, row.spent_micro, row.initial_micro].every(Number.isSafeInteger)) return null;
        spend.push({digest, attemptId: attempt.id, resource: row.id, instance: row.instance ?? null,
          kappaMicro: row.kappa_micro, baselineMicro: row.baseline_used_micro, aggregateMicro: row.aggregate_used_micro,
          spentMicro: row.spent_micro, reservedMicro: row.initial_micro});
      }
    }
  }
  return spend;
}
const summary = {
  pass: false, journeyVersion: 15, harnessVersion: 15, mode: live ? 'live' : 'synthetic', src: SRC, srcHead: null, runDir: RUN, startedAt: started,
  claimScope: {
    proves: ['fresh Faravan data directories for two local app processes', 'UI-driven circle invitation, join, owner approval, first job, result retrieval, Stop and owner restart',
      'installation of a locally built candidate tarball from this checkout'],
    doesNotProve: ['fresh Docker or provider sign-in onboarding', 'the published download or release artifact', 'connectivity between different machines or networks'],
    exceptions: [
      {step: 'desktop presence', reason: 'headless runs cannot start the tray; the harness reports {idleSeconds: 900} to the app'},
      {step: 'admission mode configuration', reason: 'the product has no UI control to set this mode directly; the harness uses the mode-setting API, then verifies the saved mode'},
      {step: 'synthetic account readiness', reason: 'synthetic mode seeds the fixture account as not selected so the UI must select it; live mode has no agents.select write'},
    ],
  },
  caps: {perJobUsd: JOB_CAP_USD, totalUsd: TOTAL_CAP_USD}, circle: null, jobs: [], ledger: {}, meter: {}, restart: {},
  checks: {}, profiles: {}, info: {}, missing: {}, processes: processLog, notes: [],
};
const note = message => { summary.notes.push(message); log(message); };

// The Faravan UI reads navigator.onLine. Under a no-network sandbox the browser reports offline, so the test helper's
// shim makes the UI read online; where the browser already reports online it changes nothing.
async function uiChromium() {
  const {chromium} = await import('@playwright/test');
  const {installOnlineShim} = await import(pathToFileURL(join(SRC, 'tests/helpers/browser-online-shim.mjs')).href);
  installOnlineShim(chromium);
  return chromium;
}

async function checkUiPagesAndCircle() {
  const chromium = await uiChromium();
  const browser = await chromium.launch({headless: true});
  let owner = null, friend = null;
  try {
    for (const role of ['owner', 'friend']) {
      const page = await browser.newPage();
      const url = new URL((await freshLink(procs[role].origin, procs[role].token)));
      url.hash = '#/setup';
      await page.goto(url.toString());
      await page.locator('main').waitFor({state: 'visible'});
      const commands = await page.locator('pre,code,kbd').allTextContents();
      const unexpected = commands.map(x => x.trim()).filter(x => x && !/(docker\s+sandbox(?:es)?\s+install|sbx\s+install)/i.test(x));
      if (unexpected.length) throw new Error(`${role} Setup shows command text outside Docker Sandboxes install: ${unexpected.join(' | ')}`);
      summary.ui ??= {};
      summary.ui[role] = {setupLoaded: true, unexpectedSetupCommands: unexpected};
      await page.close();
    }
    owner = await browser.newPage();
    friend = await browser.newPage();
    const route = async (page, role, hash) => {
      const url = new URL((await freshLink(procs[role].origin, procs[role].token))); url.hash = hash;
      await page.goto(url.toString());
      await page.locator('main').waitFor({state: 'visible'});
    };

    await route(owner, 'owner', '#/circles/host');
    await owner.getByLabel('Circle name', {exact: true}).fill('Journey friends');
    await owner.getByRole('radio', {name: /Local network only/}).check();
    fs.writeFileSync(join(RUN, 'started.owner.host'), '', {mode:0o600});
    await owner.getByRole('button', {name: 'Start circle', exact: true}).click();
    await owner.getByRole('link', {name: 'Invite someone', exact: true}).click({timeout: 30000});
    await owner.getByRole('tab', {name: 'Settings', exact: true}).click();
    const approveEach = owner.getByRole('switch', {name: 'Approve each computer', exact: true});
    if (await approveEach.getAttribute('aria-checked') !== 'true') await approveEach.click();
    await owner.getByRole('button', {name: 'Invite someone', exact: true}).click();
    await owner.getByLabel('Invitation for').selectOption('person');
    await owner.getByRole('button', {name: 'Create invitation', exact: true}).click();
    const invitation = await owner.getByLabel('Invitation link').inputValue();
    if (!invitation) throw new Error('UI did not create an invitation link');

    await route(friend, 'friend', '#/circles');
    await friend.getByRole('button', {name: 'Join with an invitation', exact: true}).click();
    await friend.getByRole('textbox', {name: 'Invitation', exact: true}).fill(invitation);
    await friend.getByRole('button', {name: 'Review invitation', exact: true}).click();
    await friend.getByRole('button', {name: 'Join circle', exact: true}).click();
    await expectVisible(friend.getByRole('status').filter({hasText: /^Request sent\./}).first());
    await owner.getByRole('tab', {name: 'Settings', exact: true}).click();
    const approval = owner.getByRole('button', {name: /^Approve /});
    await approval.waitFor({state: 'visible', timeout: 30000});
    await approval.click();
    await owner.getByText('Approved. Approving membership does not turn lending on.', {exact: true}).waitFor({state: 'visible'});
    summary.ui.circleCreatedInvitedJoinedApproved = true;
    summary.ui.circleName = 'Journey friends';

    await route(owner, 'owner', '#/lend');
    const claude = owner.getByRole('switch', {name: 'Lend with Claude Code', exact: true});
    await claude.waitFor({state: 'visible'});
    if (await claude.getAttribute('aria-checked') !== 'true') await claude.click();
    await waitUntil('Claude Code lending switch on', async () => await claude.getAttribute('aria-checked') === 'true', 30000, 200);
    const claudeCodeOn = await claude.getAttribute('aria-checked') === 'true';
    const claudeFacts = (await op('owner', 'agents.list', {})).find(agent => agent.id === CLAUDE) ?? null;
    summary.ui.agentLendReadback = claudeFacts;
    await owner.locator('.lagent[aria-labelledby="agent-claude-code-subscription"] details.tech summary').click();
    const modelForm = owner.locator('.agent-control');
    const checkClaude = owner.getByRole('button', {name: 'Check Claude Code', exact: true});
    if (await checkClaude.isVisible().catch(() => false)) {
      await checkClaude.click();
      await modelForm.waitFor({state: 'visible', timeout: 120000});
    }
    const model = modelForm.locator('select').first();
    await model.waitFor({state: 'visible', timeout: 30000}).catch(async error => {
      const text = (await owner.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 2000);
      throw new Error(`Model control unavailable after the UI agent check: ${JSON.stringify({claudeFacts, text, error: error.message})}`);
    });
    await model.selectOption(HAIKU);
    await modelForm.getByRole('button', {name: 'Save', exact: true}).click();
    const selectedModel = await model.inputValue();
    const savedAgentsResponse = await fetch(procs.owner.origin + '/api/agents', {
      headers: {'x-faravan-session-token': procs.owner.token}, signal: AbortSignal.timeout(15000)});
    if (!savedAgentsResponse.ok) throw new Error(`saved agent settings readback failed: HTTP ${savedAgentsResponse.status}`);
    const savedAgents = await savedAgentsResponse.json();
    const savedClaude = savedAgents.find(agent => agent.id === CLAUDE);
    if (!agentModelMatches(savedAgents, CLAUDE, HAIKU))
      throw new Error(`Claude model was not saved: ${JSON.stringify({form: selectedModel, saved: savedClaude?.run ?? null})}`);
    const limitsUrl = new URL((await freshLink(procs.owner.origin, procs.owner.token)));
    limitsUrl.hash = '#/lend/limits';
    await owner.goto(limitsUrl.toString());
    await owner.getByText('Account plan and consent', {exact: true}).click();
    await owner.locator('details.allow-plan').nth(0).locator('summary').click();
    const claudePlan = owner.getByLabel('Claude plan', {exact: true});
    await claudePlan.selectOption({label: 'Max 20×'});
    const consent = owner.getByRole('switch', {name: 'Run friends’ jobs from Claude without asking', exact: true});
    if (await consent.getAttribute('aria-checked') !== 'true') await consent.click();
    await owner.getByLabel('Jobs a day', {exact: true}).fill('5');
    await owner.getByLabel('Minutes a day', {exact: true}).fill('60');
    const ownerLimit = owner.getByLabel('Most one friend’s job may spend', {exact: true});
    await ownerLimit.fill(String(JOB_CAP_USD));
    await owner.getByRole('button', {name: 'Save limit', exact: true}).click();
    await owner.getByRole('button', {name: 'Save the limit', exact: true}).click();
    await owner.getByRole('button', {name: 'Save', exact: true}).click();
    const selectedClaudePlan = await claudePlan.inputValue();
    summary.ui.lending = {claudeCodeOn, model: savedClaude.run.model, consent: await consent.getAttribute('aria-checked') === 'true',
      claudePlan: selectedClaudePlan === 'max20' ? 'Max 20×' : selectedClaudePlan};
    if (!summary.ui.lending.claudeCodeOn) throw new Error('Claude Code did not stay on in the Lend page');

    summary.checks.setupPagesLoad = summary.ui.owner.setupLoaded && summary.ui.friend.setupLoaded;
    summary.checks.setupHasOnlyDockerInstall = ['owner', 'friend'].every(role => summary.ui[role].unexpectedSetupCommands.length === 0);
    summary.checks.lendPageClaudeMax20 = summary.ui.lending.claudeCodeOn && summary.ui.lending.claudePlan === 'Max 20×';
    summary.checks.lendingSettingsThroughUi = summary.ui.lending.model === HAIKU && summary.ui.lending.consent;
    summary.checks.circleInviteJoinApprovalUi = summary.ui.circleCreatedInvitedJoinedApproved === true;
    const lendUrl = new URL((await freshLink(procs.owner.origin, procs.owner.token))); lendUrl.hash = '#/lend'; await owner.goto(lendUrl.toString());
    const lendingSwitch = owner.getByRole('switch', {name: 'Lending', exact: true});
    if (await lendingSwitch.getAttribute('aria-checked') !== 'true') await lendingSwitch.click();
    await waitUntil('Lending switch on', async () => await lendingSwitch.getAttribute('aria-checked') === 'true', 30000, 200);
    if (await lendingSwitch.getAttribute('aria-checked') !== 'true') throw new Error('Lending UI switch did not turn lending on');
    summary.ui.lendingOnFromUi = true;
    summary.checks.lendingOnFromUi = true;
  } finally {
    await Promise.all([owner, friend].filter(Boolean).map(page => page.close().catch(() => {})));
    await browser.close();
  }
}

async function expectVisible(locator) {
  await locator.waitFor({state: 'visible', timeout: 30000});
}

async function sendFirstJobFromUi(circle) {
  const chromium = await uiChromium();
  const {confirmFirstSend} = await import(pathToFileURL(join(SRC, 'tests/browser-verify/first-send-test-helper.mjs')).href);
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    const url = new URL((await freshLink(procs.friend.origin, procs.friend.token))); url.hash = '#/new';
    await page.goto(url.toString());
    await page.locator('main').waitFor({state: 'visible'});
    await page.getByLabel('Circle', {exact: true}).selectOption({label: 'Journey friends'});
    await page.getByRole('radio', {name: 'No project', exact: true}).check();
    await page.getByRole('textbox', {name: 'What the agent should do', exact: true}).fill('Write one haiku about the sea. Reply with the haiku only.');
    const send = page.getByRole('button', {name: 'Send', exact: true});
    await send.click();
    const firstSendNoticeShown = await confirmFirstSend(page, {required: true});
    if (!firstSendNoticeShown) throw new Error('fresh friend first-send notice was not confirmed');
    summary.ui.firstSendNoticeShown = true;
    await page.waitForURL(/#\/job\//, {timeout: 30000});
    const rawHash = decodeURIComponent(new URL(page.url()).hash);
    const digest = rawHash.match(/sha256:[a-f0-9]{64}/)?.[0];
    if (!digest) throw new Error('Send page finished without a job digest in its URL');
    summary.ui.firstJobDigest = digest;
    summary.checks.friendSentJobFromUi = /^sha256:[a-f0-9]{64}$/.test(digest);
    return digest;
  } finally {
    await browser.close();
  }
}

async function readFriendResultFromUi(digest, circle) {
  const chromium = await uiChromium();
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    // Failed API reads on this page, so a missing result names the server's own error.
    const failedReads = [];
    page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/'))
      response.text().then(body => failedReads.push(response.status() + ' ' + new URL(response.url()).pathname + ' ' + body.slice(0, 600)), () => {}); });
    const url = new URL((await freshLink(procs.friend.origin, procs.friend.token)));
    url.hash = '#/job/' + encodeURIComponent(digest) + '/' + encodeURIComponent(circle);
    await page.goto(url.toString());
    const returned = page.locator('.result-prose');
    // A missing result names what the job page showed instead, so the run log explains the failure.
    await returned.first().waitFor({state: 'visible', timeout: 30000}).catch(async error => {
      const shown = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 2000);
      throw new Error(`friend job page never showed the returned message: ${error.message.split('\n')[0]} Page: ${shown} Failed reads: ${failedReads.join(' | ') || 'none'}`);
    });
    const message = (await returned.allTextContents()).join('\n').trim();
    const job = await op('friend', 'jobs.get', {digest, circle});
    if (!message || (job.digest ?? job.job_digest) !== digest || stateOf(job) !== 'result-accepted' || !new URL(page.url()).hash.includes(encodeURIComponent(digest)))
      throw new Error(`friend UI has no returned message for ${digest}: ${JSON.stringify({message, state: stateOf(job), url: page.url()})}`);
    return {digest, message, state: stateOf(job)};
  } finally {
    await browser.close();
  }
}

// The owner's lending state, read through lending.get: enabled, mode, the running attempt (current) and account states.
async function readLedger() {
  const v = await op('owner', 'lending.get', {});
  return {enabled: v.enabled, mode: v.mode, current: v.current,
    accountStates: (v.accountStates ?? []).map(a => ({account: a.account, status: a.status, jobDigest: a.jobDigest ?? null}))};
}
async function readMeter() {
  const m = await ipc('meter');
  return m ? {weekly: m.weekly, short: m.short, runs: m.runs} : null;
}
const snip = value => JSON.stringify(value).slice(0, 3000);

// The provider meter shows whole percents, so a small job moves it by 0; spentMicro is the app's own estimate.
function recordProviderDeltas() {
  summary.meter.providerPointDeltas = summary.jobs.flatMap(job => job.points?.rows?.map(row => ({
    job: job.label, resource: row.id, meterDeltaMicro: row.meterDeltaMicro, appEstimateMicro: row.spentMicro,
  })) ?? []);
  summary.meter.liveProviderDeltaRecorded = summary.meter.providerPointDeltas.length > 0;
  summary.meter.liveProviderDeltaReason = live && !summary.meter.liveProviderDeltaRecorded
    ? summary.jobs.length === 0 ? 'No job reached provider execution; the provider meter delta was not sampled.'
      : 'No provider point delta was observed.' : null;
}

// ---- main ---------------------------------------------------------------------------------------------------------
let exitCode = 0;
let activeAttempt = null; // {attemptId} while a job runs on the owner; used by a cap breach to stop it
const approvalsSeen = new Set();
const approvalsUiClicked = new Set();
const approvalsUiFor = new Set();
// SMOKE_ADMISSION=approve: the owner accepts each job by hand. Use it when the account has no spare the rule may lend
// automatically (an owner on pace to use the whole week); the cap, Stop, restart and meter checks are unchanged, and the
// report says the jobs were hand-approved.
const HAND_APPROVE = process.env.SMOKE_ADMISSION === 'approve';
summary.admissionMode = HAND_APPROVE ? 'approve' : 'automatic';
const accepted = new Set();
let totalUsd = 0;
const providerObservations = new Map(); // latest cumulative attempt reading by job and provider resource
try {
  summary.srcHead = execFileSync('git', ['-C', SRC, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  // The app's own sbx scanner and the sbx HOME selection, from the checkout under test (no copy of app logic here).
  const docker = await import(pathToFileURL(join(SRC, 'lib/docker-backend.mjs')).href);
  const OWNER_SBX_HOME = docker.selectSbxHome({home: dirs.owner.home, override: OWNER_SBX_OVERRIDE}).home;
  const scanOwner = () => sandboxScan(docker, OWNER_SBX_HOME);
  log('starting owner app', live ? '(live)' : '(synthetic)');
  await startApp('owner');
  log('starting friend app');
  await startApp('friend');
  // Seed only the synthetic fixture's detected account. Live mode must enable its account through the UI.
  if (!live) await op('owner', 'agents.select', {id: CLAUDE, useForLending: false}, {confirm: true});
  await checkUiPagesAndCircle();

  // -- 1. the circle, through the product: the owner hosts and invites; the friend joins; the owner admits the computer.
  const ownerCircles = await op('owner', 'circles.list', {});
  const hosted = await op('owner', 'hosting.get', {});
  const hostedId = hosted.circle_id ?? hosted.circle?.id ?? null;
  const named = ownerCircles.filter(c => c.name === summary.ui.circleName);
  const circle = (hostedId && ownerCircles.some(c => c.id === hostedId) ? hostedId : named.length === 1 ? named[0].id : null);
  if (!circle) throw new Error('hosting.start returned no circle: ' + snip(hosted));
  summary.circle = circle;
  const hostPort = hosted.local_port ?? hosted.port ?? null;
  const memberEvidence = async () => (await op('friend', 'circles.check', {circle})).membershipProjection;
  const approvedMembership = await waitUntil('friend membership projection approved', async () => {
    const projection = await memberEvidence();
    return projection?.phase === 'approved' && projection.evidence?.rosterMembershipVerified === true ? projection : null;
  });
  if ((await op('owner', 'circles.enrollments', {circle})).length !== 0)
    throw new Error('UI approval left a pending enrollment for the friend');
  summary.ui.friendMembership = approvedMembership;
  if (summary.ui.circleCreatedInvitedJoinedApproved !== true)
    throw new Error('friend membership is approved without the owner UI approval click');
  note('circle hosted, invited, joined and approved');

  // -- 2. the owner lends: this Claude account on Haiku, automatic admission, $2 per job.
  // Direct mode selection has no UI control; this is the single configuration write recorded as an exception.
  await op('owner', 'lending.set_mode', {circle, mode: HAND_APPROVE ? 'ask' : 'auto'}, {confirm: true});
  await waitUntil('lending on in automatic mode', async () => {
    const v = await op('owner', 'lending.get', {});
    return v.enabled === true && v.mode === (HAND_APPROVE ? 'ask' : 'auto');
  }, 30000);
  const [agentReadback, limitsReadback, ownerLimitReadback] = await Promise.all([
    op('owner', 'agents.list', {}), op('owner', 'limits.get', {}), op('owner', 'lending.owner_settings', {}),
  ]);
  const lendingReadback = await op('owner', 'lending.get', {});
  if (!agentModelMatches(agentReadback, CLAUDE, HAIKU))
    throw new Error(`Claude model did not persist after lending settings were saved: ${JSON.stringify(agentReadback.find(agent => agent.id === CLAUDE)?.run ?? null)}`);
  const claudeReadback = agentReadback.find(agent => agent.id === CLAUDE);
  if (!summary.ui.lendingOnFromUi || !claudeReadback?.useForLending ||
      limitsReadback.limits?.dailyJobs !== 5 || limitsReadback.limits?.dailyMinutes !== 60 ||
      limitsReadback.limits?.lendingPolicy?.providerConsent?.claude !== true ||
      limitsReadback.limits?.lendingPolicy?.accountPlans?.claude !== 'max20' ||
      ownerLimitReadback.values?.maxJobUsd !== JOB_CAP_USD)
    throw new Error(`UI lending settings did not read back from the app: ${JSON.stringify({claudeReadback, limits: limitsReadback.limits, ownerLimit: ownerLimitReadback.values, ui: summary.ui.lending})}`);
  summary.ui.lendingReadback = {agentSelected: claudeReadback.useForLending, dailyJobs: limitsReadback.limits.dailyJobs,
    dailyMinutes: limitsReadback.limits.dailyMinutes, maxJobUsd: ownerLimitReadback.values.maxJobUsd,
    providerConsent: limitsReadback.limits.lendingPolicy.providerConsent.claude,
    accountPlan: limitsReadback.limits.lendingPolicy.accountPlans.claude,
    mode: lendingReadback.mode, enabled: lendingReadback.enabled};
  summary.ui.lending.model = claudeReadback.run.model;
  note('lending on, automatic, Haiku, $' + JOB_CAP_USD + ' per job');
  startPresence();

  const watchApprovals = async () => {
    for (const a of await op('owner', 'approvals.list', {})) {
      approvalsSeen.add(a.digest ?? a.jobDigest ?? a.id ?? JSON.stringify(a));
      if (HAND_APPROVE && a.id && !accepted.has(a.id)) {
        accepted.add(a.id);
        log('approval card', a.id, a.jobDigest ?? a.digest ?? '');
        const chromium = await uiChromium();
        const browser = await chromium.launch({headless: true});
        try {
          const page = await browser.newPage();
          const url = new URL((await freshLink(procs.owner.origin, procs.owner.token))); url.hash = '#/request/' + encodeURIComponent(a.id);
          await page.goto(url.toString());
          const approve = page.getByRole('button', {name: 'Run it', exact: true});
          await approve.waitFor({state: 'visible', timeout: 30000});
          await approve.click();
          approvalsUiClicked.add(a.id);
          approvalsUiFor.add(a.jobDigest ?? a.digest);
        } finally {
          await browser.close();
        }
      }
    }
  };
  // The USD the job was charged: the synthetic meter's runs since `before`, or receipt USD keys in live mode.
  const chargeOf = async (receipt, meterBefore) => {
    if (!live) {
      const after = await readMeter();
      const runs = (after?.runs ?? []).slice(meterBefore?.runs?.length ?? 0);
      const usdValues = runs.map(r => r.cost_usd);
      return {usdValues, complete: usdValues.length > 0 && usdValues.every(v => Number.isFinite(v) && v >= 0), runs, source: 'synthetic meter'};
    }
    // The public job receipt has no canonical USD charge. Live spend is reconciled from
    // the attempt's provider counters below; do not guess by recursively matching JSON keys.
    return {usdValues: [], complete: false, runs: [], source: 'provider counters'};
  };
  // The app's record of one job's points: spent_micro and the provider meter delta per reserved resource, against the
  // per-job cap and the run total so far, both converted at the resource's own kappa.
  const pointsGate = (label, digest) => {
    const {attempts, missing: fileMissing} = readPace50Attempts(dirs.owner.faravan, digest);
    const parsed = attempts.map(attempt => ({attempt, ...pointsFor(attempt, CAP_USD_MICRO)}));
    const rows = parsed.flatMap(({attempt, rows: attemptRows}) => attemptRows.map(row => ({...row, attemptId: attempt.id})));
    const fieldMissing = parsed.flatMap(({attempt, missing}) => missing.map(field => `${attempt.id}: ${field}`));
    const breaches = parsed.flatMap(({rows: attemptRows}) => breachesFor(attemptRows, label));
    const jobProviderGate = cumulativeProviderGate([{label, rows}], CAP_USD_MICRO);
    breaches.push(...jobProviderGate.breaches);
    const appSpend = sumPointsAsUsdMicro(rows, 'spentMicro');
    if (appSpend.usdMicro > CAP_USD_MICRO) breaches.push(`${label}: cumulative app spend ${appSpend.usdMicro} USD micro > job cap ${CAP_USD_MICRO}`);
    for (const r of rows) providerObservations.set(JSON.stringify([digest, r.attemptId, r.id, r.instance ?? null]), {label, rows: [r]});
    const totalGate = cumulativeProviderGate([...providerObservations.values()], TOTAL_CAP_USD_MICRO);
    breaches.push(...totalGate.breaches);
    const attempt = attempts.at(-1) ?? null;
    return {attemptId: attempt?.id ?? null, processState: attempt?.process_state ?? null, cessationProven: attempt?.cessation_proven ?? null,
      rows, missing: [...fileMissing, ...fieldMissing, ...jobProviderGate.missing, ...appSpend.missing], breaches, totalGate, file: dirs.owner.faravan + '/v1/lending-pace50-state.json'};
  };
  // Stop on the first breach or missing field: stop the running attempt, then fail the run. Missing data never passes.
  const enforceCap = async (label, gate, usdValues) => {
    const stopAndFail = async message => {
      if (activeAttempt) await op('owner', 'lending.stop_job', {attemptId: activeAttempt.attemptId}, {confirm: true}).catch(() => {});
      throw new Error(message);
    };
    if (gate.missing.length || gate.totalGate?.missing.length) {
      const missing = [...gate.missing, ...(gate.totalGate?.missing ?? [])];
      for (const m of missing) log(label, 'missing field:', m);
      await stopAndFail(`${label}: cannot check the cap, missing field(s): ${missing.join('; ')}`);
    }
    if (!live) {
      if (!usdValues.length || usdValues.some(v => !Number.isFinite(v) || v < 0))
        await stopAndFail(`${label}: missing or malformed canonical synthetic cost evidence`);
      totalUsd += usdValues.reduce((s, v) => s + v, 0);
    }
    const usdBreaches = usdValues.filter(v => v > JOB_CAP_USD).map(v => `usd ${v} > ${JOB_CAP_USD}`);
    if (totalUsd > TOTAL_CAP_USD) usdBreaches.push(`usd run total ${totalUsd.toFixed(2)} > ${TOTAL_CAP_USD}`);
    const all = [...gate.breaches, ...usdBreaches];
    if (all.length) await stopAndFail(`${label}: cap breach: ${all.join('; ')}`);
  };
  const monitorCapDuringExecution = async (label, digest) => {
    const gate = pointsGate(label, digest);
    if (gate.missing.length && activeAttempt) {
      await op('owner', 'lending.stop_job', {attemptId: activeAttempt.attemptId}, {confirm: true}).catch(() => {});
      throw new Error(`${label}: cap evidence missing during execution: ${gate.missing.join('; ')}`);
    }
    if (gate.breaches.length) {
      if (activeAttempt) await op('owner', 'lending.stop_job', {attemptId: activeAttempt.attemptId}, {confirm: true}).catch(() => {});
      throw new Error(`${label}: cap breach detected during execution: ${gate.breaches.join('; ')}`);
    }
  };

  // -- 3. job one: a small Haiku job, admitted with no approval click, runs to completion, result reaches the friend.
  summary.ledger.before = await readLedger();
  summary.meter.before = await readMeter();
  const d1 = await sendFirstJobFromUi(circle);
  note('job 1 sent from the UI Send page');
  let lastHoldLog = 0;
  const admitted1 = await waitUntil('job 1 running on the owner, admitted by the app', async () => {
    await watchApprovals();
    // While job 1 waits, log what the owner's lender says every 30 s, so a hold names its reason in the run log.
    if (Date.now() - lastHoldLog > 30000) {
      lastHoldLog = Date.now();
      const v = await op('owner', 'lending.get', {}).catch(error => ({error: error.message}));
      const d = v?.objective?.accounts?.[0]?.decision;
      log('owner lender', JSON.stringify({status: v?.status ?? null, reason: v?.reason ?? null, label: v?.label ?? null,
        decision: d?.reason ?? null, code: d?.objective?.reasonCode ?? null, error: v?.error ?? null}));
    }
    const j = await op('owner', 'jobs.get', {digest: d1, circle}).catch(() => null);
    const a = attemptOf(j);
    if (a?.attempt_id && a?.execution_started_at) activeAttempt = {attemptId: a.attempt_id};
    await monitorCapDuringExecution('job 1', d1);
    return a?.execution_started_at ? {job: j, attempt: a} : null;
  }, 120000); // bounded admission wait; the fixture is expected to decide without a live provider probe.
  const done1 = await waitUntil('job 1 terminal on the friend', async () => {
    const j = await op('friend', 'jobs.get', {digest: d1, circle});
    return ACTIVE.has(stateOf(j)) ? null : j;
  }, 180000);
  const friendResult1 = await readFriendResultFromUi(d1, circle);
  activeAttempt = null;
  await watchApprovals();
  const ownerDone1 = await op('owner', 'jobs.get', {digest: d1, circle});
  const receipt1 = await op('owner', 'jobs.receipt', {digest: d1, circle}).catch(e => ({error: e.message}));
  const charge1 = await chargeOf(receipt1, summary.meter.before);
  const gate1 = pointsGate('job 1', d1);
  summary.jobs.push({label: 'job1', digest: d1, attemptId: admitted1.attempt.attempt_id, friendState: stateOf(done1), resultOnFriendUi: friendResult1,
    ownerAttemptState: attemptOf(ownerDone1)?.state ?? null,
    attemptsStarted: admitted1.job?.attempts_started ?? attemptOf(ownerDone1)?.attempts_started ?? null,
    autoAdmitted: [...approvalsSeen].length === 0, approvalsSeen: [...approvalsSeen], charge: charge1, points: gate1});
  await enforceCap('job 1', gate1, charge1.usdValues);
  summary.ledger.afterJob1 = await readLedger();
  summary.meter.afterJob1 = await readMeter();

  // -- 4. job two: the owner presses Stop while the job is running.
  await ipc('hold');
  const stopPrompt = live
    ? 'In the shell, run `sleep 150` first. After the command finishes, write one haiku about rain and reply with the haiku only.'
    : 'Write one haiku about rain. Reply with the haiku only.';
  const job2 = await op('friend', 'jobs.submit', {circle, prompt: stopPrompt,
    harness: CLAUDE, model: HAIKU, noSource: true, result: {kind: 'message'}, title: 'Ship S6 job 2'}, {write: true, confirm: true});
  const d2 = job2.jobDigest;
  note('job 2 sent');
  const running2 = await waitUntil('job 2 running on the owner', async () => {
    if (HAND_APPROVE) await watchApprovals();
    const j = await op('owner', 'jobs.get', {digest: d2, circle}).catch(() => null);
    const a = attemptOf(j);
    if (a?.attempt_id && a?.execution_started_at) activeAttempt = {attemptId: a.attempt_id};
    await monitorCapDuringExecution('job 2', d2);
    return a?.state === 'active' && a?.execution_started_at ? {job: j, attempt: a} : null;
  }, 120000);
  const attemptId = running2.attempt.attempt_id;
  const stopIdentity = readPreparedStopIdentity(dirs.owner.faravan, running2.attempt);
  const runsBeforeStop = (await ipc('state'))?.runs ?? null;
  const chromium = await uiChromium();
  const stopBrowser = await chromium.launch({headless: true});
  let stopAnswer;
  try {
    const page = await stopBrowser.newPage();
    const url = new URL((await freshLink(procs.owner.origin, procs.owner.token))); url.hash = '#/lend';
    await page.goto(url.toString());
    const stopButton = page.getByRole('button', {name: /^Stop .* job…$/});
    await stopButton.waitFor({state: 'visible', timeout: 30000}).catch(async error => {
      const shown = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 2000);
      const now = await op('owner', 'jobs.get', {digest: d2, circle}).catch(e => ({error: e.message}));
      throw new Error(`owner Lend page never offered Stop for job 2: ${error.message.split('\n')[0]} Attempt: ${JSON.stringify({state: attemptOf(now)?.state ?? null, job: stateOf(now)})} Page: ${shown}`);
    });
    const current = await op('owner', 'jobs.get', {digest: d2, circle});
    if (attemptOf(current)?.attempt_id !== attemptId || attemptOf(current)?.state !== 'active')
      throw new Error('job 2 current attempt was not executing when the owner opened Stop');
    await stopButton.click();
    await page.getByRole('dialog', {name: 'Stop this job?'}).getByRole('button', {name: 'Stop job', exact: true}).click();
    stopAnswer = {clicked: true, attemptId};
  } finally {
    await stopBrowser.close();
  }
  note('owner Stop sent for job 2');
  const done2 = await waitUntil('job 2 terminal on the friend', async () => {
    const j = await op('friend', 'jobs.get', {digest: d2, circle});
    return ACTIVE.has(stateOf(j)) ? null : j;
  }, 180000);
  activeAttempt = null;
  const transcript2 = await op('friend', 'jobs.transcript', {digest: d2, circle}).catch(e => ({error: e.message}));
  const transcriptHasStopCopy = JSON.stringify(transcript2).includes('Stopped by the lender');
  const ownerDone2 = await op('owner', 'jobs.get', {digest: d2, circle});
  // Settle, then read the app's state and the owner's processes. Both modes run the same reads.
  await new Promise(r => setTimeout(r, SETTLE_MS));
  const stateAfterStop = await ipc('state');
  await ipc('release'); // releases a run that is still held, if any
  const lendingAfterStop = await readLedger();
  const originalStopAttempt = await procs.owner.control('stop-attempt',
    {circle,digest:d2,attemptId,generation:running2.attempt.generation}).catch(()=>null);
  const physicalRemoval = judgeRecordedStopRemoval(dirs.owner.faravan, stopIdentity, originalStopAttempt);
  const job2Pace = readPace50Attempt(dirs.owner.faravan, d2);
  const scan2 = await scanOwner();
  const appProof2 = job2Pace.attempt?.process_state === 'ceased' && job2Pace.attempt?.cessation_proven === true;
  const nothingRunning = judgeNothingRunning({attemptState: attemptOf(ownerDone2)?.state, lendingCurrent: lendingAfterStop.current,
    attemptId, appProof: appProof2, scan: scan2, runsUnchanged: runsBeforeStop !== null && runsBeforeStop === stateAfterStop?.runs, live});
  const receiptOrReason = digest => op('owner', 'jobs.receipt', {digest, circle}).catch(e => ({error: e.message.replace(/"error_id":"[^"]*",?/, '')}));
  const receipt2 = await receiptOrReason(d2);
  const stoppedReceiptUnavailable = typeof receipt2.error === 'string' && /"code"\s*:\s*"result_unavailable"/.test(receipt2.error);
  const charge2 = await chargeOf(receipt2, summary.meter.afterJob1);
  const gate2 = pointsGate('job 2', d2);
  const ownerStop2 = judgeOwnerStop({live, ownerAttemptState: attemptOf(ownerDone2)?.state ?? null, attemptId,
    ownerStop: job2Pace.attempt?.owner_stop ?? null, meterRuns: charge2.runs, receiptError: receipt2.error,
    receiptUnavailable: stoppedReceiptUnavailable, transcriptHasStopCopy, friendReasonCode: done2?.jobProjection?.reasonCode ?? null});
  summary.jobs.push({label: 'job2', digest: d2, attemptId, friendState: stateOf(done2), ownerAttemptState: attemptOf(ownerDone2)?.state ?? null,
    attemptsStarted: running2.job?.attempts_started ?? attemptOf(ownerDone2)?.attempts_started ?? null,
    stopAnswer: snip(stopAnswer).slice(0, 200), runsBeforeStop, runsAfterStop: stateAfterStop?.runs ?? null,
    originalStopAttempt, physicalRemoval,
    transcriptHasStopCopy, friendReasonCode: done2?.jobProjection?.reasonCode ?? null, charge: charge2, points: gate2, nothingRunning, ownerStop: ownerStop2, lendingCurrentAfterStop: lendingAfterStop.current ?? null,
    pace50AfterStop: {processState: job2Pace.attempt?.process_state ?? null, cessationProven: job2Pace.attempt?.cessation_proven ?? null,
      computeStopped: attemptOf(ownerDone2)?.compute_stopped ?? null, stoppedAt: attemptOf(ownerDone2)?.stopped_at ?? null},
    sbxScanPids: scan2.pids, sbxHome: OWNER_SBX_HOME, friendRaw: snip(done2), ownerRaw: snip(ownerDone2)});
  await enforceCap('job 2', gate2, charge2.usdValues);
  summary.ledger.afterJob2 = lendingAfterStop;
  summary.meter.afterJob2 = await readMeter();

  // -- 5. restart the owner's app on the same home; the same circle is hosted again on the same port.
  const beforeRestartJobs = [stateOf(await op('friend', 'jobs.get', {digest: d1, circle})), stateOf(await op('friend', 'jobs.get', {digest: d2, circle}))];
  const ledgerBeforeRestart = {jobs: await readJobs('owner'), spend: readSpendLedger([d1, d2])};
  stopPresence();
  await procs.owner.shutdown();
  if (processLog.find(p => p.role === 'owner' && p.stoppedAt)?.forcedKill)
    throw new Error('owner app required a forced kill to quit');
  await startApp('owner');
  startPresence();
  note('owner restarted on the same home');
  const statusAfter = await op('owner', 'status.get', {});
  summary.restart.statusAfter = {state: statusAfter.state ?? null, reason: statusAfter.reason ?? null, headline: statusAfter.headline ?? null};
  const hostingAfterRestart = await op('owner', 'hosting.get', {});
  summary.restart.hostingRunning = hostingAfterRestart.running ?? null;
  const hostingIdentityAfter = hostingAfterRestart.circle_id ?? hostingAfterRestart.circle?.id ?? null;
  const hostingPortAfter = hostingAfterRestart.local_port ?? hostingAfterRestart.port ?? null;
  summary.restart.hostingSameIdentityPort = hostingIdentityAfter === hostedId && hostingPortAfter === hostPort;
  if (hostingAfterRestart.running !== true || !summary.restart.hostingSameIdentityPort)
    throw new Error(`hosting did not resume on restart without help: ${JSON.stringify({hostedId, hostPort, hostingAfterRestart})}`);
  const agentsAfterRestart = await op('owner', 'agents.list', {});
  const restartModelPersisted = agentModelMatches(agentsAfterRestart, CLAUDE, HAIKU);
  if (!restartModelPersisted) throw new Error(`Claude model did not persist after restart: ${JSON.stringify(agentsAfterRestart.find(agent => agent.id === CLAUDE)?.run ?? null)}`);
  summary.ui.lending.model = agentsAfterRestart.find(agent => agent.id === CLAUDE).run.model;
  summary.restart.ledgerAfter = {jobs: await readJobs('owner'), spend: readSpendLedger([d1, d2])};
  summary.restart.lendingAfter = await readLedger();
  summary.restart.ownerRunsSinceRestart = (await ipc('state'))?.runs ?? null;
  await new Promise(r => setTimeout(r, 4000)); // a resumed job would start within this window
  const jobsAfter = [await op('friend', 'jobs.get', {digest: d1, circle}), await op('friend', 'jobs.get', {digest: d2, circle})];
  summary.restart.friendResultAfterRestart = await readFriendResultFromUi(d1, circle);
  summary.restart.jobsAfter = jobsAfter.map(j => ({state: stateOf(j), attemptsStarted: j.attempts_started ?? attemptOf(j)?.attempts_started ?? null}));
  summary.restart.ownerRunsAfterWait = (await ipc('state'))?.runs ?? null;
  summary.restart.beforeRestartJobs = beforeRestartJobs;
  summary.meter.afterRestart = await readMeter();

  // -- 6. judge. Each check is a fact read from the apps; see README.md for what each one means.
  const ledgerUnchanged = compareSpendLedger(ledgerBeforeRestart, summary.restart.ledgerAfter);
  const ledgerHasBothJobs = [d1, d2].every(d => summary.restart.ledgerAfter.jobs.some(j => j.digest === d));
  const j2 = summary.jobs[1], job1s = summary.jobs[0];
  const finalAgentReadback = await op('owner', 'agents.list', {});
  const finalModelPersisted = agentModelMatches(finalAgentReadback, CLAUDE, HAIKU);
  if (!finalModelPersisted) throw new Error(`Claude model changed before the final journey check: ${JSON.stringify(finalAgentReadback.find(agent => agent.id === CLAUDE)?.run ?? null)}`);
  summary.ui.lending.model = finalAgentReadback.find(agent => agent.id === CLAUDE).run.model;
  const pointsMissing = summary.jobs.flatMap(j => j.points.missing.map(m => `${j.label}: ${m}`));
  const everyCharge = pointsMissing.length ? null : summary.jobs.every(j => j.points.breaches.length === 0 && j.charge.usdValues.every(v => v <= JOB_CAP_USD))
    && totalUsd <= TOTAL_CAP_USD;
  if (pointsMissing.length) summary.missing.everyChargeWithinCap = pointsMissing;
  if (j2.nothingRunning.missing.length) summary.missing.nothingRunningAfterStop = j2.nothingRunning.missing;
  summary.checks = {
    ...summary.checks,
    lendingSettingsThroughUi: summary.checks.lendingSettingsThroughUi === true && restartModelPersisted && finalModelPersisted,
    admissionModeConfigured: summary.admissionMode === 'approve' ? [d1, d2].every(digest => approvalsUiFor.has(digest))
      : summary.ui.lendingReadback?.enabled === true && summary.ui.lendingReadback?.mode === 'auto',
    ownerProfile: summary.profiles.owner?.homeMatches === true && summary.profiles.owner?.xdgInsideFaravanData.length === 0 && summary.profiles.owner?.installedRuntimeMatches === true,
    friendProfile: summary.profiles.friend?.homeMatches === true && summary.profiles.friend?.xdgInsideFaravanData.length === 0 && summary.profiles.friend?.installedRuntimeMatches === true,
    job1AutoAdmittedNoApprovalClick: HAND_APPROVE ? null : job1s.autoAdmitted === true && job1s.attemptsStarted === 1,
    job1HandApprovedOnce: HAND_APPROVE ? job1s.approvalsSeen.includes(job1s.digest) && approvalsUiFor.has(job1s.digest) && job1s.attemptsStarted === 1 : null,
    job1CompletedAndResultReachedFriend: job1s.friendState === 'result-accepted' && Boolean(job1s.resultOnFriendUi?.message),
    friendCanReopenResultAfterRestart: summary.restart.friendResultAfterRestart?.digest === job1s.digest && Boolean(summary.restart.friendResultAfterRestart?.message),
    // The owner's Stop ended the run by a whole graceful or hard path (evidence.mjs judgeOwnerStop).
    ownerStopHonored: j2.ownerStop.pass === true,
    // The transcript carries the stop line only when partial work came back; a job stopped before any output has none,
    // and the friend learns of the stop from the job's reason instead.
    friendToldStopped: j2.transcriptHasStopCopy === true || j2.friendReasonCode === 'stopped_by_lender',
    nothingRunningAfterStop: j2.nothingRunning.pass === true,
    lendingOffAfterStop: summary.ledger.afterJob2?.enabled === false,
    restartHealthy: summary.restart.statusAfter.state !== null && !FAULT_STATES.test(String(summary.restart.statusAfter.state)) && summary.restart.hostingRunning === true && summary.restart.hostingSameIdentityPort === true,
    ledgerIntact: ledgerUnchanged && ledgerHasBothJobs,
    noJobResumedOrDoubleCounted: summary.restart.jobsAfter.every((j, i) => j.state === beforeRestartJobs[i] && j.attemptsStarted === 1)
      && (live || summary.restart.ownerRunsAfterWait === 0),
    everyChargeWithinCap: everyCharge === true && (live || summary.jobs.every(j => j.charge.complete === true)),
  };
  // Information only. Not part of `pass`. The app's graceful owner Stop ends the attempt completed with a partial result.
  summary.info = {job2EndsStopped: j2.friendState === 'stopped', job2FriendState: j2.friendState, job2OwnerAttemptState: j2.ownerAttemptState,
    job2NothingRunningSource: j2.nothingRunning.source, job2NothingRunningDisagreement: j2.nothingRunning.disagreement ?? null,
    usdChargesSource: summary.jobs.map(j => j.charge.source)};
  summary.totalChargedUsd = live ? null : Number(totalUsd.toFixed(6));
  for (const k of Object.keys(summary.checks)) if (summary.checks[k] === null && /AutoAdmitted|HandApproved/.test(k)) delete summary.checks[k];
  summary.admissionMode = HAND_APPROVE ? 'approve' : 'automatic';
  summary.info.admission = HAND_APPROVE ? 'owner approved each job in its UI' : 'automatic';
  summary.info.approvalsUiFor = [...approvalsUiFor];
  summary.pass = Object.keys(summary.checks).length > 0 && Object.values(summary.checks).every(v => v === true);
  recordProviderDeltas();
  if (Object.keys(summary.missing).length) for (const [check, fields] of Object.entries(summary.missing)) log('missing for', check + ':', fields.join('; '));
} catch (error) {
  exitCode = 1;
  summary.error = error.message;
  summary.pass = false;
  summary.totalChargedUsd = live ? null : Number(totalUsd.toFixed(6));
  recordProviderDeltas();
  log('FAILED:', error.stack ?? error.message);
  // What each app said at the failure, so a failed run explains itself without another run.
  const dump = async (role, id, input) => { try { return await withTimeout(op(role, id, input), 10000, id); } catch (e) { return {error: e.message}; } };
  if (procs.owner && summary.circle) summary.failureState = {ownerLending: await dump('owner', 'lending.get', {}),
    ownerJobs: await dump('owner', 'jobs.list', {circle: summary.circle}), friendJobs: await dump('friend', 'jobs.list', {circle: summary.circle})};
} finally {
  stopPresence();
  for (const role of Object.keys(procs)) {
    try { await procs[role].shutdown(); } catch (error) { log('shutdown', role, error.message); }
  }
  const now = new Date().toISOString();
  for (const rec of processLog) if (!rec.stoppedAt) rec.stoppedAt = now;
  summary.finishedAt = now;
  fs.writeFileSync(join(RUN, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(summary));
  process.exit(summary.pass ? 0 : (exitCode || 1));
}
