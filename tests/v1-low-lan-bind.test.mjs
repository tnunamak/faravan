import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coordinatorBindHost, resolveLanUrl } from '../lib/host.mjs';

test('L5: LAN mode binds exactly the chosen LAN address, never 0.0.0.0', () => {
  const networkInterfaces = {lo: [{family: 'IPv4', internal: true, address: '127.0.0.1'}],
    eth0: [{family: 'IPv4', internal: false, address: '10.23.4.5'}]};
  const publicUrl = resolveLanUrl({port: 9000, networkInterfaces});
  assert.equal(coordinatorBindHost({reachability: {kind: 'lan', publicUrl}, envHost: '0.0.0.0'}), '10.23.4.5');
  assert.throws(() => coordinatorBindHost({reachability: {kind: 'lan'}}), /LAN mode/);
});

test('L5: non-LAN hosts keep the explicit host setting, defaulting to loopback', () => {
  assert.equal(coordinatorBindHost({}), '127.0.0.1');
  assert.equal(coordinatorBindHost({reachability: {kind: 'ngrok'}}), '127.0.0.1');
  assert.equal(coordinatorBindHost({reachability: {kind: 'url', publicUrl: 'https://x.example'}, envHost: '10.0.0.2'}), '10.0.0.2');
});

test('L5: the coordinator binary no longer hard-codes 0.0.0.0', () => {
  assert.doesNotMatch(readFileSync(new URL('../bin/faravan-coordinator', import.meta.url), 'utf8'), /'0\.0\.0\.0'/);
});
