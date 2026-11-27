import './helpers/no-browser.mjs';
// The harness LAN address (tests/helpers/lan-interfaces.mjs) reaches resolveLanUrl only when the test preload is loaded,
// and only for a loopback or private address. Production code has no such override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const preload = new URL('./helpers/lan-interfaces.mjs', import.meta.url).href;
const host = new URL('../lib/host.mjs', import.meta.url).href;
const resolve = (env, args = []) => spawnSync(process.execPath, [...args, '--input-type=module', '-e',
  `import(${JSON.stringify(host)}).then(m => console.log(m.resolveLanUrl({port: 8787})))`],
  { env: { ...process.env, FARAVAN_TEST_LAN_ADDRESS: undefined, ...env }, encoding: 'utf8' });

test('the harness address is the LAN URL when the preload is loaded', () => {
  const run = resolve({ FARAVAN_TEST_LAN_ADDRESS: '127.0.0.1' }, ['--import=' + preload]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'http://127.0.0.1:8787');
});

test('the harness refuses a public address, so the origin stays on a private network', () => {
  const run = resolve({ FARAVAN_TEST_LAN_ADDRESS: '8.8.8.8' }, ['--import=' + preload]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must be a loopback or private IPv4 address, got 8\.8\.8\.8/);
});

test('without the preload the environment variable has no effect', () => {
  const run = resolve({ FARAVAN_TEST_LAN_ADDRESS: '127.0.0.1' });
  // Real interfaces never give loopback as a LAN address (it is internal), so this is either another URL or a refusal.
  assert.notEqual(run.stdout.trim(), 'http://127.0.0.1:8787', 'production resolveLanUrl must not read FARAVAN_TEST_LAN_ADDRESS');
});
