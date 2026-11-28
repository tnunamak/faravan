import {poolFactCache} from './pool-fact-cache.mjs';
// The production registry and the production pool over a temporary registry file and an in-memory counter store. Only the
// lender worker is a stand-in, because the sandbox is not under test here: it records which account and slot it serves
// and answers an offer with the pool's own hold for that account.
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAccountRegistry} from '../../lib/v1/lending-accounts.mjs';
import {createLendingPool} from '../../lib/v1/lending-pool.mjs';
import {accountKey} from '../../lib/v1/lending-account-key.mjs';

export function createAccountChangeHarness(t,{provider='claude-code-subscription',slots=1}={}) {
  const dir=fs.mkdtempSync(join(tmpdir(),'account-change-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const registry=createAccountRegistry({file:join(dir,'accounts.json')});
  let durable=null;
  const storage={acquire:async()=>()=>{},get:async()=>structuredClone(durable),set:async value=>{durable=structuredClone(value);}};
  const family=provider.startsWith('codex')?'codex':'claude';
  const adapters=[{spec:{harness_id:provider}}];
  let pool=null,stop=null,running=null,workers=[];
  const open=()=>{
    workers=[];
    stop=new AbortController();
    pool=createLendingPool({storage,policy:{enabled:true,lendingPolicy:{accountSlots:slots,machineSlots:8}},capacity:8,adapters,
      accounts:()=>registry.list(),
      createLender:options=>{
        const facts=poolFactCache(options.policy);
        const worker={accountKey:options.accountKey,slot:options.accountSlot,
          getState:()=>({status:'waiting',current:null}),
          // The pool's own admission check for this account, with no job in the way.
          hold:()=>facts.reason,
          admits:()=>facts.reason,refreshAdmission:()=>facts.refresh(),
          start:async signal=>{await facts.refresh();if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}};
        workers.push(worker);
        return worker;
      }});
    running=pool.start(stop.signal);
  };
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  return {
    registry,family,
    add:label=>registry.add({provider:family,label}),
    keyOf:account=>accountKey(account),
    /** Opens the pool and lets it create its workers. */
    async start(){open();await settle();await settle();},
    /** Tells the running pool that the registry changed, as the app does after a settings change. */
    async changed(){pool.reconfigure();await pool.refreshAdmission();await settle();},
    /** The abrupt end of a process: workers stop, the stored rows stay. */
    async restart(){stop.abort();await running;await settle();open();await settle();await settle();},
    async close(){stop?.abort();await running;},
    workerKeys:()=>workers.map(w=>w.accountKey),
    /** The accounts whose worker would take a job now, in worker order. */
    activeKeys:()=>workers.filter(w=>w.hold()===null).map(w=>w.accountKey),
    holdOf:key=>{const worker=workers.find(w=>w.accountKey===key);return worker?worker.hold():'no_worker';},
    /** Seeds an unfinished cleanup obligation held under an account, as a crashed run leaves it. */
    keepRow(key,slot=0){durable={...(durable??{}),accounts:{...(durable?.accounts??{}),[key+'#'+slot]:{day:'2026-11-10',jobs:0,milliseconds:0}}};},
    admits:job=>pool.admits(job),
  };
}
