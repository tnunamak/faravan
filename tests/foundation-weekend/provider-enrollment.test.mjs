import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrollmentEffects } from '../../lib/v1/providers/enrollment.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fakeFlow() {
  const done = deferred();
  let cleanup = 0, cancel = 0, waits = 0;
  return { done, counts: () => ({ cleanup, cancel, waits }),
    flow: { url: 'https://fixture.example.invalid', acceptsCode: false,
      async waitForCompletion() { waits++; return done.promise; },
      async cancel() { cancel++; done.resolve({ status: 'cancelled' }); },
      async cleanup() { cleanup++; } } };
}

test('conservative assumption: only complete flow reaches existing enrollment callback', async () => {
  const f = fakeFlow(); let starts = 0, enrollments = 0;
  const effects = createEnrollmentEffects({ start: async () => { starts++; return f.flow; },
    enrollmentFromFlow: async flow => { assert.equal(flow, f.flow); enrollments++; return { accepted: true }; } });
  try {
    const [a, b] = await Promise.all([effects.beginSignIn({ accountId: 'opaque-a' }),
      effects.beginSignIn({ accountId: 'opaque-a' })]);
    assert.deepEqual(a, b); assert.equal(starts, 1);
    const one = effects.finishSignIn({ flowId: 'opaque-a' });
    const two = effects.finishSignIn({ flowId: 'opaque-a' });
    await Promise.resolve();
    assert.equal(enrollments, 0);
    f.done.resolve({ status: 'complete' });
    assert.deepEqual(await one, { accepted: true });
    assert.deepEqual(await two, { accepted: true });
    assert.equal(enrollments, 1);
    assert.deepEqual(f.counts(), { cleanup: 1, cancel: 0, waits: 1 });
  } finally { await effects.cancelSignIn('opaque-a'); }
});

test('cancel during pending startup owns and drains the eventual flow', async () => {
  const starting = deferred(), f = fakeFlow(); let enrolled = 0;
  const effects = createEnrollmentEffects({ start: () => starting.promise,
    enrollmentFromFlow: async () => { enrolled++; } });
  const begin = effects.beginSignIn({ accountId: 'opaque-b' });
  const cancel = effects.cancelSignIn('opaque-b');
  starting.resolve(f.flow);
  await Promise.all([begin, cancel]);
  assert.equal(enrolled, 0);
  assert.deepEqual(f.counts(), { cleanup: 1, cancel: 1, waits: 0 });
});

test('cancel remains available while completion is waiting', async () => {
  const f = fakeFlow(); let enrolled = 0;
  const effects = createEnrollmentEffects({ start: async () => f.flow,
    enrollmentFromFlow: async () => { enrolled++; } });
  await effects.beginSignIn({ accountId: 'opaque-c' });
  const finishing = effects.finishSignIn({ flowId: 'opaque-c' });
  await Promise.resolve();
  await effects.cancelSignIn('opaque-c');
  await finishing;
  assert.equal(enrolled, 0);
  assert.equal(f.counts().cancel, 1); assert.equal(f.counts().cleanup, 1);
});

test('transient wait rejection retries same flow without signed_out or new login', async () => {
  const f = fakeFlow(); let starts = 0, waits = 0, enrolled = 0;
  f.flow.waitForCompletion = async () => {
    waits++;
    if (waits === 1) throw new Error('synthetic transient');
    if (waits === 2) return { status: 'pending' };
    return { status: 'complete' };
  };
  const effects = createEnrollmentEffects({ start: async () => { starts++; return f.flow; },
    enrollmentFromFlow: async () => { enrolled++; return { accepted: true }; } });
  try {
    await effects.beginSignIn({ accountId: 'opaque-d' });
    await assert.rejects(effects.finishSignIn({ flowId: 'opaque-d' }), /synthetic transient/);
    await assert.rejects(effects.finishSignIn({ flowId: 'opaque-d' }), /not complete/);
    assert.equal(enrolled, 0); assert.equal(f.counts().cleanup, 0);
    assert.deepEqual(await effects.finishSignIn({ flowId: 'opaque-d' }), { accepted: true });
    assert.equal(starts, 1); assert.equal(enrolled, 1); assert.equal(f.counts().cleanup, 1);
  } finally { await effects.cancelSignIn('opaque-d'); }
});

test('redirect and code dispatch use live flow capabilities, not guessing', async () => {
  for (const redirect of [true, false]) {
    const f = fakeFlow(), calls = [];
    f.flow.acceptsRedirect = redirect; f.flow.acceptsCode = !redirect;
    f.flow.submitRedirect = async answer => { calls.push(['redirect', answer]); };
    f.flow.submitCode = async answer => { calls.push(['code', answer]); };
    f.done.resolve({ status: 'complete' });
    const effects = createEnrollmentEffects({ start: async () => f.flow,
      enrollmentFromFlow: async () => ({ accepted: true }) });
    try {
      await effects.beginSignIn({ accountId: 'opaque-e' });
      await effects.finishSignIn({ flowId: 'opaque-e', answer: 'synthetic-answer' });
      assert.deepEqual(calls, [[redirect ? 'redirect' : 'code', 'synthetic-answer']]);
    } finally { await effects.cancelSignIn('opaque-e'); }
  }
});
