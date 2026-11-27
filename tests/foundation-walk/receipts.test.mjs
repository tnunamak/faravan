import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, receipt, aggregate, jsonl } from './receipts.mjs';
import { createRunner, DEADLINES } from './runner.mjs';
const binding = { platform: 'linux', head: 'a'.repeat(40), artifactSha256: 'b'.repeat(64) };
function result(extra = {}) {
  return { outcome: 'pass', observed: { mode: 'live', os: 'Linux', arch: 'x64', backendVersion: 'synthetic' },
    evidencePaths: ['receipts/opaque.json'], ...extra };
}
function record(check, extra = {}) {
  return receipt({ schemaVersion: 1, ...binding, check, elapsedMs: 0, ...result(extra) });
}
function harness(overrides = {}) {
  let saved = null, now = 0, next = 0;
  const timers = new Map(), calls = [];
  const clock = {
    now: () => now,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, item] of [...timers]) if (item.at <= now) { timers.delete(id); item.fn(); } },
  };
  const state = { outputs: {}, async writeEvidence(name, body) { this.outputs[name] = body; }, async load() { return structuredClone(saved); }, async save(value) { saved = structuredClone(value); } };
  const driver = {
    async run({ check }) { calls.push(['run', check]); return result(); },
    async resume({ check }) { calls.push(['resume', check]); return result(); },
    async cleanup() { calls.push(['cleanup']); return result(); },
    ...overrides,
  };
  return { clock, state, driver, calls, timers, secretFile: { async withValue(fn) { return fn('SYNTHETIC_SECRET'); } } };
}
test('all twelve required; fail is sticky and later pass cannot replace clean-install failure', () => {
  const all = CHECKS.map(check => record(check));
  assert.equal(aggregate(all, binding).exitCode, 0);
  assert.equal(aggregate(all.slice(1), binding).exitCode, 2);
  const failed = [record(CHECKS[1], { outcome: 'fail' }), ...all];
  assert.equal(aggregate(failed, binding).firstFailure, CHECKS[1]);
  assert.equal(aggregate(failed, binding).exitCode, 1);
});
test('fixture intervention and simulated real-provider checks cannot pass', () => {
  assert.equal(record(CHECKS[1], { observed: { ...result().observed, fixtureIntervention: true } }).outcome, 'blocked');
  assert.equal(record(CHECKS[5], { observed: { ...result().observed, mode: 'fixture' } }).outcome, 'blocked');
  assert.equal(record(CHECKS[6], { observed: { ...result().observed, mode: 'fixture' } }).outcome, 'pass');
  assert.throws(() => record(CHECKS[0], { outcome: 'skipped' }), /invalid_walk_receipt/);
});
test('sanitize auth/invite values and raw bodies; preserve original observation age', () => {
  const r = receipt({ schemaVersion: 1, ...binding, check: CHECKS[6], elapsedMs: 3,
    ...result({ observed: { ...result().observed, readingAgeMs: 1_500_000,
      accountId: 'SYNTHETIC_SECRET', rawBody: 'invite=https://private.invalid/token',
      code: 'https://private.invalid/a' }, evidencePaths: ['receipts/ok.json', '/tmp/auth', '../escape', 'token.txt'] }),
  }, ['SYNTHETIC_SECRET']);
  const out = jsonl([r]);
  assert.doesNotMatch(out, /SYNTHETIC_SECRET|private\.invalid|rawBody|\/tmp\/auth/);
  assert.equal(r.observed.readingAgeMs, 1_500_000);
  assert.deepEqual(r.evidencePaths, ['receipts/ok.json']);
});
test('runner persists all checks, cleans fixtures, and removes its timers', async () => {
  const h = harness();
  const run = await createRunner({ binding, ...h }).walk();
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.checks.length, 12);
  assert.equal(h.calls.filter(([kind]) => kind === 'cleanup').length, 1);
  assert.equal(h.timers.size, 0);
});
test('login pause is durable; resume continues same check without repeated enrollment', async () => {
  const h = harness({ async run({ check }) {
    h.calls.push(['run', check]);
    return check === CHECKS[3] ? result({ outcome: 'blocked', pause: 'login' }) : result();
  } });
  const first = await createRunner({ binding, ...h }).walk();
  assert.equal(first.result.exitCode, 2);
  const before = h.calls.length;
  await createRunner({ binding, ...h }).walk();
  assert.equal(h.calls.slice(before).filter(([kind]) => kind === 'run').length, 0);
  h.clock.advance(900_000);
  const resumed = await createRunner({ binding, ...h }).walk({ resume: true });
  assert.equal(resumed.result.exitCode, 0);
  assert.equal(h.calls.filter(([kind, check]) => kind === 'run' && check === CHECKS[3]).length, 1);
  assert.equal(h.calls.filter(([kind, check]) => kind === 'resume' && check === CHECKS[3]).length, 1);
});
test('explicit join/start/result deadline constants and expired crash resume never redispatch', async () => {
  assert.deepEqual(Object.values(DEADLINES), [60_000, 300_000, 600_000]);
  const h = harness();
  await h.state.save({ schemaVersion: 1, binding, receipts: CHECKS.slice(0, 2).map(check => record(check)),
    pending: { check: CHECKS[2], status: 'running', startedAt: 0, elapsedMs: 0 } });
  h.clock.advance(60_001);
  const out = await createRunner({ binding, ...h }).walk({ resume: true });
  assert.equal(out.result.exitCode, 1);
  assert.equal(out.result.firstFailure, CHECKS[2]);
  assert.equal(h.calls.some(([, check]) => check === CHECKS[2]), false);
  assert.equal(h.timers.size, 0);
});
test('driver error is generic and cleanup still runs; unrelated binding cannot resume', async () => {
  const h = harness({ async run() { throw new Error('Bearer SYNTHETIC_SECRET https://invite.invalid'); } });
  const out = await createRunner({ binding, ...h }).walk();
  assert.equal(out.result.exitCode, 1);
  assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC_SECRET|invite\.invalid/);
  assert.ok(h.calls.some(([kind]) => kind === 'cleanup'));
  await assert.rejects(createRunner({ binding: { ...binding, head: 'c'.repeat(40) }, ...h }).walk(), /binding_mismatch/);
});
test('concurrent calls on one runner cannot duplicate submit', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ async run() { await gate; return result(); } });
  const runner = createRunner({ binding, ...h });
  const first = runner.walk();
  await assert.rejects(runner.walk(), /already_running/);
  release();
  await first;
});

test('active join deadline aborts a hanging driver and cleanup still executes', async () => {
  const h = harness({ async run({ check, signal }) {
    if (check !== CHECKS[2]) return result();
    h.clock.advance(60_000);
    assert.equal(signal.aborted, true);
    return new Promise(() => {});
  } });
  const out = await createRunner({ binding, ...h }).walk();
  assert.equal(out.result.firstFailure, CHECKS[2]);
  assert.equal(out.result.exitCode, 1);
  assert.ok(h.calls.some(([kind]) => kind === 'cleanup'));
  assert.equal(h.timers.size, 0);
});
test('blocked/skipped metadata and missing artifact evidence cannot qualify a pass', () => {
  assert.equal(record(CHECKS[0], { outcome: 'blocked' }).outcome, 'blocked');
  assert.equal(record(CHECKS[0], { evidencePaths: [] }).outcome, 'blocked');
  assert.equal(record(CHECKS[0], { observed: { mode: 'live' } }).outcome, 'blocked');
  assert.throws(() => aggregate([record(CHECKS[0])], { ...binding, head: 'c'.repeat(40) }), /binding_mismatch/);
});
