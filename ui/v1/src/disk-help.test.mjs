import test from 'node:test';
import assert from 'node:assert/strict';
import {diskHelpVM} from './disk-help.mjs';

test('disk help lists what a person could remove and never offers to remove it', () => {
  const vm = diskHelpVM({reclaim: {docker: {command: 'docker system df -v', items: [{kind: 'volume', name: 'pgdata', size: '3.2GB', command: 'docker volume rm pgdata'}]}, faravan: [{name: 'wf-0123456789abcdef'}]}});
  assert.deepEqual(vm.docker.items, [{label: 'Volume pgdata', size: '3.2GB', command: 'docker volume rm pgdata'}]);
  assert.match(vm.docker.heading, /Faravan does not remove them/);
  assert.deepEqual(vm.faravan.names, ['wf-0123456789abcdef']);
});

test('disk help skips cleanly without Docker, and says so when Docker has nothing unused', () => {
  assert.equal(diskHelpVM({reclaim: {docker: null, faravan: []}}), null);
  assert.equal(diskHelpVM({}), null);
  assert.equal(diskHelpVM({reclaim: {docker: {command: 'docker system df -v', items: []}, faravan: []}}).docker.heading, 'Docker shows no unused images or volumes to remove.');
});
