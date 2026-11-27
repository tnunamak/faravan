import './helpers/no-browser.mjs';
// The coordinator's edge records (design §2.3, §3.4, §8). Each injected failure runs the real bin/faravan-coordinator
// and must leave exactly the golden inbox file. The policy decides whether anything is written, and no record names a
// circle, a member, a job or the address the coordinator tried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createConsent} from '../lib/v1/telemetry/consent.mjs';
import { canonicalJson, parseInboxFile } from '../lib/v1/telemetry/catalog.mjs';
import { readGolden } from './helpers/telemetry-golden.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COORDINATOR = join(ROOT, 'bin', 'faravan-coordinator');
const POLICY_ON_GEN_3 = '{"version":2,"level":"on","region":null,"noticeShownAt":1,"decidedAt":1,"generation":3}';

const hourNow = () => new Date().toISOString().slice(0, 13);

async function busyPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {port: server.address().port, close: () => new Promise(resolve => server.close(resolve))};
}

/** Runs the coordinator with a clean environment whose homes are both inside `root`. Resolves with the exit code. */
function runCoordinator({root, port, args = [], env = {}}) {
  const home = join(root, 'home'), appHome = join(root, 'app'), coordHome = join(root, 'coord');
  mkdirSync(home, {recursive: true});
  mkdirSync(appHome, {recursive: true});
  mkdirSync(coordHome, {recursive: true});
  const child = spawn(process.execPath, [COORDINATOR, ...args], {
    env: {
      PATH: process.env.PATH, HOME: home, FARAVAN_HOME: appHome, FARAVAN_COORDINATOR_HOME: coordHome,
      FARAVAN_COORDINATOR_HOST: '127.0.0.1', FARAVAN_COORDINATOR_PORT: String(port),
      FARAVAN_COORDINATOR_V1_ORIGIN: `http://127.0.0.1:${port}`, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); resolve({code, stderr, appHome}); });
  });
}

const inboxOf = appHome => join(appHome, 'v1', 'telemetry', 'inbox');
const inboxFiles = appHome => (existsSync(inboxOf(appHome)) ? readdirSync(inboxOf(appHome)) : []);

/** The golden inbox file with its period set to the hour the coordinator ran in. */
function goldenWithHour(name, hour) {
  const file = JSON.parse(readGolden(name));
  file.record.period = hour;file.gen=3;
  return canonicalJson(file) + '\n';
}

function withoutCapture(text){const {capture,...file}=JSON.parse(text);assert.match(capture.lease_id,/^[0-9a-f-]{36}$/);assert.ok(Number.isSafeInteger(capture.captured_at));return canonicalJson(file)+'\n';}

function writePolicy(appHome, body) {
  mkdirSync(join(appHome, 'v1', 'telemetry'), {recursive: true});
  const dir=join(appHome,'v1','telemetry');writeFileSync(join(dir,'policy.json'),body);
  try {const raw=JSON.parse(body);if(raw.version===2 && raw.level==='on')createConsent({dir,base:dir,uploadable:true}).grantRemoteLease(raw.generation);}catch{}

}

test('a listener that cannot bind writes the golden coordinator problem record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'faravan-coord-edge-'));
  const busy = await busyPort();
  try {
    writePolicy(join(root, 'app'), POLICY_ON_GEN_3);
    const before = hourNow();
    const {code, appHome} = await runCoordinator({root, port: busy.port});
    const after = hourNow();
    assert.equal(code, 1);
    const names = inboxFiles(appHome);
    assert.equal(names.length, 1, `files: ${names}`);
    const text = readFileSync(join(inboxOf(appHome), names[0]), 'utf8');
    const period = JSON.parse(text).record.period;
    assert.ok([before, after].includes(period), `period ${period}`);
    assert.equal(withoutCapture(text), goldenWithHour('inbox.coordinator-listener.json', period));
    parseInboxFile(text);
    // Nothing that identifies the coordinator, its address or its circles.
    for (const canary of ['127.0.0.1', 'EADDRINUSE', 'listen', 'circle', 'member', 'job', String(busy.port)]) {
      assert.ok(!text.includes(canary), `the record names ${canary}`);
    }
  } finally {
    await busy.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('an unapproved Gozar exposure writes one problem and health record under acknowledged consent', async () => {
  const root=mkdtempSync(join(tmpdir(),'faravan-coord-edge-'));
  try {
    writePolicy(join(root,'app'),POLICY_ON_GEN_3);
    mkdirSync(join(root,'coord'));
    const hostConfig=join(root,'coord','host.json');
    writeFileSync(hostConfig,JSON.stringify({protocol_version:1,port:0,keep_awake:false,
      status_path:join(root,'coord','status.json'),reachability:{kind:'gozar'}}));
    const before=hourNow();
    const {code,appHome}=await runCoordinator({root,port:0,args:['--host-config',hostConfig]});
    const after=hourNow();
    assert.equal(code,1);
    const names=inboxFiles(appHome);
    assert.equal(names.length,2);
    const files=names.map(name=>readFileSync(join(inboxOf(appHome),name),'utf8'));
    const named=recordName=>files.find(text=>JSON.parse(text).record.name===recordName);
    const health=named('health.state'),period=JSON.parse(health).record.period;
    assert.ok([before,after].includes(period));
    const want=JSON.parse(goldenWithHour('inbox.coordinator-tunnel.json',period));
    want.record.attrs.reason='requirements_unsupported';
    assert.equal(withoutCapture(health),canonicalJson(want)+'\n');
    const problem=JSON.parse(withoutCapture(named('problem.count')));
    assert.deepEqual(problem.record.attrs,{component:'coordinator','error.type':'requirements_unsupported',
      outcome:'failed',phase:'none','problem.registry':'failure',surface:'background'});
    for(const file of files) {
      parseInboxFile(file);
      assert.doesNotMatch(file,/127\.0\.0\.1|host\.json|exposure\.json/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('off, an environment switch and a corrupt policy each write nothing', async () => {
  const cases = [
    {name:'notice pending',policy:'{"version":2,"level":null,"region":null,"noticeShownAt":null,"decidedAt":null,"generation":0}'},
    {name: 'level off', policy: '{"version":1,"level":"off","region":null,"noticeShownAt":1,"decidedAt":1,"generation":4}'},
    {name: 'a corrupt policy', policy: '{"version":1,'},
    {name: 'an environment switch', policy: POLICY_ON_GEN_3, env: {FARAVAN_NO_TELEMETRY: '1'}},
    {name: 'DO_NOT_TRACK', policy: POLICY_ON_GEN_3, env: {DO_NOT_TRACK: 'true'}},
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'faravan-coord-edge-'));
    const busy = await busyPort();
    try {
      writePolicy(join(root, 'app'), scenario.policy);
      const {code, appHome} = await runCoordinator({root, port: busy.port, env: scenario.env});
      assert.equal(code, 1, scenario.name);
      assert.deepEqual(inboxFiles(appHome), [], scenario.name);
    } finally {
      await busy.close();
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test('after a widening the coordinator stamps the generation the policy now names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'faravan-coord-edge-'));
  const busy = await busyPort();
  try {
    // The person widened from counts to diagnostics: generation 5. The coordinator copies what it reads.
    writePolicy(join(root, 'app'), '{"version":2,"level":"on","region":null,"noticeShownAt":1,"decidedAt":1,"generation":5}');
    const {appHome} = await runCoordinator({root, port: busy.port});
    const [name] = inboxFiles(appHome);
    assert.equal(JSON.parse(readFileSync(join(inboxOf(appHome), name), 'utf8')).gen, 5);
  } finally {
    await busy.close();
    rmSync(root, {recursive: true, force: true});
  }
});
