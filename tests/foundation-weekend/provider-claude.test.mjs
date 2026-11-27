// Conservative assumption: missing Claude protocol/identity ports remain unsupported.
// This guards the existing host boundary; it does NOT qualify Claude support.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostAdapter} from '../../lib/v1/providers/host-adapter.mjs';

function faultCode(result) {
 assert.equal(result?.ok,false,'missing host port must not return a successful result');
 return result.error?.code ?? result.code;
}

test('assumption: no accepted Claude ports means no dispatch, fallback, or replay, for either subject',async()=>{
 const descriptor=Object.freeze({schemaVersion:1,id:'claude'});
 const adapter=createHostAdapter({descriptor});
 assert.equal(adapter.descriptor,descriptor);
 for(const accountId of ['synthetic-subject-a','synthetic-subject-b']){
  // Ambiguous aliases and a different explicit model must all fail closed,
  // rather than silently selecting a model, effort or destination.
  for(const model of ['ambiguous-model','explicit-other-model']){
   const request={schemaVersion:1,accountId,jobId:'job-'+accountId,attemptId:'attempt-1',
    model,effort:'unsupported-effort',destination:'synthetic-destination'};
   assert.equal(faultCode(await adapter.authorizeRequest(request)),'adapter_unsupported');
   assert.equal(faultCode(await adapter.makeRun(request)),'adapter_unsupported');
   assert.equal(adapter.classifyReplay(request),'never');
  }
  assert.deepEqual(await adapter.readUsage({schemaVersion:1,accountId}),
   {kind:'unavailable',code:'adapter_unsupported'});
 }
});

test('assumption: absent enrollment binding refuses before any sign-in implementation is loaded',async()=>{
 const adapter=createHostAdapter({descriptor:{schemaVersion:1,id:'claude'}});
 for(const accountId of ['synthetic-subject-a','synthetic-subject-b']){
  assert.equal(faultCode(await adapter.beginSignIn({accountId})),'adapter_unsupported');
  assert.equal(faultCode(await adapter.finishSignIn({flowId:accountId})),'signin_expired');
  // Cancel of an unknown flow cannot create a flow or revive support.
  await adapter.cancelSignIn(accountId);
  assert.equal(faultCode(await adapter.finishSignIn({flowId:accountId})),'signin_expired');
 }
});

test('assumption: unrecognized local events do not fabricate usage or a successful run',()=>{
 const adapter=createHostAdapter({descriptor:{schemaVersion:1,id:'claude'}});
 for(const accountId of ['synthetic-subject-a','synthetic-subject-b']){
  const event={schemaVersion:1,accountId,jobId:'job-'+accountId,attemptId:'attempt-1',
   type:'unrecognized-event',usage:{input:100,output:10}};
  assert.equal(faultCode(adapter.parseJobUsage(event)),'invalid_provider_response');
  assert.equal(adapter.classifyReplay(event),'never');
 }
});
