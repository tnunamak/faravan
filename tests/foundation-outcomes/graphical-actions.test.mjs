import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../foundation-walk/runner.mjs';

// Narrow contract regression, NOT evidence of graphical installation or join.
// The operation-port dependency is still required before implementing that driver.
const binding = { platform: 'linux', head: 'a'.repeat(40), artifactSha256: 'b'.repeat(64) };

function ports() {
  const effects = [];
  const unexpected = name => () => {
    effects.push(name);
    throw new Error('No effects are permitted during construction');
  };
  return {
    effects,
    dependencies: {
      clock: { now: () => 0, setTimeout: unexpected('timer'), clearTimeout: unexpected('clearTimer') },
      state: { load: unexpected('load'), save: unexpected('save'), writeEvidence: unexpected('writeEvidence') },
      driver: { run: unexpected('run'), resume: unexpected('resume'), cleanup: unexpected('cleanup') },
      secretFile: { withValue: unexpected('secretFile') },
    },
  };
}

test('known-valid platform and head isolate a missing artifact hash before effects', () => {
  const { effects, dependencies } = ports();
  const { artifactSha256: _hash, ...withoutHash } = binding;
  assert.throws(() => createRunner({ ...dependencies, binding: withoutHash }));
  assert.deepEqual(effects, []);
});

test('the identical platform and head with a valid hash construct successfully without effects', () => {
  const { effects, dependencies } = ports();
  const runner = createRunner({ ...dependencies, binding });
  assert.equal(typeof runner.walk, 'function');
  assert.deepEqual(effects, []);
});
