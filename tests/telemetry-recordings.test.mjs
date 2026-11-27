import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConsent} from '../lib/v1/telemetry/consent.mjs';
import {TELEMETRY_COPY} from '../lib/v1/telemetry/copy.mjs';
import {stoppedBootstrap} from '../lib/v1/telemetry/contract.mjs';

const make=(policy)=>{
 const dir=mkdtempSync(join(tmpdir(),'recordings-'));
 if(policy)writeFileSync(join(dir,'policy.json'),JSON.stringify(policy));
 return {dir,consent:createConsent({dir,base:dir,uploadable:true,env:{}}),done:()=>rmSync(dir,{recursive:true,force:true})};
};
test('recordings are off by default and an upgrade from a saved On leaves them off',()=>{
 for(const policy of [null,{version:2,level:'on',region:'US',generation:8,noticeShownAt:1,decidedAt:1},{version:2,level:'on',region:'US',generation:8,noticeShownAt:1,decidedAt:1,allowance:true}]){
  const f=make(policy);
  try{assert.equal(f.consent.current().recordings,false);}finally{f.done();}
 }
 assert.equal(stoppedBootstrap().recordings,false);
});
test('turning recordings on needs reports On; Off clears the choice and On later does not restore it',()=>{
 const f=make({version:2,level:'on',region:'US',generation:1,noticeShownAt:1,decidedAt:1});
 try{
  f.consent.choose({recordings:true});
  assert.equal(f.consent.current().recordings,true);
  assert.equal(f.consent.current().level,'on','the reports choice is untouched');
  f.consent.choose({recordings:false});
  assert.equal(f.consent.current().recordings,false);
  f.consent.choose({recordings:true});
  f.consent.choose({level:'off'});f.consent.completePurge();
  assert.equal(f.consent.current().recordings,false);
  assert.throws(()=>f.consent.choose({recordings:true}),/invalid_request/,'cannot record while reports are off');
  f.consent.choose({level:'on'});
  assert.equal(f.consent.current().recordings,false,'On again does not bring recordings back');
  f.consent.choose({recordings:true});
  f.consent.restrict();f.consent.completePurge();
  assert.equal(f.consent.current().recordings,false,'Off from any surface stops recordings');
  assert.throws(()=>f.consent.choose({recordings:'yes'}),/invalid_request/);
  assert.throws(()=>f.consent.choose({recordings:true,level:'on'}),/invalid_request/);
 }finally{f.done();}
});
test('the notice and privacy copy no longer say recordings are on by default',()=>{
 assert.doesNotMatch(TELEMETRY_COPY.firstRun.body,/record/i);
 assert.doesNotMatch(TELEMETRY_COPY.settings.choices[0].detail,/record/i);
 assert.match(TELEMETRY_COPY.settings.recordings.label,/Also send screen recordings \(text and inputs hidden\)/);
 assert.match(TELEMETRY_COPY.privacyDetails.join(' '),/off unless you turn them on/);
});
