// Child process for crash tests. It runs one scenario against the real durable adapter and
// kills itself with SIGKILL at a named point. Every provider-facing call is appended to a
// log before it returns, so the parent can see exactly what happened before the kill.
// Usage: node pace50-crash-child.mjs <directory> <scenario> <nowMs> <logPath>
import fs from 'node:fs';
import {createPace50Adapter} from '../../lib/v1/lending-pace50-adapter.mjs';
import {ACCOUNT, ordinaryInput, request} from './pace50-fixtures.mjs';

const [directory, scenario, nowText, logPath] = process.argv.slice(2);
const at = Number(nowText);
const log = (entry) => fs.appendFileSync(logPath, JSON.stringify({proc: 'child', ...entry}) + '\n');
const die = (where) => {
  log({event: 'killed', where});
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => {});
};
const fsyncDirectory = (dir) => {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

// Filesystem faults are armed only after the store is open, so construction always succeeds.
let armed = false;
const io = {
  renameSync: (from, to) => {
    if (armed && scenario === 'kill-before-rename') return die('before-rename');
    return fs.renameSync(from, to);
  },
  fsyncDirectory: (dir) => {
    if (armed && scenario === 'kill-after-rename') return die('after-rename');
    return fsyncDirectory(dir);
  },
};

const effects = {
  arm_cessation_deadline: async (effect) => {
    log({event: 'arm', attempt: effect.attempt_id, resource: effect.resource_id});
    if (scenario === 'kill-after-persist') await die('after-persist-before-arm');
    return () => {};
  },
  launch_chunk: async (effect) => {
    log({event: 'launch', attempt: effect.attempt_id});
    if (scenario === 'kill-in-launch') await die('inside-launch');
    if (scenario === 'stop-kill-in-cancel') throw new Error('child launch refused');
  },
  open_short_window: async (effect) => { log({event: 'open', attempt: effect.attempt_id}); },
  cancel_pending_attempt: async (effect) => {
    log({event: 'cancel', attempt: effect.attempt_id, effect_id: effect.effect_id});
    if (scenario === 'stop-kill-in-cancel') await die('inside-cancel');
  },
  request_cessation: async (effect) => { log({event: 'cessation', attempt: effect.attempt_id, effect_id: effect.effect_id}); },
  request_fresh_complete_reconciliation: async (effect) => { log({event: 'reconcile', attempt: effect.attempt_id}); },
};

const adapter = createPace50Adapter({directory, account: ACCOUNT, account_week_id: 'synthetic-week-1',
  // Bind the signed request ceiling into the objective; otherwise it quotes all spare capacity.
  buildInput: async ({now, request: requested}) => {
    const input = ordinaryInput({now});
    input.objective.job.requestedUsdMicro = requested.requested_usd_micro;
    return input;
  }, effects, now: () => at, io});
armed = true;
log({event: 'opened'});

if (scenario === 'hold') {
  log({event: 'ready'});
  setInterval(() => {}, 1000);
} else {
  await adapter.admit({expectedRevision: 0, request: request()});
  if (scenario === 'stop-kill-in-cancel') {
    await adapter.transition({type: 'stop', event_id: 'stop-1', at: at + 1}, {expectedRevision: 1});
  }
  // Reaching this line means the scenario did not kill the process, which is a test failure.
  process.exitCode = 3;
}
