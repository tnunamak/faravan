import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createJobOperations} from '../lib/v1/cli.mjs';

// The CLI's default job circle is the app's: the circle this computer lends in, read from the same settings file.
const approved = circle => ({...circle, origin: 'https://' + circle.id + '.test', enrollment: {state: 'approved'}, rosterMembershipVerified: true});
function fixture(lendingCircle) {
  const home = mkdtempSync(path.join(tmpdir(), 'cli-default-circle-'));
  mkdirSync(path.join(home, 'v1'), {recursive: true});
  if (lendingCircle !== undefined) writeFileSync(path.join(home, 'v1', 'app-settings.json'), JSON.stringify({version: 1, activeCircle: lendingCircle}));
  const circles = [approved({id: 'demo'}), approved({id: 'friends'})];
  const device = {listCircles: async () => circles, selectCircle: async () => circles[0]};
  return {home, device};
}

test('the CLI default circle is the circle this computer lends in, even when another circle was used last', async () => {
  const {home, device} = fixture('friends');
  const prepared = await createJobOperations({home, device}).prepareSend({});
  assert.equal(prepared.circle.id, 'friends');
});

test('without lending settings, the CLI default stays the last circle used', async () => {
  const {home, device} = fixture(undefined);
  const prepared = await createJobOperations({home, device}).prepareSend({});
  assert.equal(prepared.circle.id, 'demo');
});
