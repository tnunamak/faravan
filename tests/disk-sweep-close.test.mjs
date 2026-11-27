import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSweepScheduler, PRESSURE_CHECK_MS} from '../lib/disk-sweep-schedule.mjs';
import {createDiskSweeper} from '../lib/disk-sweep.mjs';
import {createDiskLedger} from '../lib/disk-ledger.mjs';
import {createNotificationFeed, notificationSettings} from '../lib/v1/notifications.mjs';

const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const settle = () => new Promise(r => setImmediate(r));
for (const trigger of ['startup', 'pressure']) test(`${trigger} free-space callback is drained and cannot notify after stop`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-stop-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const feed = await createNotificationFeed(dir);
  const pending = deferred(), entered = deferred();
  const timers = new Map(); let reads = 0, summaries = 0;
  const scheduler = createSweepScheduler({ready:Promise.resolve(), random:()=>0.5,
    timers:{setTimeout:(fn,ms)=>{timers.set(ms,fn); return ms;},clearTimeout:ms=>timers.delete(ms)},
    sweeper:{run:async()=>({errors:[]})}, onSummary:()=>summaries++,
    hostFree:()=>{if (++reads === (trigger === 'startup' ? 1 : 2)) {entered.resolve(); return pending.promise;} return Promise.resolve(2 ** 40);},
    onFree:free=>{if(free < 10 * 1024 ** 3) feed.diskWarning(warning,notificationSettings());},
  });
  // Use the same durable notification producer as the app, with a known low-space warning.
  const warning = {kind:'disk_space_low',free_bytes:1,by_kind:{},could_free_bytes:null};
  let notifications = 0;
  const original = feed.diskWarning.bind(feed);
  feed.diskWarning = (...args) => {notifications++; return original(warning,...args.slice(1));};
  scheduler.start();
  if(trigger === 'pressure') {await settle(); timers.get(PRESSURE_CHECK_MS)();}
  await entered.promise;
  let stopped=false;
  const stopping=scheduler.stop().then(()=>{stopped=true;});
  await settle();
  const drainedBeforeReadEnded=stopped;
  await feed.settled();
  pending.resolve(1);
  await stopping; await settle(); await feed.settled();
  assert.equal(notifications,0,'no durable notification producer after cancellation');
  assert.equal(drainedBeforeReadEnded,false,'stop drains the active free-space callback');
  assert.equal(summaries,1);
});

for (const trigger of ['startup','timer','pressure','doctor']) test(`${trigger} cache reconciliation cannot write after abort or the close deadline`, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'disk-abort-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'cache');fs.mkdirSync(root);
  const ledger=createDiskLedger({file:path.join(dir,'v1','disk-ledger.json')});
  const entered=deferred(), pending=deferred();
  const read=fs.promises.opendir.bind(fs.promises);
  t.mock.method(fs.promises,'opendir',async (...args)=>{if(args[0]===root){entered.resolve();await pending.promise;}return read(...args);});
  const sweeper=createDiskSweeper({ledger,runSbx:async()=>({code:0,stdout:'[]'}),journal:{recorded:()=>false},pins:()=>[],referenced:()=>new Set(),caches:{root},measureFree:async()=>2**40});
  const run=sweeper.run({trigger});
  await entered.promise;
  sweeper.abort();
  // A bounded close may return while an uncancellable filesystem read is still pending.
  const file=ledger.file ?? path.join(dir,'v1','disk-ledger.json');
  const before=fs.readFileSync(file,'utf8');
  const writes=[];
  for(const name of ['disownMissing','recordSweep','adoptCaches']) if(typeof ledger[name]==='function') {
    const original=ledger[name].bind(ledger);
    t.mock.method(ledger,name,(...args)=>{writes.push(name);return original(...args);});
  }
  await settle();
  pending.resolve();
  assert.equal((await run).aborted,true);
  assert.deepEqual(writes,[],'late read must not initiate a ledger update');
  assert.equal(fs.readFileSync(file,'utf8'),before);
});
