import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {observeLenderClient,createTelemetryFacts} from '../lib/v1/telemetry-facts.mjs';

test('lender completion reports executed model from the result and preserves client behavior',async()=>{
  const rows=[];const facts=createTelemetryFacts({telemetry:{observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  const attempt={attempt_id:'local-only',job_digest:'private-job'};
  const client={marker:'private',claimJob:async()=>({attempt,job:{payload:{requirements:{harness:['codex'],model:{any_of:['gpt-5.4']}},budget_v1:{effort:'high'}}}}),
    async completeAttempt(a,p){assert.equal(this.marker,'private');assert.equal(a,attempt);return p;}};
  const observed=observeLenderClient(client,facts);await observed.claimJob();
  const payload={receipt:{model:'gpt-5.4-mini',harness:'codex',duration_ms:20},prompt:'private',job_digest:'private'};
  assert.equal(await observed.completeAttempt(attempt,payload),payload);
  facts.drain();
  assert.equal(rows[0].p.executed_model,'gpt-5.4-mini');assert.equal(rows[0].p.requested_model,'gpt-5.4');assert.equal(rows[0].p.requested_effort,'high');assert.equal(rows[0].p.role,'lender');
  assert.ok(!JSON.stringify(rows).includes('private'));await observed.completeAttempt(attempt,payload);assert.equal(rows.length,1);
});
test('failed protocol writes emit no completion and a throwing observer actually runs after success',async()=>{
  const error=Error('private');let fails=true,observed=0;const attempt={attempt_id:'a'};
  const facts=createTelemetryFacts({telemetry:{observeFact:()=>{observed++;throw error;}}});
  const observedClient=observeLenderClient({claimJob:async()=>({attempt,job:{payload:{requirements:{harness:['codex']}}}}),completeAttempt:async()=>{if(fails)throw error;return 'ok';}},facts);
  await observedClient.claimJob();await assert.rejects(observedClient.completeAttempt(attempt,{}),e=>e===error);facts.drain();assert.equal(observed,0);
  fails=false;assert.equal(await observedClient.completeAttempt(attempt,{}),'ok');facts.drain();assert.equal(observed,1);
});

for(const method of ['completeAttempt','fail','release'])test('lender '+method+' pending across reset cannot publish old evidence',async()=>{
  let generation=1,finish;const rows=[];
  const facts=createTelemetryFacts({telemetry:{bootstrap:()=>({remoteEnabled:true,generation}),observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  const attempt={attempt_id:'a'};const observed=observeLenderClient({claimJob:async()=>({attempt,job:{payload:{requirements:{harness:['codex']}}}}),[method]:async()=>new Promise(resolve=>{finish=resolve;})},facts);
  await observed.claimJob();const pending=observed[method](attempt,{receipt:{model:'gpt-5.4'}});
  generation++;finish('ok');assert.equal(await pending,'ok');facts.drain();assert.equal(rows.length,0);
});
