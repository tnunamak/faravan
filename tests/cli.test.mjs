import './helpers/no-browser.mjs';
import './helpers/short-sbx-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, chmod } from 'node:fs/promises';
import {setResidentQuit} from '../lib/v1/resident-intent.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), 'bin', 'faravan');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withMemberHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fed-cli-member-'));
  try {
    await fn(dir);
  } finally {
    const residents=await readdir(join(dir,'v1','resident.lock.owners-v1')).catch(()=>[]);
    if(residents.length)await stopApp(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(args, { home, cwd = process.cwd(), env = {} } = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env, HOME: home, FARAVAN_HOME: home },
  });
}

async function stopApp(home) {
  setResidentQuit(true,home);
  let info;
  try { info = JSON.parse(await readFile(join(home, 'v1', 'app.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { if(info)process.kill(info.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 100; attempt++) {
    const app=await readFile(join(home,'v1','app.json')).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    const owners=await readdir(join(home,'v1','resident.lock.owners-v1')).catch(error=>{if(error.code!=='ENOENT')throw error;return [];});
    if(!app&&!owners.length)return;
    await sleep(50);
  }
  throw new Error('timed out waiting for the v1 app to close');
}

async function safeProbeCommands(home, {holdFile = null, cancelledFile = null, callsFile = null, pidFile = null} = {}) {
  const bin = join(home, 'test-probe-bin');
  await mkdir(bin, {recursive:true});
  const sbx = join(bin, 'sbx');
  const docker = join(bin, 'docker');
  await writeFile(sbx, '#!/bin/sh\nexit 1\n', {mode:0o700});
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const holdFile = ${JSON.stringify(holdFile)};
const cancelledFile = ${JSON.stringify(cancelledFile)};
const callsFile = ${JSON.stringify(callsFile)};
const pidFile = ${JSON.stringify(pidFile)};
if (callsFile) fs.appendFileSync(callsFile, process.argv.slice(2).join(' ')+'\\n');
if (process.argv.includes('version') && holdFile && fs.existsSync(holdFile)) {
  process.on('SIGTERM', () => {
    fs.writeFileSync(cancelledFile, 'cancelled');
    process.exit(0);
  });
  if(pidFile)fs.writeFileSync(pidFile,String(process.pid));
  fs.unlinkSync(holdFile);
  setTimeout(() => process.exit(0), 8000);
} else process.exit(1);
`, {mode:0o700});
  await chmod(sbx, 0o700);
  await chmod(docker, 0o700);
  return {FARAVAN_SBX_BIN:sbx, PATH:`${bin}:${process.env.PATH}`};
}

async function runResidentStartUnderProfileLock(home, { releaseOnWait }) {
  const {acquireProcessLockSync,profileWriterLockPath} = await import('../lib/v1/lock.mjs');
  await mkdir(join(home, 'v1'), {recursive: true});
  const release = acquireProcessLockSync(profileWriterLockPath(home), {durable: false});
  let released = false;
  const unlock = () => { if (!released) { released = true; release(); } };
  const moduleUrl = new URL('../lib/v1/resident-intent.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import {setResidentQuit} from ${JSON.stringify(moduleUrl)};
    const wait = Atomics.wait;
    let announced = false;
    Atomics.wait = (...args) => {
      if (!announced) { announced = true; fs.writeSync(1, 'waiting\\n'); }
      return wait(...args);
    };
    try { setResidentQuit(false, process.argv[1]); fs.writeSync(1, 'started\\n'); }
    catch (error) { fs.writeSync(1, error.code + '\\n'); process.exitCode = 1; }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, home], {
    env: { ...process.env, HOME: home, FARAVAN_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (releaseOnWait && stdout.includes('waiting\n')) unlock();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    unlock();
  }
}

test('resident start waits for a brief profile write, then persists its intent', async () => {
  await withMemberHome(async home => {
    const result = await runResidentStartUnderProfileLock(home, {releaseOnWait: true});
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'waiting\nstarted\n');
    const record = JSON.parse(await readFile(join(home, 'v1', 'resident-intent.json'), 'utf8'));
    assert.equal(record.quit, false);
  });
});

test('resident start does not clear Quit while the profile writer stays locked', async () => {
  await withMemberHome(async home => {
    setResidentQuit(true, home);
    const result = await runResidentStartUnderProfileLock(home, {releaseOnWait: false});
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, 'waiting\ndevice_busy\n');
    const record = JSON.parse(await readFile(join(home, 'v1', 'resident-intent.json'), 'utf8'));
    assert.equal(record.quit, true);
  });
});

test('no-argument Faravan starts and reuses the local v1 app without opening a browser', { timeout: 20000 }, async () => {
  await withMemberHome(async (home) => {
    // Keep every home and any optional configured queue out of the user's state.
    const env = { FARAVAN_NO_BROWSER: '1', FARAVAN_COORDINATOR_HOME: join(home, 'coordinator'),
      ...await safeProbeCommands(home) };
    env.FARAVAN_V1_ORIGIN = undefined;
    try {
      const [first, concurrent] = await Promise.all([
        runCli([], { home, env }), runCli([], { home, env }),
      ]);
      assert.equal(concurrent.stdout, first.stdout);
      // Output names the origin and what to do next: the session token is never printed.
      assert.match(first.stdout, /^Open Faravan: http:\/\/127\.0\.0\.1:\d+\nIf the page asks you to reconnect, run faravan app open-link\.\n$/);
      const info = JSON.parse(await readFile(join(home, 'v1', 'app.json'), 'utf8'));
      const url = new URL(first.stdout.match(/^Open Faravan: (\S+)/)[1]);
      assert.equal(Number(url.port), info.port);
      assert.equal(first.stdout.includes(info.token), false);
      const response = await fetch(url.origin + '/api/lending', {
        headers: { 'x-faravan-session-token': info.token },
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).enabled, false);
      const second = await runCli([], { home, env });
      assert.equal(second.stdout, first.stdout);
      assert.deepEqual(JSON.parse(await readFile(join(home, 'v1', 'app.json'), 'utf8')), info);
      await assert.rejects(readFile(join(home, 'daemon.json')), { code: 'ENOENT' });
      const attempts = await readFile(process.env.FARAVAN_TEST_BROWSER_LOG, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      assert.equal(attempts, '');
    } finally { await stopApp(home); }
  });
});

test('no-argument Faravan waits for slow discovery and requests a handoff', { timeout: 30000 }, async t => {
  await withMemberHome(async home => {
    const {processLockOwners} = await import('../lib/v1/lock.mjs');
    const preload = join(home, 'hold-discovery.cjs');
    const discovery = join(home, 'v1', 'app.json');
    const handoff = join(home, 'handoff-status');
    const releaseAt = Date.now() + 7000;
    // Hold only the final discovery rename. The real App owns its lock and answers
    // authenticated requests as soon as the usual discovery file becomes visible.
    await writeFile(preload, `
      const fs = require('node:fs');
      if (process.argv[2] === 'app') {
        const rename = fs.promises.rename;
        fs.promises.rename = async (source, destination) => {
          if (destination === ${JSON.stringify(discovery)})
            await new Promise(resolve => setTimeout(resolve, Math.max(0, ${releaseAt} - Date.now())));
          return rename(source, destination);
        };
      } else if (process.argv.length === 2) {
        const fetch = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
          const response = await fetch(url, options);
          if (new URL(url).pathname === '/api/handoff')
            fs.appendFileSync(${JSON.stringify(handoff)}, response.status + '\\n');
          return response;
        };
      }
    `);
    const env = {
      FARAVAN_NO_BROWSER: '1', FARAVAN_COORDINATOR_HOME: join(home, 'coordinator'),
      NODE_OPTIONS: '--require=' + JSON.stringify(preload), ...await safeProbeCommands(home),
    };
    const started = performance.now();
    const outcome = await runCli([], {home, env}).catch(error => ({stderr:error.stderr}));
    const cliMs = Math.round(performance.now()-started);
    let record;
    for (let attempts = 0; attempts < 150 && !record; attempts++) {
      const bytes = await readFile(discovery, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (bytes) record = JSON.parse(bytes);
      else await sleep(50);
    }
    assert.ok(record, 'the slow app eventually publishes discovery');
    const response = await fetch('http://127.0.0.1:' + record.port + '/api/lending', {
      headers: { 'x-faravan-session-token': record.token }, signal: AbortSignal.timeout(2000),
    });
    await response.arrayBuffer();
    const ownerCount = processLockOwners(join(home, 'v1', 'app.lock')).length;
    const handoffStatus = await readFile(handoff, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    t.diagnostic(JSON.stringify({cliMs, authenticatedStatus:response.status, ownerCount, handoffStatus:handoffStatus.trim(),
      startupRefused:/could not start the v1 app/.test(outcome.stderr)}));
    assert.equal(response.status, 200);
    assert.equal(ownerCount, 1);
    assert.equal(outcome.stderr, '', outcome.stderr);
    assert.match(outcome.stdout, /^Open Faravan: http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(handoffStatus, '200\n');
    assert.equal(outcome.stdout.includes(record.token), false);
  });
});

test('no-argument Faravan reports v0 state once and preserves it unchanged', { timeout: 20000 }, async () => {
  await withMemberHome(async (home) => {
    const oldConfig = '{"coordinator_url":"http://127.0.0.1:1","collective_token":"dead-token","key_id":"tessa-author"}\n';
    await writeFile(join(home, 'config.json'), oldConfig);
    await mkdir(join(home, 'coordinator'), { recursive: true });
    const oldHost = '{"protocol_version":0,"data_dir":"old-jobs"}\n';
    await writeFile(join(home, 'coordinator', 'host.json'), oldHost);
    try {
      const { stdout } = await runCli([], { home, env: {
        FARAVAN_NO_BROWSER: '1', FARAVAN_V1_ORIGIN: undefined, FARAVAN_COORDINATOR_HOME: join(home, 'coordinator'),
        ...await safeProbeCommands(home),
      } });
      const lines = stdout.trim().split('\n');
      assert.equal(lines.length, 3);
      assert.equal(lines[0], 'Found v0 state; it is preserved and is not used by this app. See docs/protocol/hosting.md for retirement steps.');
      assert.match(lines[1], /^Open Faravan: http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(lines[2], 'If the page asks you to reconnect, run faravan app open-link.');
      assert.equal(await readFile(join(home, 'config.json'), 'utf8'), oldConfig);
      assert.equal(await readFile(join(home, 'coordinator', 'host.json'), 'utf8'), oldHost);
      await assert.rejects(readFile(join(home, 'daemon.json')), { code: 'ENOENT' });
    } finally { await stopApp(home); }
  });
});

test('detached app shutdown cancels a pending read-only sandbox preflight for SIGTERM and SIGINT', {timeout:20000}, async () => {
  for (const signal of ['SIGTERM','SIGINT']) await withMemberHome(async home => {
    const holdFile=join(home,'hold-next-docker-version');
    const cancelledFile=join(home,'docker-version-cancelled'),pidFile=join(home,'docker-version.pid');
    const callsFile=join(home,'docker-command-calls');
    const env={FARAVAN_NO_BROWSER:'1',FARAVAN_COORDINATOR_HOME:join(home,'coordinator'),
      ...await safeProbeCommands(home,{holdFile,cancelledFile,callsFile,pidFile})};
    await writeFile(holdFile,'hold');
    const {stdout}=await runCli([],{home,env});
    const info=JSON.parse(await readFile(join(home,'v1','app.json'),'utf8'));
    // Startup returns while readiness is in the background. Hold its read-only command until shutdown.
    for(let attempt=0;attempt<100;attempt++){
      try{await readFile(holdFile);await sleep(10);}catch(error){if(error.code==='ENOENT')break;throw error;}
      if(attempt===99){
        const calls=await readFile(callsFile,'utf8').catch(()=>'<none>');
        throw new Error(`timed out waiting for held startup preflight; docker calls=${JSON.stringify(calls)}`);
      }
    }
    const probePid=Number(await readFile(pidFile,'utf8'));
    assert.ok(Number.isSafeInteger(probePid)&&probePid>0);
    assert.doesNotThrow(()=>process.kill(probePid,0),'the owned preflight is still running');
    const pendingFetch=fetch(new URL('/api/lending',stdout.match(/^Open Faravan: (\S+)/)[1]).origin+'/api/lending',{
      headers:{'x-faravan-session-token':info.token},signal:AbortSignal.timeout(10000)});
    const fetchOutcome=pendingFetch.then(response=>({status:response.status}),error=>({error:error.message}));
    try{process.kill(info.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}
    for(let attempt=0;attempt<100;attempt++){
      try{await readFile(join(home,'v1','app.json'));await sleep(50);}
      catch(error){if(error.code==='ENOENT')break;throw error;}
      if(attempt===99)throw new Error('timed out waiting for the v1 app to close');
    }
    await pendingFetch.catch(()=>{});
    assert.throws(()=>process.kill(probePid,0),{code:'ESRCH'},'shutdown reaped the cancelled preflight');
    assert.equal(await readFile(cancelledFile,'utf8'),'cancelled','the preflight got SIGTERM before any kill');
    await assert.rejects(readFile(join(home,'v1','app.json')),{code:'ENOENT'});
  });
});

test('SIGTERM during app startup closes the app once startup returns, while an unsignaled start stays open', { timeout: 10000 }, async () => {
  await withMemberHome(async (home) => {
    const moduleUrl = new URL('../lib/v1/cli.mjs', import.meta.url).href;
    const runCase = async (signalDuringStartup) => {
      const entered = join(home, signalDuringStartup ? 'signal-entered' : 'control-entered');
      const closed = join(home, signalDuringStartup ? 'signal-closed' : 'control-closed');
      const childCode = `
        import { writeFile } from 'node:fs/promises';
        const { runV1Command } = await import(${JSON.stringify(moduleUrl)});
        const startApp = async () => {
          await writeFile(${JSON.stringify(entered)}, 'entered');
          await new Promise(resolve => setTimeout(resolve, 200));
          return { origin: 'http://127.0.0.1:1234', url: 'http://127.0.0.1:1234/', handoffUrl: () => '',
            close: async () => writeFile(${JSON.stringify(closed)}, 'closed') };
        };
        process.exitCode = await runV1Command(['app'], { startApp, env: { FARAVAN_NO_BROWSER: '1' } });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
        env: { ...process.env, HOME: home, FARAVAN_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exited = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('controlled app child did not exit')), 3000);
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          try { await readFile(entered); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(10); }
        }
        await readFile(entered);
        if (signalDuringStartup) child.kill('SIGTERM');
        const result = await exited;
        assert.equal(result.code, 0, output);
        assert.equal(result.signal, null);
        assert.equal(await readFile(closed, 'utf8').then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), signalDuringStartup);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    };
    await runCase(true);
    await runCase(false);
  });
});

test('no-argument Faravan does not replace discovery belonging to a live unreachable process', async () => {
  await withMemberHome(async (home) => {
    await mkdir(join(home, 'v1'), { recursive: true });
    const record = JSON.stringify({ pid: process.pid, port: 1, token: 'synthetic-local-session' });
    await writeFile(join(home, 'v1', 'app.json'), record);
    await assert.rejects(runCli([], { home, env: {
      FARAVAN_NO_BROWSER: '1', FARAVAN_COORDINATOR_HOME: join(home, 'coordinator'),
    } }), error => {
      assert.match(error.stderr, /existing v1 app is not responding/);
      return true;
    });
    assert.equal(await readFile(join(home, 'v1', 'app.json'), 'utf8'), record);
    await assert.rejects(readFile(join(home, 'v1', 'app-settings.json')), { code: 'ENOENT' });
  });
});

test('v1 opener uses platform commands and honors no-browser without spawning', async () => {
  const { openCommand, openUrl } = await import('../lib/v1/open-url.mjs');
  const url = 'http://127.0.0.1:1234/auth/handoff?code=synthetic';
  assert.deepEqual(openCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(openCommand(url, 'win32'), ['cmd.exe', ['/c', 'start', '', url]]);
  assert.deepEqual(openCommand(url, 'linux'), ['xdg-open', [url]]);
  const calls = [];
  let unrefs = 0, errorHandler;
  const spawn = (...args) => {
    calls.push(args);
    return { on(event, handler) { assert.equal(event, 'error'); errorHandler = handler; }, unref() { unrefs++; } };
  };
  for (const value of ['1', 'true', 'disabled']) {
    openUrl(url, { spawn, env: { FARAVAN_NO_BROWSER: value } });
  }
  assert.equal(calls.length, 0);
  for (const value of [undefined, '', '0', 'false']) {
    openUrl(url, { platform: 'win32', spawn, env: { FARAVAN_NO_BROWSER: value } });
  }
  assert.equal(calls.length, 4);
  assert.equal(unrefs, 4);
  assert.deepEqual(calls[0], ['cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', env: { FARAVAN_NO_BROWSER: undefined } }]);
  assert.doesNotThrow(() => errorHandler(new Error('opener not installed')));
  assert.doesNotThrow(() => openUrl(url, { env: {}, spawn() { throw new Error('spawn unavailable'); } }));
});

test('status without v0 state is v1-aware and never says "not joined"', async () => {
  await withMemberHome(async (home) => {
    const human = await runCli(['status'], { home });
    assert.match(human.stdout, /This device:/);
    assert.match(human.stdout, /My devices/);
    assert.doesNotMatch(human.stdout + human.stderr, /not joined/i);
    const parsed = JSON.parse((await runCli(['status', '--json'], { home })).stdout);
    assert.equal(parsed.circles[0].name, 'My devices');
    assert.equal(parsed.lending.app_running, false);
  });
});

test('unknown commands fail with usage', async () => {
  await assert.rejects(runCli(['frobnicate']), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /unknown command "frobnicate"/);
    return true;
  });
});


test('retired commands and flags do not expose the preview runtime', async () => {
  const { stdout } = await runCli(['--help']);
  assert.doesNotMatch(stdout, /legacy|daemon|contribute/);
  for (const args of [['legacy', '--help'], ['contribute'], ['submit'], ['daemon'], ['host', '--v0']]) {
    await assert.rejects(runCli(args), error => {
      assert.match(error.stderr, /unknown command|usage: faravan host/);
      assert.doesNotMatch(error.stderr, /faravan legacy|FaravanConfigError|\bat async/);
      return true;
    });
  }
});

test('status uses v1 even when only preview state exists, without changing it', async () => {
  await withMemberHome(async home => {
    const oldConfig = '{"coordinator_url":"http://127.0.0.1:1","collective_token":"old"}';
    await writeFile(join(home, 'config.json'), oldConfig);
    const result = JSON.parse((await runCli(['status', '--json'], {home})).stdout);
    assert.equal(result.circles[0].name, 'My devices');
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), oldConfig);
  });
});

test('package manifests cover scoped runtime imports and required data', async () => {
  // Static and hermetic: never import runtime modules, start the app, download,
  // run Go/nFPM, or inspect authentication implementations.
  const { posix } = await import('node:path');
  const read = file => readFile(join(process.cwd(), file), 'utf8');
  const [build, stageApp, brew, nfpm] = await Promise.all([
    read('packaging/build.sh'), read('packaging/stage-app.sh'), read('packaging/brew/faravan.rb'), read('packaging/nfpm.yaml'),
  ]);
  assert.match(build, /"\$package_dir\/stage-app\.sh" "\$stage_dir\/usr\/lib\/faravan"/, 'build.sh stages the app through stage-app.sh');
  const shell = stageApp.replace(/\\\n/g, ' ').replace(/\|\n\s*/g, '| ');
  const rules = [...shell.matchAll(/find (?:"\$repo_root\/([^"]+)"|([\w/.-]+)) (.*?) -print0 \|[^\n]*?install[^\n]*?"\$dest\//g)]
    .map(([, quotedRoot, root, options]) => ({
      root: quotedRoot ?? root,
      pattern: /-name '([^']+)'/.exec(options)?.[1] ?? '*',
      shallow: /-maxdepth 1\b/.test(options),
    }));
  const glob = pattern => new RegExp('^' + pattern.split('*')
    .map(part => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('.*') + '$');
  const explicit = new Set([
    ...shell.matchAll(/"\$repo_root"?\/((?:profiles|coordinator)\/[^\s"]+)"?/g),
  ].map(match => match[1]));
  const linuxCovers = file => explicit.has(file) || rules.some(rule => {
    if (!file.startsWith(rule.root + '/')) return false;
    const relative = file.slice(rule.root.length + 1);
    return (!rule.shallow || !relative.includes('/')) && glob(rule.pattern).test(posix.basename(file));
  });
  const brewRoots = [...(brew.match(/^\s*libexec\.install (.*)$/m)?.[1] ?? '').matchAll(/"([^"]+)"/g)]
    .map(match => match[1]);
  const brewCovers = file => brewRoots.some(root => file.startsWith(root + '/'))
    || (file.startsWith('docs/protocol/') && file.endsWith('.schema.json')
      && brew.includes('(libexec/"docs/protocol").install Dir["docs/protocol/*.schema.json"]'))
    || ((file.startsWith('profiles/') || file.startsWith('coordinator/'))
      && brew.includes('"' + file + '"') && brew.includes('(libexec/"' + file.split('/')[0] + '").install'));

  assert.ok(rules.length >= 4, 'no Linux staging rules parsed');
  assert.match(nfpm, /src: \.\/stage\/usr\/lib\/faravan\s+dst: \/usr\/lib\/faravan\s+type: tree/);
  assert.match(build, /tar -C "\$stage_dir" -czf "[^"]+" usr etc/);
  const covered = file => {
    assert.ok(linuxCovers(file), 'Linux package omits ' + file);
    assert.ok(brewCovers(file), 'Brew package omits ' + file);
  };
  const audited = new Set([
  "lib/v1/app.mjs",
  "lib/v1/apply.mjs",
  "lib/v1/cli.mjs",
  "lib/v1/client.mjs",
  "lib/v1/device.mjs",
  "lib/v1/help.mjs",
  "lib/v1/host.mjs",
  "lib/v1/job-id.mjs",
  "lib/v1/job-meta.mjs",
  "lib/v1/lender.mjs",
  "lib/v1/lock.mjs",
  "lib/v1/loopback-security.mjs",
  "lib/v1/mcp.mjs",
  "lib/v1/open-link.mjs",
  "lib/v1/open-url.mjs",
  "lib/v1/owner-name.mjs",
  "lib/v1/quota.mjs",
  "lib/v1/result-download.mjs",
  "lib/v1/run.mjs",
  "lib/v1/server.mjs",
  "lib/v1/short-invite.mjs",
  "lib/v1/status.mjs",
  "lib/v1/store.mjs",
  "lib/protocol/index.mjs",
  "lib/protocol/encoding.mjs",
  "lib/docker-backend.mjs",
  "lib/runtime.mjs",
  "lib/harnesses.mjs",
  "lib/harness-spec.mjs",
  "lib/archive.mjs",
  "lib/coordinator.mjs",
  "lib/coordinator-hosting.mjs",
  "lib/executor.mjs",
  "lib/git-candidate.mjs",
  "lib/host.mjs",
  "lib/local-state.mjs",
  "lib/source-package.mjs",
  "lib/harnesses/claude-code-api-key.adapter.mjs",
  "lib/harnesses/claude-code-subscription.adapter.mjs",
  "lib/harnesses/codex.adapter.mjs",
  "lib/harnesses/gemini.adapter.mjs",
  "lib/harnesses/gh-cli.adapter.mjs",
  "lib/harnesses/index.mjs",
  "lib/harnesses/opencode.adapter.mjs",
  "lib/harnesses/shared.mjs",
  "bin/faravan",
  "bin/faravan-coordinator",
  "bin/faravan-detect-sbx"
]);
  const pending = ['bin/faravan', 'bin/faravan-coordinator', 'bin/faravan-detect-sbx'];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    covered(file);
    // Unreviewed auth modules are covered by manifests, but deliberately not read.
    if (!audited.has(file)) continue;
    const source = await read(file);
    const imports = /(?:\b(?:import|export)\s+(?:[^;'"]*?\bfrom\s*)?|\b(?:import|require)\s*\(\s*)['"](\.[^'"]+)['"]/g;
    for (const [, specifier] of source.matchAll(imports)) {
      const dependency = posix.normalize(posix.join(posix.dirname(file), specifier));
      covered(dependency);
      if (dependency.endsWith('.mjs')) pending.push(dependency);
    }
  }
  assert.ok(visited.size >= 35, 'runtime import traversal unexpectedly stopped');
  for (const file of [
    'bin/faravan-firewall-helper', 'bin/faravan-install-sbx', 'bin/faravan-install.sh',
    'profiles/faravan-docker.json', 'kits/wf-gh-cli/spec.yaml',

    'public/v1/index.html', 'public/v1/app.mjs', 'public/v1/app.css', 'public/join/index.html',
  ]) covered(file);

  // Each Debian integration asset must come from the same staged tree as tar.
  let integrations = 0;
  for (const [, source, destination] of nfpm.matchAll(/- src: \.\/(stage\/[^\n]+)\n\s+dst: ([^\n]+)/g)) {
    if (!/\.(service|desktop)$/.test(destination)) continue;
    integrations++;
    assert.equal(source, 'stage' + destination);
    const asset = posix.basename(destination), directory = posix.dirname(destination);
    const line = build.split('\n').find(line => line.startsWith('install -m 0644 ')
      && line.includes('"$package_dir/assets/' + asset + '"')
      && line.includes('"$stage_dir' + directory + '/"'));
    assert.ok(line, 'integration asset not staged: ' + asset);
    assert.ok((await read('packaging/assets/' + asset)).length > 0);
  }
  assert.equal(integrations, 6, 'Debian integration manifest is incomplete');
  assert.doesNotMatch(build, /\$\{status:-0\}.*-eq 1.*exit 0/);
  assert.doesNotMatch(brew, /"\$status".*-eq 1.*exit 0/);
  assert.match(brew, /cd "tray" do\s+system "go", "build".*"\.\/cmd\/faravan-tray"/);
});

test('an expected host setup error prints its copy without a stack trace', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wf-fed-cli-host-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const failure = await runCli(['host', '--port', '0'], { home }).then(() => null, error => error);
  assert.equal(failure?.code, 1);
  assert.match(failure.stderr, /^faravan: --port must be a number between 1 and 65535\n$/);
  assert.doesNotMatch(failure.stderr, /\n\s+at /);
});

test('app --json keeps stdout exclusive across default-sink reaper passes',async t=>{
  const home=await mkdtemp(join(tmpdir(),'reaper-cli-json-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const cliUrl=new URL('../lib/v1/cli.mjs',import.meta.url).href;
  const backendUrl=new URL('../lib/docker-backend.mjs',import.meta.url).href;
  const source=`
    import assert from 'node:assert/strict';
    import {mkdir,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {runV1Command} from ${JSON.stringify(cliUrl)};
    import {DockerSbxBackend} from ${JSON.stringify(backendUrl)};
    const home=process.argv[1],directory=join(home,'journal');
    const backend=new DockerSbxBackend({home,cleanupDirectory:directory,imagePins:{},
      hostDiskFactory:()=>({}),storage:{},runCommand:async args=>{
        if(args[0]==='ls'&&args[1]==='--json')return {code:0,stdout:'[]',stderr:''};
        throw Error('no other sandbox command is expected');
      }});
    const signal=new AbortController().signal;
    const code=await runV1Command(['app','--json'],{home,signal,
      env:{FARAVAN_NO_BROWSER:'1'},startApp:async()=>{
        // The initial pass and a later periodic pass use the real default sink.
        // Driving the passes directly avoids a wall-clock sleep or host app.
        await backend.reapCleanup();await backend.reapCleanup();
        return {origin:'http://127.0.0.1:1234',handoffUrl:()=>{throw Error('no handoff');},close:async()=>{}};
      }});
    assert.equal(code,0);
    // Unreadable work is held, not removed, but must still be diagnosed.
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'11111111-1111-4111-8111-111111111111.json'),'invalid');
    await backend.reapCleanup();
  `;
  const {stdout,stderr}=await execFileAsync(process.execPath,['--input-type=module','-e',source,home],{
    env:{...process.env,HOME:home,FARAVAN_HOME:home,FARAVAN_SBX_HOME:home},
    timeout:15000,maxBuffer:1024*1024,
  });
  assert.equal(stdout,JSON.stringify({url:'http://127.0.0.1:1234/'})+'\n');
  const diagnostics=stderr.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.equal(diagnostics.length,1,'empty passes must be silent; held work must be diagnosed');
  assert.equal(diagnostics[0].event,'reaper_pass');
  assert.equal(diagnostics[0].rows_unknown,1);
  assert.equal(diagnostics[0].rows_total,1);
});
