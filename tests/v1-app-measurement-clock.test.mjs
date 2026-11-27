import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, waitFor} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

const adapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed:true, signedIn:true,
  harnessVersion:'synthetic-only', models:['claude-haiku-5-5'], capabilities:[]}];

test('the history import reads the same clock as the app, so a measurement expires on one clock', {timeout:120000}, async t => {
  const f = await appFixture(t);
  const offsetMs = 90_000, imports = [];
  const sessionHomeDir = (await f.home('sessions'));
  await f.connect({adapters, sessionHomeDir, clock:() => (Date.now() + offsetMs) / 1000,
    historyAdapter:async args => {
      if (typeof args.now === 'function') imports.push(args.now());
      return {meterPeriods:[], existingScores:[], currentWindows:[], writeImportedScores() {}};
    }});
  const at = await waitFor(async () => imports[0] ?? null, 'the app to import local history');
  assert.ok(Math.abs(at - (Date.now() + offsetMs)) < 20_000, 'the import clock is the app clock, not the real one');
});
