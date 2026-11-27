import './helpers/no-browser.mjs';
// Four account workers (two providers, two slots) all see the same queued job. The owner must get one review card for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';

test('one job yields one approval request, not one per provider/slot', async () => {
  let durable=null, releaseCount=0;
  const observed=[], calls=[];
  let allStarted,startedWorkers=0;
  const started=new Promise(resolve=>{allStarted=resolve;});
  const stop=new AbortController();
  const approve=details=>{calls.push(details);return false;};
  const storage={
    acquire:async()=>()=>{releaseCount++;},
    get:async()=>structuredClone(durable),
    set:async value=>{durable=structuredClone(value);},
  };
  const pool=createLendingPool({
    storage,
    policy:{enabled:true,lendingPolicy:{accountSlots:2,machineSlots:4}},
    capacity:4,
    adapters:[
      {spec:{harness_id:'claude-code-subscription'}},
      {spec:{harness_id:'codex'}},
    ],
    approve,
    createLender:options=>{
      observed.push(options);
      return {
        getState:()=>({status:'offer',current:null}),
        start(signal) {
          options.approve({jobDigest:'same-job',harness:options.adapters[0].spec.harness_id});
          if(++startedWorkers===4)allStarted();
          return new Promise(resolve=>{
            if(signal.aborted)resolve();
            else signal.addEventListener('abort',()=>resolve(),{once:true});
          });
        },
      };
    },
  });
  const running=pool.start(stop.signal);
  try {
    await started;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(new Set(calls.map(c=>c.jobDigest)).size,1);
    assert.equal(calls.length,1,'one approval request per job');
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(releaseCount,1);
});

// The answer to the one card reaches every worker: an accepted job is taken for the others, a skip is a skip for all.
for (const [name, answer, expected] of [
  ['an accepted job is taken for the other workers', true, {withdrawn: true, code: 'offer_taken'}],
  ['a skipped job is a skip for the other workers', false, false],
]) {
  test(name, async () => {
    let durable = null, release;
    const gate = new Promise(resolve => { release = resolve; });
    const answers = [], calls = [], stop = new AbortController();
    let allAsked;
    const asked = new Promise(resolve => { allAsked = resolve; });
    const pool = createLendingPool({
      storage: {acquire: async () => () => {}, get: async () => structuredClone(durable), set: async v => { durable = structuredClone(v); }},
      policy: {enabled: true, lendingPolicy: {accountSlots: 2, machineSlots: 4}}, capacity: 4,
      adapters: [{spec: {harness_id: 'claude-code-subscription'}}],
      approve: async details => { calls.push(details); await gate; return answer; },
      createLender: options => ({
        getState: () => ({status: 'offer', current: null}),
        start(signal) {
          options.approve({jobDigest: 'same-job'}).then(result => { answers.push(result); if (answers.length === 2) allAsked(); });
          return new Promise(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
        },
      }),
    });
    const running = pool.start(stop.signal);
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, 1, 'one card while the owner decides');
      release();
      await asked;
      assert.equal(calls.length, 1);
      assert.deepEqual(answers, answer === true ? [true, expected] : [false, false]);
    } finally { stop.abort(); await running; }
  });
}
