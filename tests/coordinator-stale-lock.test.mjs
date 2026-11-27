import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import * as locks from '../lib/v1/lock.mjs';

// These fixtures model Linux/macOS symlink records, not Windows file records.
const posixTest = (name, fn) => test(name, {
  skip:process.platform === 'win32' ? 'POSIX symlink lock fixtures require Linux/macOS; Windows record coverage lives in v1-lock.test.mjs' : false,
}, fn);

// All liveness probes are fakes: no child process, server, or signal is used.
function fixture(t, platform = 'linux') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-lock-stale-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const directory = locks.coordinatorProcessLockPath(home) + '.owners-v1';
  fs.mkdirSync(directory);
  let namespace = null;
  try { namespace = fs.readlinkSync('/proc/self/ns/pid'); } catch {}
  const record = {version:1, host:os.hostname(), namespace, pid:424242,
    boot:platform === 'darwin' ? 'darwin:123' : 'boot-123', start:'101', token:randomUUID()};
  const choosing = path.join(directory, record.token + '.choosing');
  const ticket = path.join(directory, record.token + '.ticket');
  const write = (file, value) => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.symlinkSync(typeof value === 'string' ? value : JSON.stringify(value), file); };
  const publish = () => { write(choosing, record); write(ticket, {...record, ticket:'1'}); };
  publish();
  const clear = () => { fs.unlinkSync(ticket); fs.unlinkSync(choosing); };
  const options = {platform, timeoutMs:0, posixIdentityReader:() => ({boot:record.boot, start:record.start, state:'S'}),
    processKill:(_pid, signal) => { assert.equal(signal, 0); }};
  return {home, directory, record, choosing, ticket, write, publish, clear, options};
}
const errorCode = code => { throw Object.assign(new Error(code), {code}); };
const stale = file => error => {
  assert.equal(error.code, 'coordinator_stale_lock');
  assert.ok(error.message.includes(file));
  assert.match(error.message, /looks stale/i);
  assert.match(error.message, /manually.*clear/i);
  assert.doesNotMatch(error.message, /already owns|stop that coordinator/i);
  return true;
};

for (const platform of ['linux', 'darwin']) {
  for (const probe of ['alive', 'EPERM']) {
    posixTest(platform + ' reused PID is acquired even with ' + probe, async t => {
      const f = fixture(t, platform);
      const release = await locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
        processKill:() => { if (probe === 'EPERM') errorCode('EPERM'); },
        posixIdentityReader:pid => ({boot:f.record.boot, start:pid === f.record.pid ? '202' : '303', state:'S'})});
      release();
      assert.equal(fs.readdirSync(f.directory).includes(path.basename(f.choosing)), false);
      assert.equal(fs.readdirSync(f.directory).includes(path.basename(f.ticket)), false);
    });
  }
  posixTest(platform + ' dead PID is acquired when identity cannot be read', async t => {
    const f = fixture(t, platform);
    const release = await locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
      processKill:() => errorCode('ESRCH'), posixIdentityReader:pid => pid===process.pid?f.options.posixIdentityReader(pid):errorCode('EACCES')});
    release();
    assert.equal(fs.readdirSync(f.directory).includes(path.basename(f.choosing)), false);
  });
  for (const probe of ['alive', 'EPERM']) {
    posixTest(platform + ' verified live owner remains refused with ' + probe, async t => {
      const f = fixture(t, platform);
      await assert.rejects(locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
        processKill:() => { if (probe === 'EPERM') errorCode('EPERM'); }}),
        {code:'coordinator_already_running'});
      assert.equal(fs.readlinkSync(f.choosing), JSON.stringify(f.record));
    });
    posixTest(platform + ' unreadable identity is preserved with ' + probe, async t => {
      const f = fixture(t, platform);
      await assert.rejects(locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
        processKill:() => { if (probe === 'EPERM') errorCode('EPERM'); },
        posixIdentityReader:pid => pid===process.pid?f.options.posixIdentityReader(pid):errorCode('EACCES')}), stale(f.choosing));
      assert.equal(fs.readlinkSync(f.choosing), JSON.stringify(f.record));
    });
  }
}

for (const part of ['owner', 'ticket']) {
  posixTest('corrupt ' + part + ' is preserved with stale path guidance', async t => {
    const f = fixture(t), file = part === 'owner' ? f.choosing : f.ticket;
    f.write(file, '{broken');
    await assert.rejects(locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
      timeoutMs:100, sleep:async () => assert.fail('corruption must not enter the contention wait')}), stale(file));
    assert.equal(fs.readlinkSync(file), '{broken');
  });
}
for (const field of ['host', 'namespace']) {
  posixTest('unknown ' + field + ' is preserved, never treated as live or dead', async t => {
    const f = fixture(t);
    f.record[field] = 'different-observation-domain'; f.publish();
    await assert.rejects(locks.acquireCoordinatorProcessLockWait(f.home, f.options), stale(f.choosing));
    assert.equal(fs.readlinkSync(f.choosing), JSON.stringify(f.record));
  });
}
posixTest('coordinator acquires a verified lock released during its bounded wait', async t => {
  const f = fixture(t);
  let waits = 0, now = 0;
  const release = await locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
    timeoutMs:100, pollMs:10, now:() => now,
    sleep:async ms => { waits++; now += ms; f.clear(); }});
  release();
  assert.equal(waits, 1);
});
posixTest('coordinator wait expires without deleting a verified live owner', async t => {
  const f = fixture(t);
  let now = 0, waits = 0;
  await assert.rejects(locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
    timeoutMs:20, pollMs:10, now:() => now,
    sleep:async ms => { now += ms; waits++; }}), {code:'coordinator_already_running'});
  assert.equal(waits, 2);
  assert.equal(fs.readlinkSync(f.choosing), JSON.stringify(f.record));
});
test('coordinator executable awaits admission and reports stale-lock errors', () => {
  const source = fs.readFileSync(new URL('../bin/faravan-coordinator', import.meta.url), 'utf8');
  assert.match(source, /await acquireCoordinatorProcessLockWait\(home\)/);
  assert.match(source, /\['coordinator_already_running', 'coordinator_stale_lock', 'host_not_wanted'\]/);
});

posixTest('a corrupt ticket is preserved even when its PID is provably dead', async t => {
  const f = fixture(t);
  f.write(f.ticket, '{broken');
  await assert.rejects(locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
    processKill:() => errorCode('ESRCH')}), stale(f.ticket));
  assert.equal(fs.readlinkSync(f.ticket), '{broken');
  assert.equal(fs.readlinkSync(f.choosing), JSON.stringify(f.record));
});
posixTest('a release observed between scans is retried without deleting unknown entries', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.choosing);
  let now = 0, waits = 0;
  const release = await locks.acquireCoordinatorProcessLockWait(f.home, {...f.options,
    timeoutMs:20, pollMs:10, now:() => now, sleep:async ms => {
      assert.equal(fs.readlinkSync(f.ticket), JSON.stringify({...f.record, ticket:'1'}));
      fs.unlinkSync(f.ticket); now += ms; waits++;
    }});
  release();
  assert.equal(waits, 1);
});
posixTest('synchronous coordinator admission also reports corrupt owner as stale', t => {
  const f = fixture(t);
  f.write(f.choosing, '{broken');
  assert.throws(() => locks.acquireCoordinatorProcessLock(f.home, f.options), stale(f.choosing));
  assert.equal(fs.readlinkSync(f.choosing), '{broken');
});
