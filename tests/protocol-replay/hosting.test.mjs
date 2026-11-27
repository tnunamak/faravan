// Replays of TLC traces from spec/tla/Hosting.tla against the real hosting code of
// fix/hosting-home-1101 (2b9c305d): resumeWantedHost, hostV1, stopV1Host and the host lock.
// Fakes stand in only for processes and network: the coordinator process (startServer,
// waitReady) and the device's coordinator calls (publishRoster, createInviteLinks).
// On a tree without lib/v1/host-intent.mjs (before that branch lands) the tests skip.
import '../helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hostingCode = existsSync(new URL('../../lib/v1/host-intent.mjs', import.meta.url));
const skip = hostingCode ? false : 'needs the hosting code of fix/hosting-home-1101 (2b9c305d)';
const origin = 'http://10.23.4.10:8787', root = 'sha256:' + 'a'.repeat(64);

async function wantedHost(t) {
  const dir = await mkdtemp(join(tmpdir(), 'protocol-replay-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'coordinator');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'host.json'), JSON.stringify({ schema_version: 1, protocol_version: 1, port: 8787,
    status_path: join(home, 'status.json'), data_dir: join(home, 'data'), circle_id: 'c1', circle_ids: ['c1'],
    root_fingerprint: root, v1_origin: origin, reachability:{kind:'lan',publicUrl:origin}, host_wanted: true }));
  return home;
}

// `faravan host` as the app runs it: the args the app spawns (resumeArgs) become the CLI's resume option, as in
// bin/faravan (cmdHostV1). Real hostV1, with a fake coordinator process and fake coordinator calls.
function hostLaunch(home, coordinators) {
  return async args => {
    const { hostV1 } = await import('../../lib/v1/host.mjs');
    const [flag, generation] = args;
    assert.equal(flag, '--resume');
    const resume = { stopGeneration: generation === 'initial' ? null : generation };
    const circle = { id: 'c1', origin, pinnedRootFingerprint: root };
    return hostV1({ home, resume }, {
      openDevice: async () => ({ selectCircle: () => circle, publishRoster: async () => {},
        createInviteLinks: async () => ({ short: 'invite' }) }),
      provision:async()=>{},portInUse:async()=>false,
      networkInterfaces:()=>({lan:[{family:'IPv4',address:'10.23.4.10',internal:false}]}),
      startServer: async () => { coordinators.push('started'); return { stop: async () => {} }; },
      waitReady: async () => ({ protocol_version: 1, status: 'public_listening', public_url: origin }),
    });
  };
}

const ownerStop = async home => {
  const { stopV1Host } = await import('../../lib/v1/host.mjs');
  // The real CLI passes these port probes; nothing listens here, so the port is quiet.
  return stopV1Host({ home }, { clearIntent: true, sleep: async () => {}, portAnswers: async () => false, portListeners: async () => [] });
};

// TLC: Hosting_h1.cfg, invariant H1_StopSticks. The commit says the owner's stop "clears it before
// stopping, so a failed stop does not bring the host back later". A start the app decided on before
// the stop, which takes the host lock after it, must not run: the resume carries the stop generation it
// was planned under, and hostV1 refuses under the host lock (assertResumable). Shipped code fixes H1, so this passes.
test('H1: a resume spawned before the owner\'s stop does not start the host after the stop reported success', { skip }, async t => {
  const home = await wantedHost(t);
  const { resumeWantedHost } = await import('../../lib/v1/host-intent.mjs');
  const coordinators = [];
  // 1. App start: host_wanted, no coordinator running, so the app spawns `faravan host --resume initial`. The
  //    spawned process has not yet taken the host lock (node start-up, B1).
  let launch;
  const spawned = new Promise(resolve => { launch = resolve; });
  const resumed = resumeWantedHost({ coordinatorHome: home, start: args => spawned.then(run => run(args)) });
  // 2. The owner presses Stop hosting. The stop takes the lock, clears host_wanted, finds nothing
  //    running and a quiet port, and reports success.
  await ownerStop(home);
  assert.equal(JSON.parse(await readFile(join(home, 'host.json'), 'utf8')).host_wanted, false);
  // 3. The spawned `faravan host` now takes the lock and starts the coordinator.
  launch(hostLaunch(home, coordinators));
  await resumed;
  const after = JSON.parse(await readFile(join(home, 'host.json'), 'utf8'));
  assert.deepEqual({ coordinatorsStarted: coordinators.length, hostWanted: after.host_wanted },
    { coordinatorsStarted: 0, hostWanted: false }, 'after the owner\'s stop succeeded, a host started and is wanted again');
  assert.equal((await resumed).reason, 'not_wanted');
});

// TLC: Hosting_h4.cfg, property H4_Comes_Back. The app resumes a wanted host once per start. A host
// lock held by another operation used to fail that resume at once (acquireProcessLock, 250 ms), and when that
// operation then failed too, the wanted host stayed down until the next app start. A resume now waits for the
// lock up to the waitReady budget, then runs its normal under-lock checks.
test('H4: a wanted host comes back when the app starts while another host operation holds the lock', { skip }, async t => {
  const home = await wantedHost(t);
  const { resumeWantedHost } = await import('../../lib/v1/host-intent.mjs');
  const { acquireProcessLock } = await import('../../lib/v1/lock.mjs');
  const coordinators = [];
  // 1. A `faravan host` from before the app restart still holds the lock (its coordinator crashed; it
  //    will fail in waitReady). It fails and frees the lock 1 s later, after the old 250 ms wait has given up.
  const release = await acquireProcessLock(join(home, 'host-v1'));
  setTimeout(release, 1000);
  // 2. The app starts: host_wanted and nothing running, so it resumes and waits for the lock.
  const outcome = await resumeWantedHost({ coordinatorHome: home, start: hostLaunch(home, coordinators) })
    .then(result => result.reason, error => 'refused: ' + error.message);
  assert.equal(outcome, 'started', 'the resume refused instead of waiting for the lock');
  assert.equal(JSON.parse(await readFile(join(home, 'host.json'), 'utf8')).host_wanted, true);
  assert.equal(coordinators.length, 1, 'the wanted host did not come back after the app start');
});

// Guard, passes before and after the fix: an owner's stop that holds the lock while the resume waits wins.
// The resume gets the lock after the stop has cleared host_wanted, and its under-lock check refuses.
test('H4 guard: an owner\'s stop that runs while the resume waits for the lock still wins', { skip }, async t => {
  const home = await wantedHost(t);
  const { resumeWantedHost } = await import('../../lib/v1/host-intent.mjs');
  const { acquireProcessLock } = await import('../../lib/v1/lock.mjs');
  const coordinators = [];
  const stop = await acquireProcessLock(join(home, 'host-v1'));
  const resumed = resumeWantedHost({ coordinatorHome: home, start: hostLaunch(home, coordinators) });
  // The owner's stop saves its generation and host_wanted:false under the lock, then frees it.
  const config = JSON.parse(await readFile(join(home, 'host.json'), 'utf8'));
  await writeFile(join(home, 'host.json'), JSON.stringify({ ...config, host_wanted: false, stop_generation: 'stopped-1' }));
  stop();
  assert.deepEqual(await resumed, { resumed: false, reason: 'not_wanted' });
  assert.equal(coordinators.length, 0, 'a host started after the owner stopped it');
});
