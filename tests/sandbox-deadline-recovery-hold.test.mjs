import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {CESSATION_FIX, deadlineRecoveryHold, deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';

const privateText='/Users/private-owner/secret-home token=secret-token sbx rm --force private-name';

test('deadline holds and errors contain only fixed safe metadata and a validated count',()=>{
  const original=Object.assign(new Error(privateText),{code:privateText,stderr:privateText});
  const hold=deadlineRecoveryHold(original,{rowCount:44,platformName:'darwin'});
  assert.equal(hold.cause_code,'deadline_recovery_failed');
  assert.equal(hold.error_code,'unknown');
  assert.equal(hold.row_count,44);
  assert.match(hold.message,/44/);
  assert.deepEqual(hold.fix,CESSATION_FIX);
  assert.equal(Object.isFrozen(hold),true);
  assert.equal(Object.isFrozen(hold.fix),true);
  const error=deadlineRecoveryError(hold,{cause:original});
  assert.equal(error.code,'cessation_unverified');
  assert.equal(error.probe_failure,'cessation_unverified');
  assert.equal(error.retryable,true);
  assert.equal(error.cause,original);
  assert.equal(Object.getOwnPropertyDescriptor(error,'cause').enumerable,false);
  assert.equal(error.recovery_hold,hold);
  assert.equal(error.message,hold.message);
  assert.equal(JSON.stringify({hold,error}).includes(privateText),false);
});

test('counts never coerce strings or retain unsafe numbers',()=>{
  for(const value of [null,undefined,'44',-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,{},()=>44])
    assert.equal(deadlineRecoveryHold(false,{rowCount:value}).row_count,null);
  for(const value of [0,1,44,Number.MAX_SAFE_INTEGER])
    assert.equal(deadlineRecoveryHold(false,{rowCount:value}).row_count,value);
  assert.equal(deadlineRecoveryHold(false).error_code,'recovery_incomplete');
});

test('the fixed host sleep phrase gets platform-specific copy without executor output',()=>{
  for(const platformName of ['darwin','linux','win32']){
    const hold=deadlineRecoveryHold({stderr:privateText+' THE HOST IS NOT FULLY AWAKE '+privateText},{rowCount:44,platformName});
    assert.equal(hold.cause_code,'host_not_awake');
    assert.equal(hold.error_code,'host_not_awake');
    assert.ok(hold.message.startsWith(platformName==='darwin'
      ? 'Your Mac is asleep (lid closed). Open it to lend.'
      : 'This computer is asleep. Wake it to lend.'));
    assert.equal(JSON.stringify(hold).includes(privateText),false);
  }
  assert.equal(deadlineRecoveryHold(new Error('the host is not fully awake')).cause_code,'host_not_awake');
  assert.equal(deadlineRecoveryHold({stdout:'the host is not fully awake'}).cause_code,'deadline_recovery_failed');
});

test('only enumerated error codes survive, including the unchanged sign-in refusal class',()=>{
  for(const code of ['EACCES','ENOENT','ABORT_ERR','lock_busy','daemon_owner_repair_required','docker_signin_refresh_unavailable'])
    assert.equal(deadlineRecoveryHold({code}).error_code,code);
  for(const code of ['SECRET_TOKEN_123','invented_safe_looking_code',privateText,1,null])
    assert.equal(deadlineRecoveryHold({code}).error_code,'unknown');
});

test('copied or untrusted hold messages and fixes are rebuilt from safe classes',()=>{
  const error=deadlineRecoveryError({cause_code:'host_not_awake',error_code:privateText,row_count:'44',message:privateText,fix:{human:privateText}});
  assert.equal(error.code,'cessation_unverified');
  assert.equal(error.recovery_hold.row_count,null);
  assert.equal(error.recovery_hold.error_code,'host_not_awake');
  assert.deepEqual(error.fix,CESSATION_FIX);
  assert.equal(JSON.stringify(error).includes(privateText),false);
  const mac=deadlineRecoveryHold({code:'host_not_awake'},{platformName:'darwin',rowCount:44});
  assert.equal(deadlineRecoveryError({...mac}).message,mac.message);
});

test('hostile diagnostic getters do not replace the recovery blocker',()=>{
  const value={};
  for(const key of ['code','error_code','errorCode','status','cause_code','recovery_hold','message','stderr'])
    Object.defineProperty(value,key,{get(){throw Error(privateText);}});
  assert.equal(deadlineRecoveryHold(value).error_code,'unknown');
  assert.equal(deadlineRecoveryError(value).code,'cessation_unverified');
});


test('re-normalizing a safe hold preserves its fixed platform copy unless explicitly overridden',()=>{
  const mac=deadlineRecoveryHold({code:'host_not_awake'},{platformName:'darwin',rowCount:44});
  assert.equal(deadlineRecoveryHold(mac,{rowCount:44}).message,mac.message);
  assert.equal(deadlineRecoveryHold(deadlineRecoveryError(mac),{rowCount:44}).message,mac.message);
  assert.match(deadlineRecoveryHold(mac,{rowCount:44,platformName:'linux'}).message,/^This computer is asleep/);
});


test('safe daemon owner status survives the sbx result envelope',()=>{
  assert.equal(deadlineRecoveryHold({code:1,errorCode:'SBX_DAEMON_UNVERIFIED',status:'daemon_owner_repair_required',stderr:privateText}).error_code,'daemon_owner_repair_required');
  assert.equal(deadlineRecoveryHold({code:1,errorCode:'sbx_daemon_unavailable',stderr:privateText}).error_code,'sbx_daemon_unavailable');
  assert.equal(deadlineRecoveryHold({code:1,status:privateText,errorCode:privateText}).error_code,'unknown');
});
