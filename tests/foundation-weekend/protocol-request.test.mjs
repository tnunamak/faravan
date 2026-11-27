import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalize, strictParse, digest} from '../../lib/protocol/encoding.mjs';

// Encoding boundary only: these fixtures are not schema-approved signed jobs.
// Submission, capability negotiation and unsupported-effort validation remain
// blocked on the frozen job schema/capability contract outside this scope.
test('encoding preserves explicit runRequest values and ordered model alternatives', () => {
  const runRequest = {schemaVersion:1, models:[
    {providerId:'synthetic-provider-b',modelId:'model-b'},
    {providerId:'synthetic-provider-a',modelId:'model-a'},
  ], effortId:null};
  const payload = {runRequest};
  const encoded = canonicalize(payload);
  const replayed = strictParse(Buffer.from(encoded));
  assert.deepEqual(replayed, payload);
  assert.equal(canonicalize(replayed), encoded);
  assert.equal(digest(replayed), digest(payload));
  const reordered = structuredClone(payload);
  reordered.runRequest.models.reverse();
  assert.notEqual(digest(reordered), digest(payload));
  const changedEffort = structuredClone(payload);
  changedEffort.runRequest.effortId = 'synthetic-effort';
  assert.notEqual(digest(changedEffort), digest(payload));
  assert.equal(payload.runRequest.effortId, null);
});

test('any is retained exactly and is not rewritten to an explicit model list', () => {
  const payload = {runRequest:{schemaVersion:1,models:'any',effortId:null}};
  assert.deepEqual(strictParse(canonicalize(payload)),payload);
  assert.notEqual(digest(payload),digest({runRequest:{
    schemaVersion:1,models:[{providerId:'synthetic-provider',modelId:'model'}],effortId:null,
  }}));
});

test('duplicate runRequest fields cannot acquire canonical replay meaning', () => {
  assert.throws(()=>strictParse(
    '{"runRequest":{"schemaVersion":1,"models":"any","models":[],"effortId":null}}',
    {canonical:false}), {code:'duplicate_key'});
});
