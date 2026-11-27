import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture} from './helpers/v1-app-fixture.mjs';
import {openDevice} from '../lib/v1/device.mjs';

for (const account of [undefined, 'other-account']) test('the injected device owns the candidate even when options supply ' + String(account), async t => {
  const f = await appFixture(t), home = await f.home('owner');
  const device = await openDevice({home});
  const {app} = await f.start('owner', {device,lendingPace50:{account}});
  assert.equal(app.device.keyId, device.keyId);
  const state = JSON.parse(await readFile(join(home,'v1','lending-pace50-state.json'),'utf8'));
  assert.equal(state.account, device.keyId);
});
