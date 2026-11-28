import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {access, rm} from 'node:fs/promises';
import {createLender} from '../lib/v1/lender.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';

// "Cheapest that fits" and "Strongest offered": the lender chooses one exact pair before pricing the job, keeps it with the
// claim, and runs, prices and reports that same pair. These tests use the real store, client and lender with a fake sandbox.

function launch(t, f, approve = async () => true, c = new AbortController(), controls = {}) {
  const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock, approve, onEvent: e => f.events.push(e)});
  const timers = controls.timers ?? {setTimeout, clearTimeout};
  let outcome;
  const settled = (controls.start ? controls.start(c.signal) : lender.start(c.signal)).then(
    () => (outcome = {ok: true}),
    error => (outcome = {ok: false, error, expected: c.signal.aborted && error === c.signal.reason}));
  f.assertLoopHealthy = () => {
    if (outcome && !outcome.ok && !outcome.expected) throw outcome.error;
  };
  let stopping;
  f.stop = () => stopping ??= (async () => {
    c.abort();
    let watchdog;
    try {
      const outcome = await Promise.race([settled, new Promise((_, reject) => {
        watchdog = timers.setTimeout(() => reject(new Error('auto-run lender did not settle after abort')), 2000);
      })]);
      if (!outcome.ok && !outcome.expected) throw outcome.error;
    } finally { timers.clearTimeout(watchdog); }
  })();
  return {stop: f.stop, reconfigure: () => lender.reconfigure()};
}
async function waitFor(f, check, label, ms = 20000) {
  await until(() => {f.assertLoopHealthy?.(); return check();}, label, ms);
  f.assertLoopHealthy?.();
}

// The result goes through the real host, which checks the receipt against the signed job before it accepts it.

// A later price change makes a re-choice differ: after this, luna is no longer the cheapest model on offer.

for (const fault of ['stop failure', 'loop rejection', 'expected abort', 'missing abort', 'unsettled loop']) {
  test('actual auto-run teardown negative control: '+fault, {timeout:30000}, async t=>{
    const callbacks=[], runs=new Map();
    let f, releaseLoop, resources, originals, controller, controlledLoop, outerGuard, abortOwned;
    let rescued=false, suppressedAborts=0;
    const missingAbort=new Error('auto-run teardown did not cooperatively abort its controlled loop');
    const pending=new Map(), cleared=[];
    const timers={
      setTimeout(fn,ms){assert.equal(ms,2000);const key={};pending.set(key,fn);return key;},
      clearTimeout(key){cleared.push(key);pending.delete(key);},
    };
    const invoke=fn=>{
      if(!runs.has(fn))runs.set(fn,Promise.resolve().then(fn));
      return runs.get(fn);
    };
    const drain=async()=> {
      const results=[];
      for(const fn of [...callbacks].reverse()){
        try{await invoke(fn);results.push({ok:true});}
        catch(error){results.push({error});}
      }
      return results;
    };
    try {
      f=await realLenderFixture({after:fn=>callbacks.push(fn)},{publish:false,exposeTeardown:true});
      resources=f.teardownResources;
      const counts={handler:0,connections:0,server:0,store:0};
      originals={
        handler:resources.handler.close.bind(resources.handler),
        connections:resources.server.closeAllConnections.bind(resources.server),
        server:resources.server.close.bind(resources.server),
        store:f.store.close.bind(f.store),
      };
      resources.handler.close=(...args)=>{counts.handler++;return originals.handler(...args);};
      resources.server.closeAllConnections=(...args)=>{counts.connections++;return originals.connections(...args);};
      resources.server.close=(...args)=>{counts.server++;return originals.server(...args);};
      f.store.close=(...args)=>{counts.store++;return originals.store(...args);};
      const sentinel=new Error('owned teardown sentinel: '+fault);
      if(fault==='stop failure')f.stop=async()=>{throw sentinel;};
      else {
        controller=new AbortController();
        abortOwned=controller.abort.bind(controller);
        if(fault==='missing abort'){
          // Mutation of the actual launch.stop cancellation, not a copied cleanup.
          controller.abort=()=>{suppressedAborts++;};
        }
        const start=signal=>controlledLoop=(fault==='loop rejection'?Promise.reject(sentinel):
          fault==='unsettled loop'?new Promise(resolve=>{releaseLoop=resolve;}):
          new Promise((_,reject)=>{
            releaseLoop=reject;
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
          }));
        launch(t,f,async()=>true,controller,{start,timers});
        // Let the settled-loop observer publish its own outcome, not a later timeout.
        await Promise.resolve();
        if(fault==='loop rejection')
          await assert.rejects(waitFor(f,()=>true,'must not wait'),error=>error===sentinel);
      }
      if(fault==='expected abort'||fault==='missing abort'){
        // This real timer is independent of the intentionally inert stop watchdog.
        // Install rescue BEFORE drain can wait; settling the owned loop lets the
        // actual registered callbacks dispose handler/server/store/directories.
        outerGuard=setTimeout(()=>{rescued=true;releaseLoop(missingAbort);},500);
        const disarm=()=>clearTimeout(outerGuard);
        controlledLoop.then(disarm,disarm);
      }
      const cleanup=drain();
      if(fault==='unsettled loop'){
        // No global timer mock or wall-clock sleep: fire the actual stop watchdog.
        for(let turn=0;turn<20&&!pending.size;turn++)await Promise.resolve();
        assert.equal(pending.size,1,'teardown reached its bounded watchdog');
        [...pending.values()][0]();
      }
      const results=await cleanup;
      assert.deepEqual(counts,{handler:1,connections:1,server:1,store:1},
        'each counter delegates to the real resource close');
      assert.equal(resources.server.listening,false);
      await assert.rejects(access(resources.dir),{code:'ENOENT'});
      await assert.rejects(access(f.root),{code:'ENOENT'});
      assert.equal(pending.size,0);
      if(fault!=='stop failure')assert.equal(cleared.length,1,'watchdog cleared on success or rejection');
      if(fault==='expected abort'){
        assert.equal(rescued,false,'ordinary expected abort must settle without outer rescue');
        assert.equal(controller.signal.aborted,true,'ordinary stop actually aborted the owned controller');
        assert.equal(results.length,2);
        assert.ok(results.every(result=>result.ok),'cooperative abort, not a later watchdog, is success');
      } else if(fault==='missing abort'){
        assert.equal(suppressedAborts,1,'the real memoized stop attempted cancellation');
        assert.equal(controller.signal.aborted,false,'negative control suppressed cancellation');
        assert.equal(rescued,true,'independent real guard bounded the missing-abort observer');
        assert.equal(results.length,2);
        for(const result of results)assert.equal(result.error,missingAbort,
          'both actual cleanup callbacks preserve the specific missing-abort failure');
      } else if(fault==='unsettled loop'){
        assert.equal(results.length,2);
        for(const result of results)assert.match(result.error?.message??'',/auto-run lender did not settle after abort/);
        assert.equal(results[0].error,results[1].error,'memoized stop keeps the original watchdog failure');
      } else {
        assert.equal(results.length,2);
        for(const result of results)assert.equal(result.error,sentinel,'original failure, not a later timeout');
      }
    } finally {
      clearTimeout(outerGuard);
      abortOwned?.();
      releaseLoop?.(missingAbort);
      await controlledLoop?.catch(()=>{});
      // Clear only our scoped watchdogs, then always run every captured callback.
      for(const key of [...pending.keys()])timers.clearTimeout(key);
      if(f)f.stop=async()=>{};
      await drain();
      // Independent rescue for deliberately broken fail-fast cleanup or a failed assertion.
      // These are only fixture-owned resources; successful assertions happened before rescue.
      if(resources){
        await Promise.allSettled([
          Promise.resolve().then(()=>originals?.handler()),
          Promise.resolve().then(()=>originals?.connections()),
          Promise.resolve().then(()=>resources.server.listening?
            new Promise((resolve,reject)=>originals.server(error=>error?reject(error):resolve())):undefined),
          Promise.resolve().then(()=>originals?.store()),
        ]);
        await rm(resources.dir,{recursive:true,force:true});
      }
      if(f)await rm(f.root,{recursive:true,force:true});
    }
  });
}
