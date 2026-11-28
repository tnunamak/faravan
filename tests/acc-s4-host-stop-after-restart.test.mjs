import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {hostCommand} from '../lib/v1/host-command.mjs';

// Behavior 2: after the app quits and restarts while its host keeps running, the owner's hosting stop
// (hosting.stop -> `faravan host --stop`) succeeds or adopts the host. It never answers launcher_unverified
// for the app's own host. Hermetic: a temp coordinator home; the host is the app's own coordinator, whose
// config says host_wanted and whose launcher (the old app's child handle and token) is gone.
test('owner stop after an app restart does not answer launcher_unverified', async t => {
  const home = await mkdtemp(join(tmpdir(), 'acc-s4-stop-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => r(port)); }); });
  await writeFile(join(home, 'host.json'), JSON.stringify({protocol_version: 1, host_wanted: true, circle_id: 'c1',
    port, stop_generation: 'g1', reachability: {kind: 'lan'}, status_path: join(home, 'status.json')}));
  await writeFile(join(home, 'status.json'), JSON.stringify({protocol_version: 1, status: 'stopped'}));
  let outcome;
  try { outcome = {ok: await hostCommand({home, coordinatorHome: home}, ['--stop'], 'host_stopped')}; }
  catch (error) { outcome = {error}; }
  console.log(JSON.stringify({code: outcome.error?.code, msg: outcome.error?.message, ok: outcome.ok}));
  assert.notEqual(outcome.error?.code, 'launcher_unverified');
  assert.ok(!outcome.error, 'stop succeeded: ' + outcome.error?.message);
});
