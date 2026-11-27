import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { coordinatorHome } from '../lib/host.mjs';

function withHome(t, hostJson) {
  fs.mkdirSync(path.join(os.homedir(), '.tmp'), {recursive:true});
  const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'coord-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, C: process.env.FARAVAN_COORDINATOR_HOME, S:process.env.FARAVAN_HOME };
  process.env.HOME = home; delete process.env.FARAVAN_COORDINATOR_HOME; delete process.env.FARAVAN_HOME;
  t.after(() => {
    for (const [name, value] of Object.entries({
      HOME:saved.HOME, FARAVAN_COORDINATOR_HOME:saved.C, FARAVAN_HOME:saved.S,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const legacy = path.join(home, '.waspflow', 'faravan-coordinator');
  if (hostJson) { fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'host.json'), JSON.stringify(hostJson)); }
  return { current: path.join(home, '.faravan', 'coordinator'), legacy, faravan: path.join(home, '.faravan', 'coordinator') };
}








// Bug: the app hosted from <legacy app home>/coordinator while the raw CLI used ~/.faravan/coordinator, so a CLI stop
// reported "stopped" while the app's host ran, and a CLI start made a second, blank host.

// The app's own circles decide where it hosts them. The Mac app has no FARAVAN_HOME: its data folder comes from the
// channel (simulated here with FARAVAN_DATA_HOME), and its coordinator lives beside it, not in ~/.faravan/coordinator.
function appWithCircle(t, {env = 'FARAVAN_DATA_HOME'} = {}) {
  const {faravan} = withHome(t, null);
  const names = ['FARAVAN_HOME', 'FARAVAN_DATA_HOME', 'FARAVAN_COORDINATOR_HOME'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => { for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  const app = path.join(os.homedir(), 'Library', 'Application Support', 'Faravan Preview 20261028');
  fs.mkdirSync(path.join(app, 'v1'), {recursive:true});
  fs.writeFileSync(path.join(app, 'v1', 'state.json'), JSON.stringify({version:1, circles:[{id:'real-circle', owned:true}, {id:'joined', owned:false}]}));
  process.env[env] = app;
  const host = (dir, config) => { fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({schema_version:1, protocol_version:1, port:8787, ...config})); };
  return {app, own: path.join(app, 'coordinator'), faravan, host};
}

test('the Mac app hosts from its own data folder, not a blank ~/.faravan/coordinator', t => {
  const {own, faravan, host} = appWithCircle(t);
  host(own, {circle_id:'real-circle'});
  host(faravan, {circle_id:'other-circle'});
  assert.equal(coordinatorHome(), own);
});

test('a fresh app home starts its coordinator beside the app data, even when ~/.faravan/coordinator exists', t => {
  const {own, faravan, host} = appWithCircle(t, {env:'FARAVAN_HOME'});
  host(faravan, {});
  assert.equal(coordinatorHome(), own);
  assert.equal(coordinatorHome({appHome: path.join(os.homedir(), 'elsewhere')}), path.join(os.homedir(), 'elsewhere', 'coordinator'), 'a named app home wins over the environment');
});


test('a host for a circle this app only joined, or never knew, is not adopted', t => {
  const {own, faravan, host} = appWithCircle(t);
  host(faravan, {circle_id:'joined'});
  assert.equal(coordinatorHome(), own);
});

