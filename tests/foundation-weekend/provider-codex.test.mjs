// Partial Codex enrollment-boundary regression, not subscription support qualification.
// Only pure exported validation runs; no sign-in, HTTP, filesystem or native store call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {codexRedirectRequest,deviceVerificationLink,deviceFailureReason}
 from '../../lib/provider-generation-auth.mjs';

const providerURL=(state,port)=>'https://auth.openai.com/authorize?'+new URLSearchParams({
 redirect_uri:'http://localhost:'+port+'/callback',state});
const pasted=(state,port,extra='')=>'http://127.0.0.1:'+port+'/callback?'+new URLSearchParams({
 code:'synthetic-code',state})+extra;

test('two independent browser flow states cannot complete each other',()=>{
 const first=providerURL('synthetic-state-a',40001),second=providerURL('synthetic-state-b',40002);
 for(const [url,state,port] of [[first,'synthetic-state-a',40001],[second,'synthetic-state-b',40002]]){
  const request=codexRedirectRequest(url,pasted(state,port,'&unexpected=discard-me'));
  assert.equal(request.port,port);
  const callback=new URL(request.path,'http://localhost');
  assert.equal(callback.pathname,'/callback');
  assert.deepEqual([...callback.searchParams.keys()],['code','state']);
  assert.equal(callback.searchParams.get('state'),state);
  assert.equal(callback.searchParams.get('code'),'synthetic-code');
 }
 for(const [url,callback] of [[first,pasted('synthetic-state-b',40002)],[second,pasted('synthetic-state-a',40001)],
  [first,pasted('synthetic-state-b',40001)],[first,pasted('synthetic-state-a',40002)]]){
  assert.throws(()=>codexRedirectRequest(url,callback),{code:'signin_redirect_mismatch'});
 }
});

test('browser completion refuses duplicate parameters and nonmatching destination without exposing callback data',()=>{
 const url=providerURL('synthetic-state',40003),valid=pasted('synthetic-state',40003);
 for(const callback of [valid+'&code=second',valid+'&state=synthetic-state',
  valid.replace('/callback?','/other?'),valid.replace('127.0.0.1','outside.invalid'),
  valid.replace('http:','https:'),'not-a-url']){
  let caught;
  try{codexRedirectRequest(url,callback);}catch(error){caught=error;}
  assert.ok(caught,'invalid callback must fail');
  assert.equal(caught.code,'signin_redirect_mismatch');
  assert.doesNotMatch(caught.message,/synthetic-code|synthetic-state|outside\.invalid/);
 }
});

test('device failure classes remain separate and device presentation accepts only the fixed verification URL',()=>{
 for(const [input,expected] of [
  ['device code request failed with status 401','codex_device_code_unavailable'],
  ['device code request failed with status 403','codex_device_code_unavailable'],
  ['device code request failed with status 429','codex_device_code_rate_limited'],
  ['device code request failed with status 503','codex_device_code_service_unavailable'],
  ['device code exchange failed','codex_device_code_exchange_failed'],
  ['device code expired','codex_device_code_expired'],
  ['ordinary unrelated output',null],
 ])assert.equal(deviceFailureReason(input),expected);
 assert.equal(deviceVerificationLink(new URL('https://auth.openai.com/codex/device')),'https://auth.openai.com/codex/device');
 for(const value of ['http://auth.openai.com/codex/device','https://outside.invalid/codex/device',
  'https://auth.openai.com/codex/device?code=synthetic','https://auth.openai.com/codex/device#fragment',
  'https://auth.openai.com:444/codex/device','https://auth.openai.com/other',
  'https://synthetic-user@auth.openai.com/codex/device']){
  assert.equal(deviceVerificationLink(new URL(value)),null);
 }
});
