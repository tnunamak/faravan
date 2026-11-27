import test from 'node:test';
import assert from 'node:assert/strict';
import {DockerSbxBackend} from '../../lib/docker-backend.mjs';

// Conservative scope: prove the existing sign-in preparation bootstrap only.
// The injected prepare port deliberately does NOT prove sbx creation, launch,
// isolation, durable recovery, or the new LaunchBackend facade.
test('assumption: existing owner sign-in prepare delegates an inert copied bootstrap, never the caller entrypoint', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const admission = new Promise(resolve => { entered = resolve; });
  const original = {
    image: 'codex', auth_strategy: 'docker-native-oauth', execution_scope: 'owner',
    entrypoint: 'synthetic-agent --must-not-run',
    inputs: [{kind: 'fixture', value: 'original'}],
    output_manifest: [{path: 'fixture-output'}],
    resources: {wall_seconds: 60},
  };
  const snapshot = structuredClone(original);
  const handle = {sandbox_id: 'fixture-sign-in'};
  const calls = [];
  const backend = {
    async prepare(job) {
      calls.push(job);
      entered();
      await gate;
      return handle;
    },
    start() { assert.fail('preparation must not invoke start'); },
  };
  const pending = DockerSbxBackend.prototype.prepareSignIn.call(backend, original);
  try {
    await admission;
    assert.equal(calls.length, 1);
    assert.deepEqual(original, snapshot);
    assert.equal(calls[0].entrypoint, 'true');
    assert.deepEqual(calls[0].inputs, []);
    assert.deepEqual(calls[0].output_manifest, []);
    assert.equal(calls[0].image, 'codex');
    assert.equal(calls[0].auth_strategy, 'docker-native-oauth');
    assert.equal(calls[0].execution_scope, 'owner');
    original.resources.wall_seconds = 999;
    assert.equal(calls[0].resources.wall_seconds, 60);
    release();
    assert.strictEqual(await pending, handle);
    assert.equal(calls.length, 1);
  } finally {
    release();
    await pending.catch(() => {});
  }
});

test('existing inert bootstrap propagates delayed preparation failure without starting or retrying', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const admission = new Promise(resolve => { entered = resolve; });
  const failure = new Error('synthetic preparation failure');
  let calls = 0;
  const backend = {
    async prepare(job) {
      calls++;
      assert.equal(job.entrypoint, 'true');
      entered();
      await gate;
      throw failure;
    },
    start() { assert.fail('failed preparation must not invoke start'); },
  };
  const pending = DockerSbxBackend.prototype.prepareSignIn.call(backend, {
    image: 'codex', auth_strategy: 'docker-native-oauth', execution_scope: 'owner',
    entrypoint: 'synthetic-agent --must-not-run', inputs: [], output_manifest: [],
  });
  const checked = assert.rejects(pending, error => error === failure);
  try {
    await admission;
    assert.equal(calls, 1);
    release();
    await checked;
    assert.equal(calls, 1);
  } finally {
    release();
    await checked;
  }
});
