import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/offers-jobs-fixture.mjs';

// Both explicit and default requests are signed before publishing; a person need not type a run request.
test('the app signs the requested model and effort, and a plain send signs the lender default',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const base={circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'codex'};
  const asked=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{...base,prompt:'Use this model',model:'example-model',effort:'high'}});
  const plain=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{...base,prompt:'Use the default'}});
  const client=await owner.app.device.client(circle.id);
  assert.deepEqual((await client.getJob(asked.jobDigest)).job.payload.runRequest,{
    schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'});
  assert.deepEqual((await client.getJob(plain.jobDigest)).job.payload.runRequest,{schemaVersion:1,models:'any',effortId:null});
  for(const sent of [asked,plain])assert.equal((await api(owner.app,'/api/jobs/'+sent.jobDigest+'?circle='+encodeURIComponent(circle.id))).job_digest,sent.jobDigest);
});
