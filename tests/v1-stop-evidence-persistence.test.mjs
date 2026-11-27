import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStopEvidenceStore, STOP_EVIDENCE_TTL_MS} from '../lib/v1/stop-evidence.mjs';

const T = Date.UTC(2026, 10, 11, 12);
const BIND = {backend_id: 'docker-sbx', sbx_version: '1.2.3'};
const STOP = {delivered: true, fallback: null, latency_ms: 4200, removed: true};
const dir = async () => mkdtemp(join(process.env.HOME, '.tmp', 'stop-evidence-'));
const clock = start => { const c = {t: start, now: () => c.t}; return c; };

test('a saved receipt survives a restart and ignores account, provider and daemon', async () => {
  const d = await dir();
  try {
    const file = join(d, 'stop-evidence.json'), c = clock(T);
    const a = createStopEvidenceStore({file, now: c.now});
    const g = await a.begin();
    assert.equal(await a.succeed(g, {...BIND, stop: STOP, measured_at: T}), true);
    const body = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(body.receipt).sort(), ['backend_id', 'delivered', 'fallback', 'generation', 'latency_ms', 'measured_at', 'removed', 'sbx_version']);
    assert.doesNotMatch(JSON.stringify(body), /account|identity|daemon|provider|email/i);
    c.t = T + 3600e3;
    const b = createStopEvidenceStore({file, now: c.now});
    assert.equal((await b.current(BIND)).measured_at, T);
    assert.equal(await b.status(BIND), null);
    assert.equal(await b.current({...BIND, backend_id: 'other'}), null);
    assert.equal(await b.status({...BIND, sbx_version: '1.2.4'}), 'changed');
    assert.equal(await b.current({...BIND, sbx_version: '1.2.4'}), null);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('a receipt is valid for 0 <= age < 24 h only', async () => {
  const d = await dir();
  try {
    const file = join(d, 's.json'), c = clock(T);
    const s = createStopEvidenceStore({file, now: c.now});
    await s.succeed(await s.begin(), {...BIND, stop: STOP, measured_at: T});
    for (const [at, ok] of [[T, true], [T + STOP_EVIDENCE_TTL_MS - 1, true], [T - 1, false], [T + STOP_EVIDENCE_TTL_MS, false], [NaN, false], [Infinity, false]]) {
      c.t = at;
      assert.equal(await s.current(BIND) !== null, ok, `at ${at}`);
    }
    c.t = T + STOP_EVIDENCE_TTL_MS;
    assert.equal(await s.status(BIND), 'expired');
    // A malformed or non-qualifying receipt is refused at save time.
    c.t = T;
    for (const bad of [{...STOP, delivered: false}, {...STOP, fallback: 'hard'}, {...STOP, removed: false}, {...STOP, latency_ms: -1}, {...STOP, latency_ms: NaN}]) {
      const t = createStopEvidenceStore({file: join(d, 'bad.json'), now: c.now});
      assert.equal(await t.succeed(await t.begin(), {...BIND, stop: bad, measured_at: T}), false);
      assert.equal(await t.receipt(), null);
    }
    const t = createStopEvidenceStore({file: join(d, 'bad2.json'), now: c.now});
    assert.equal(await t.succeed(await t.begin(), {...BIND, stop: STOP, measured_at: NaN}), false);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('a newer failed stop invalidates, survives a restart, and an older success cannot revive it', async () => {
  const d = await dir();
  try {
    const file = join(d, 's.json'), c = clock(T);
    const s = createStopEvidenceStore({file, now: c.now});
    await s.succeed(await s.begin(), {...BIND, stop: STOP, measured_at: T});
    const old = await s.begin();           // an older check still in flight
    const newer = await s.begin();
    assert.equal(await s.fail(newer), true);
    assert.equal(await s.receipt(), null);
    assert.equal(await s.succeed(old, {...BIND, stop: STOP, measured_at: T + 1}), false, 'older success arriving later');
    assert.equal(await s.receipt(), null);
    const again = createStopEvidenceStore({file, now: c.now});
    assert.equal(await again.receipt(), null, 'after a restart');
    assert.equal(await again.status(BIND), 'failed');
    // A later, newer success stands again.
    c.t = T + 2;
    assert.equal(await again.succeed(await again.begin(), {...BIND, stop: STOP, measured_at: T + 2}), true);
    assert.equal((await again.receipt()).measured_at, T + 2);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('a crash before the save leaves no evidence, and a failed save gives no new proof and no revived old one', async () => {
  const d = await dir();
  try {
    const file = join(d, 's.json'), c = clock(T);
    const real = createStopEvidenceStore({file, now: c.now});
    await real.succeed(await real.begin(), {...BIND, stop: STOP, measured_at: T});
    // A check begins (its generation is saved), the stop happens, and the process dies before the receipt is saved.
    const crashed = createStopEvidenceStore({file, now: c.now});
    await crashed.begin();
    const restarted = createStopEvidenceStore({file, now: c.now});
    assert.equal(await restarted.receipt(), null, 'an unfinished check leaves the older receipt unusable');
    // A fresh store with no history: the crash leaves nothing at all.
    const fresh = createStopEvidenceStore({file: join(d, 'fresh.json'), now: c.now});
    const g = await fresh.begin();
    assert.equal(await createStopEvidenceStore({file: join(d, 'fresh.json'), now: c.now}).receipt(), null);
    // A save that fails after the stop gives no usable proof.
    let failing = false;
    const flaky = createStopEvidenceStore({file: join(d, 'flaky.json'), now: c.now, write: async (f, body) => {
      if (failing) throw new Error('disk full');
      const {writeFile} = await import('node:fs/promises'); await writeFile(f, body);
    }});
    const g2 = await flaky.begin();
    failing = true;
    assert.equal(await flaky.succeed(g2, {...BIND, stop: STOP, measured_at: T}), false);
    assert.equal(await flaky.receipt(), null);
    failing = false;
    assert.equal(await createStopEvidenceStore({file: join(d, 'flaky.json'), now: c.now}).receipt(), null);
    // begin() itself cannot run unrecorded.
    failing = true;
    await assert.rejects(flaky.begin());
    void g;
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('a crash after the atomic save keeps the receipt, and a torn temp file is never read', async () => {
  const d = await dir();
  try {
    const file = join(d, 's.json'), c = clock(T);
    const s = createStopEvidenceStore({file, now: c.now});
    await s.succeed(await s.begin(), {...BIND, stop: STOP, measured_at: T});
    const {writeFile} = await import('node:fs/promises');
    await writeFile(file + '.dead.tmp', '{"v":1,"receipt":');
    assert.equal((await createStopEvidenceStore({file, now: c.now}).receipt())?.measured_at, T);
    assert.deepEqual((await readdir(d)).filter(n => n.endsWith('.tmp') && !n.includes('dead')), []);
    await writeFile(file, '{not json');
    assert.equal(await createStopEvidenceStore({file, now: c.now}).receipt(), null, 'a corrupt file is no evidence');
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('concurrent begins allocate distinct generations before and after reopening', async () => {
  const d = await dir();
  try {
    const file = join(d, 's.json');
    const s = createStopEvidenceStore({file, now: () => T});
    assert.deepEqual(await Promise.all([s.begin(), s.begin()]), [1, 2]);
    const reopened = createStopEvidenceStore({file, now: () => T});
    assert.deepEqual(await Promise.all([reopened.begin(), reopened.begin()]), [3, 4]);
  } finally { await rm(d, {recursive: true, force: true}); }
});

for (const first of ['fail', 'succeed']) {
  test(`a gated ${first}-first race never revives the failed generation`, async () => {
    const d = await dir();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const writing = new Promise(resolve => { entered = resolve; });
    let held = false;
    let pending = [];
    try {
      const file = join(d, 's.json');
      const s = createStopEvidenceStore({file, now: () => T, write: async (f, body) => {
        if (held) { held = false; entered(); await gate; }
        const {writeFile} = await import('node:fs/promises');
        await writeFile(f, body);
      }});
      const g = await s.begin();
      held = true;
      const operations = {
        fail: () => s.fail(g),
        succeed: () => s.succeed(g, {...BIND, stop: STOP, measured_at: T}),
      };
      pending = [operations[first](), operations[first === 'fail' ? 'succeed' : 'fail']()];
      await writing;
      // A fresh reader cannot see the held, uncommitted success.
      assert.equal(await createStopEvidenceStore({file, now: () => T}).current(BIND), null);
      release();
      await Promise.all(pending);
      assert.equal(await s.current(BIND), null);
      assert.equal(await createStopEvidenceStore({file, now: () => T}).current(BIND), null);
      assert.equal(await s.succeed(g, {...BIND, stop: STOP, measured_at: T}), false);
    } finally { release(); await Promise.allSettled(pending); await rm(d, {recursive: true, force: true}); }
  });
}

test('a write that publishes and then fails leaves memory equal to disk: no generation is reused', async () => {
  const d = await dir();
  try {
    const file = join(d, 'stop-evidence.json');
    const {writeFile} = await import('node:fs/promises');
    let failAfterPublish = true;
    const s = createStopEvidenceStore({file, now: () => T, write: async (f, body) => {
      await writeFile(f, body);
      if (failAfterPublish) { failAfterPublish = false; throw new Error('synthetic close failure after publish'); }
    }});
    await assert.rejects(s.begin(), /after publish/);
    const onDisk = JSON.parse(await readFile(file, 'utf8')).begun;
    assert.equal(onDisk, 1, 'the failed write did publish generation 1');
    assert.equal(await s.begin(), 2, 'the next check takes a new generation, never the published one');
    const reopened = createStopEvidenceStore({file, now: () => T});
    assert.equal(await reopened.begin(), 3, 'a reopened store and this one agree on the generations used');
  } finally { await rm(d, {recursive: true, force: true}); }
});
