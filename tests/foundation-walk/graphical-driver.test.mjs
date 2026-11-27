import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunner } from './runner.mjs';

// Conservative assumption: without a complete artifact identity, no graphical
// journey is authorized. This is a guard regression, not a desktop-walk claim.
test('conservative assumption: missing artifact pins reject before all injected effects', () => {
  const calls = [];
  const effect = name => () => { calls.push(name); throw new Error('unexpected effect'); };
  assert.throws(() => createRunner({
    binding: {},
    clock: {
      now: effect('clock.now'),
      setTimeout: effect('clock.setTimeout'),
      clearTimeout: effect('clock.clearTimeout'),
    },
    state: {
      load: effect('state.load'),
      save: effect('state.save'),
      writeEvidence: effect('state.writeEvidence'),
    },
    driver: {
      run: effect('driver.run'),
      resume: effect('driver.resume'),
      cleanup: effect('driver.cleanup'),
    },
    secretFile: { withValue: effect('secretFile.withValue') },
  }));
  assert.deepEqual(calls, []);
});
