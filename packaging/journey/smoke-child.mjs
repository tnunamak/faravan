// One Faravan app process for the ship smoke (S6), under the installed user's normal HOME-based data-home resolution.
//
// Usage: node smoke-child.mjs '<json config>'   config: {src, role, lender, live, costUsd, tokens, model}
//
// Synthetic (live=false): the app starts through the repo's own fixture (tests/helpers/v1-app-fixture.mjs), with its
// synthetic run backend and the synthetic pace-50 meter (same wiring as tests/helpers/pace50-app-sandbox.mjs).
// Live (live=true): startApp() with the product defaults. No test doubles are installed.
//
// IPC carries only what HTTP cannot: hold/release of a synthetic run, its counters and meter, job reads for
// verification, and a clean shutdown. Every product action goes over HTTP from smoke.mjs.
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import fs from 'node:fs';
import {readOriginalStopAttempt} from './evidence.mjs';

const cfg = JSON.parse(process.argv[2]);
const helpers = pathToFileURL(cfg.src + '/tests/helpers/').href;
const libs = pathToFileURL(cfg.src + '/lib/').href;
const installedLib = pathToFileURL(cfg.installRoot + '/').href;
const HOME = join(process.env.HOME, '.faravan');
const HAIKU = 'claude-haiku-5-5';
const isLender = cfg.role === cfg.lender;

const cleanups = [];
const cleanupAll = async () => { for (const fn of cleanups.reverse()) await fn(); };
const {resolveHarness} = await import(libs + 'executor.mjs');
const claudeAdapter = () => [{spec: cfg.localLend ? {...resolveHarness('claude-code-subscription'), auth_strategy: 'docker-native-oauth', credential_in_guest: false} : resolveHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: [HAIKU], capabilities: []}, ...(cfg.localLend ? [{spec: {...resolveHarness('codex'), auth_strategy: 'docker-native-oauth', credential_in_guest: false}, installed: true, signedIn: true, harnessVersion: 'synthetic-only', models: ['gpt-6-luna'], capabilities: []}] : [])];

let app, backend = null, source = null, holdOptions = null;
const meterRuns = [];

if (cfg.live) {
  const {startApp} = await import(installedLib + 'lib/v1/app.mjs');
  const {DockerSbxBackend} = await import(installedLib + 'lib/docker-backend.mjs');
  app = await startApp({home: HOME, port: 0, ...(cfg.localLend ? {
    backendFactory: options => new DockerSbxBackend({...options,autoRepair:false,scratchJournal:join(HOME,'v1','scratch-journal')}),
  } : {})});
  cleanups.push(() => app.close());
} else {
  const {appFixture, syntheticBackend} = await import(helpers + 'v1-app-fixture.mjs');
  const {startApp} = await import(installedLib + 'lib/v1/app.mjs');
  const fixture = await appFixture({after: fn => cleanups.push(fn)}, {startApp});
  // The fixture's default fetch refuses non-loopback hosts (boundedFetch). Hosting puts the circle on the LAN address,
  // so the app gets the plain fetch here; every other behaviour of the fixture's app wiring stays as is.
  const common = {home: HOME, pollMs: 250, approvalPollMs: 1500, adapters: claudeAdapter(), fetch: (url, init) => globalThis.fetch(url, init),
    identityProbe: async ({harnessNames}) => ({providers: harnessNames.map(harness_id => ({harness_id, installed: true, signedIn: true}))})};
  if (isLender) {
    const {createSyntheticPace50Source} = await import(helpers + 'pace50-synthetic-source.mjs');
    const installedState = cfg.localLend ? {account: 'synthetic-account', account_week_id: 'synthetic-week-1'} : JSON.parse(fs.readFileSync(join(HOME, 'v1', 'lending-pace50-state.json'), 'utf8'));
    const account = installedState.account, accountWeek = installedState.account_week_id;
    const {parseGuardLine} = await import(libs + 'faravan-guard-host.mjs');
    holdOptions = {hold: false, change: {path: 'answer.txt', bytes: 'the smoke change\n'}, liveMessage: 'smoke agent is working',
      finalMessage: 'Grey waves fold to foam,\nsalt wind carries gull voices,\nthe tide keeps its time.', captureStream: true};
    // The backend reads this same object, so the hold and release IPC below reach the running job.
    backend = syntheticBackend(fixture.root, holdOptions);
    // A message job returns only faravan-output/, as lib/executor.mjs packs it; the fixture's default archive has a
    // root-level file, which the friend's app correctly rejects as outside the output folder.
    const {resultArchive} = await import(helpers + 'v1-journey.mjs');
    // The pack command runs on a copy of the run handle (execViaBackend), so the run is keyed by its scratch folder.
    const innerCollect = backend.collectDeclaredOutputs.bind(backend), typedOutputRuns = new Set();
    backend.collectDeclaredOutputs = async (handle, manifest) => typedOutputRuns.has(handle.scratch_dir)
      ? [{path: '.wf-result/result.tar.gz', bytes_content: resultArchive('the smoke change\n', 'faravan-output/answer.txt')}]
      : innerCollect(handle, manifest);
    source = createSyntheticPace50Source({account, accountWeek, start: Date.now()});
    backend.meters = [];
    // Graceful owner Stop: release the held run, as the synthetic fixture's own requestStop does.
    backend.requestStop = async handle => {
      // The guard reports an owner stop as the run's stop reason; the synthetic run does the same.
      if (handle) handle._ownerStop = true;
      handle?._release?.();
      return {delivered: true, fallback: null, reason: 'owner'};
    };
    const innerStart = backend.start.bind(backend);
    // Same metering as tests/helpers/pace50-app-sandbox.mjs: one faravan.meter line through the host parser, then the
    // provider counter moves by the metered cost, so the next reading shows the spend.
    backend.start = async (handle, opts = {}) => {
      if (/^mkdir -p \.wf-result .*tar czf \.wf-result\/result\.tar\.gz -C .*faravan-output/.test(handle._entrypoint)) typedOutputRuns.add(handle.scratch_dir);
      await innerStart(handle, opts);
      if (!opts.lendingBudget) return undefined;
      const costUsd = Math.min(cfg.costUsd, opts.lendingBudget.budget.limit);
      const provider = handle._entrypoint.includes('codex exec') ? 'codex' : 'claude';
      const line = JSON.stringify({type: 'faravan.meter', v: 1, seq: 1, at: new Date().toISOString(), source: provider === 'codex' ? 'codex-rollout' : 'claude-stream',
        model: provider === 'codex' ? 'gpt-6-luna' : HAIKU, tokens: cfg.tokens, windows: [], cost_usd: costUsd, final: true});
      const reading = parseGuardLine(line);
      if (!reading) throw new Error('the synthetic sandbox wrote a meter line the host would reject');
      opts.onMeter?.(reading);
      const {resources} = await source.observe({provider, now: Date.now()});
      for (const {id, amount_micro} of source.convertUsage({units_micro: Math.round(costUsd * 1000000), resources})) {
        if (id === 'seven_day') source.state.used.weekly += amount_micro;
        if (id === 'five_hour') source.state.used.short += amount_micro;
      }
      backend.meters.push(reading);
      meterRuns.push({cost_usd: costUsd, budget_limit: opts.lendingBudget.budget.limit, stop: handle._ownerStop ? 'owner' : null});
      // The real backend contract (lib/docker-backend.mjs start): {stop: StopRecord|null, meter}. The executor reads
      // stop.stop_reason (lib/executor.mjs 406), and lender.mjs 754 writes the "Stopped by the lender" copy for 'owner'.
      return {stop: handle._ownerStop ? {schema: 'faravan.stop.v1', stop_reason: 'owner'} : null, meter: reading};
    };
    ({app} = await fixture.start(cfg.role, {...common, home: HOME, backend, lendingPace50: {source, account, account_week_id: accountWeek}}));
  } else {
    backend = syntheticBackend(fixture.root);
    ({app} = await fixture.start(cfg.role, {...common, home: HOME, backend}));
  }
}

const reportedPaths = Object.fromEntries(['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));

process.on('message', async ({id, command, payload}) => {
  try {
    let value;
    if (command === 'hold' || command === 'release') {
      if (!holdOptions) throw new Error('no synthetic run backend in this process');
      if (command === 'hold') holdOptions.hold = true;
      else { holdOptions.hold = false; backend.release(); }
    }
    else if (command === 'state') {
      value = backend
        ? {runs: backend.calls.filter(([kind]) => kind === 'run').length,
           cancels: backend.calls.filter(([kind]) => kind === 'cancel').length,
           stopRequests: backend.calls.filter(([kind]) => kind === 'requestStop').length,
           meters: backend.meters.length, held: holdOptions.hold}
        : null;
    }
    else if (command === 'meter') value = source ? {weekly: source.state.used.weekly, short: source.state.used.short, runs: meterRuns} : null;
    else if (command === 'job-state') value = await (await app.device.client(payload.circle)).getJob(payload.digest);
    else if (command === 'stop-attempt') value = await readOriginalStopAttempt(app.device,payload);
    else if (command === 'shutdown') {
      if (backend) backend.release();
      await cleanupAll();
      process.send({id, value: {closed: true}}, () => process.exit(0));
      return;
    }
    else throw new Error('Unknown smoke control: ' + command);
    process.send({id, value});
  } catch (error) {
    process.send({id, error: error.stack ?? String(error)});
  }
});

process.send({ready: {origin: app.origin, token: app.token, pid: process.pid, reportedPaths,
  installedAppModule: new URL(installedLib + 'lib/v1/app.mjs').pathname}});
