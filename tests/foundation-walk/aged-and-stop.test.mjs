import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunner } from './runner.mjs';

// Conservative assumption: exercise only the existing portable runner seam.
// This is NOT a product W07/W08 adapter or a claim of Stop/cessation evidence.
// Synthetic artifact identity; no browser, native store, credential file or I/O.
const binding = {
  platform: 'linux', head: 'a'.repeat(40), artifactSha256: 'b'.repeat(64),
};
function fixture(load) {
  const calls = [];
  const forbidden = name => () => {
    calls.push(name);
    throw new Error('unexpected_effect');
  };
  const runner = createRunner({
    binding,
    clock: {
      now: forbidden('clock'), setTimeout: forbidden('timer'),
      clearTimeout: forbidden('clearTimer'),
    },
    state: {
      load: async () => { calls.push('load'); return load(); },
      save: forbidden('save'), writeEvidence: forbidden('evidence'),
    },
    driver: {
      run: forbidden('run'), resume: forbidden('resume'),
      cleanup: forbidden('cleanup'),
    },
    secretFile: { withValue: forbidden('secret') },
  });
  return { runner, calls };
}
for (const [name, saved] of [
  ['old persisted schema', { schemaVersion: 0, binding }],
  ['different pinned head', { schemaVersion: 1, binding: { ...binding, head: 'c'.repeat(40) } }],
  ['different pinned artifact', { schemaVersion: 1, binding: { ...binding, artifactSha256: 'd'.repeat(64) } }],
]) {
  test('conservative recovery assumption: ' + name + ' cannot start or reclaim a job', async () => {
    const { runner, calls } = fixture(async () => ({
      ...saved, receipts: [], pending: { check: 'synthetic_pending', status: 'running' },
    }));
    await assert.rejects(runner.walk({ resume: true }), { message: 'walk_binding_mismatch' });
    assert.deepEqual(calls, ['load']);
    // A rejected recovery must release the busy guard rather than lock the walk.
    await assert.rejects(runner.walk({ resume: true }), { message: 'walk_binding_mismatch' });
    assert.deepEqual(calls, ['load', 'load']);
  });
}
test('conservative recovery assumption: overlapping reload cannot duplicate effects and failed load releases busy guard', async () => {
  let rejectLoad;
  const pending = new Promise((_, reject) => { rejectLoad = reject; });
  const { runner, calls } = fixture(() => pending);
  const first = runner.walk({ resume: true });
  // Attach the rejection observer before releasing the held load.
  const rejected = assert.rejects(first, { message: 'synthetic_load_failure' });
  try {
    await assert.rejects(runner.walk({ resume: true }), { message: 'walk_already_running' });
    assert.deepEqual(calls, ['load']);
  } finally {
    rejectLoad(new Error('synthetic_load_failure'));
    await rejected;
  }
  await assert.rejects(runner.walk({ resume: true }), { message: 'synthetic_load_failure' });
  assert.deepEqual(calls, ['load', 'load']);
});
