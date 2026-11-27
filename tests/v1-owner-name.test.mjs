import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {osFullName, defaultOwnerName} from '../lib/v1/owner-name.mjs';

const user = () => ({username: 'rowan'});
test('the OS full name comes from GECOS on Linux and id -F on macOS', () => {
  const calls = [];
  const run = (cmd, args) => {calls.push([cmd, ...args]); return cmd === 'getent' ? 'rowan:x:1000:1000:Rowan Vale,,,:/home/rowan:/bin/zsh\n' : 'Rowan Vale\n';};
  assert.equal(osFullName({platform: 'linux', userInfo: user, run}), 'Rowan Vale');
  assert.equal(osFullName({platform: 'darwin', userInfo: user, run}), 'Rowan Vale');
  assert.deepEqual(calls, [['getent', 'passwd', 'rowan'], ['id', '-F', 'rowan']]);
});
test('the OS full name is looked up once per runner, not once per call', () => {
  let lookups = 0;
  const run = () => { lookups++; return 'rowan:x:1000:1000:Rowan Vale,,,:/home/rowan:/bin/zsh\n'; };
  assert.equal(osFullName({platform: 'linux', userInfo: user, run}), 'Rowan Vale');
  assert.equal(osFullName({platform: 'linux', userInfo: user, run}), 'Rowan Vale');
  assert.equal(lookups, 1);
});
test('the host name is the fallback only when there is no full name', () => {
  const hostname = () => 'sandpiper';
  assert.equal(defaultOwnerName({platform: 'linux', userInfo: user, run: () => 'rowan:x:1000:1000::/home/rowan:/bin/sh', hostname}), 'sandpiper');
  assert.equal(defaultOwnerName({platform: 'linux', userInfo: user, run: () => {throw new Error('no getent');}, hostname}), 'sandpiper');
  assert.equal(defaultOwnerName({platform: 'win32', userInfo: user, hostname}), 'sandpiper');
  assert.equal(defaultOwnerName({platform: 'linux', userInfo: user, run: () => 'rowan:x:1:1:Rowan Vale:/:/bin/sh', hostname}), 'Rowan Vale');
});

for (const failure of ['throws', 'empty']) {
  test('a ' + failure + ' full-name lookup is retried and the successful name is memoized', () => {
    let lookups = 0;
    const run = () => {
      if (++lookups === 1) {
        if (failure === 'throws') throw new Error('temporary directory failure');
        return 'rowan:x:1000:1000::/home/rowan:/bin/sh\n';
      }
      return 'rowan:x:1000:1000:Rowan Vale,,,:/home/rowan:/bin/sh\n';
    };
    const options = {platform: 'linux', userInfo: user, run, hostname: () => 'sandpiper'};
    assert.equal(defaultOwnerName(options), 'sandpiper');
    assert.equal(defaultOwnerName(options), 'Rowan Vale');
    assert.equal(defaultOwnerName(options), 'Rowan Vale');
    assert.equal(lookups, 2);
  });
}
