import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {clientFailure,ClientError} from '../lib/v1/client.mjs';
for(const [code,status,retryable,expected,canRetry] of [
 ['http_error',502,true,'network_error',true],['http_error',503,true,'network_error',true],
 ['http_error',429,true,'network_error',true],['network_error',0,true,'network_error',true],
 ['conflict',409,false,'conflict',false],['roster_stale',409,false,'roster_stale',false],
 ['circle_unreachable',403,false,'circle_unreachable',false],
 ['circle_unreachable',403,true,'network_error',true],
])test(`client failure classifies ${status} ${code} with retryable ${retryable}`,()=>{
 assert.deepEqual(clientFailure(new ClientError(code,{status,retryable})),{code:expected,status,retryable:canRetry});
});
test('uncoded failures have a stable fallback',()=>assert.deepEqual(clientFailure(new Error('unknown')),
 {code:'operation_failed',status:0,retryable:undefined}));
test('local update holds retain their absent HTTP retry flag',()=>assert.deepEqual(
 clientFailure({code:'update_in_progress',status:409}),{code:'update_in_progress',status:409,retryable:undefined}));
