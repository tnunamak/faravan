import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRequestAdmission,validateRequestAdmission} from '../lib/v1/request-admission.mjs';

const usage={jobs:2,jobLimit:3,minutes:40,minuteLimit:60};

test('request admission allows exact accounted-millisecond fit at the signed wall-seconds boundary',()=>{
 const projection=projectRequestAdmission({usage,accountedMilliseconds:30*60000,dailyMinutes:60,wallSeconds:30*60});
 assert.equal(projection.admission,'allowed');assert.equal(projection.reasonCode,null);
 assert.equal(projection.evidence.minuteCap.requestedMilliseconds,30*60000);
});

test('request admission distinguishes reached caps from a request that does not fit',()=>{
 const job=projectRequestAdmission({usage:{...usage,jobs:3},accountedMilliseconds:0,dailyMinutes:60,wallSeconds:1});
 assert.equal(job.admission,'blocked');assert.equal(job.reasonCode,'job_cap');
 const reached=projectRequestAdmission({usage:{...usage,minutes:60},accountedMilliseconds:0,dailyMinutes:60,wallSeconds:0});
 assert.equal(reached.reasonCode,'minute_cap_reached');
 const fit=projectRequestAdmission({usage,accountedMilliseconds:30*60000+1,dailyMinutes:60,wallSeconds:30*60});
 assert.equal(fit.reasonCode,'request_does_not_fit');
});

test('request admission preserves the exact millisecond boundary despite displayed minute rounding',()=>{
 const fit=projectRequestAdmission({usage,accountedMilliseconds:30*60000-1,dailyMinutes:60,wallSeconds:30*60});
 const over=projectRequestAdmission({usage,accountedMilliseconds:30*60000+1,dailyMinutes:60,wallSeconds:30*60});
 assert.equal(fit.admission,'allowed');assert.equal(over.reasonCode,'request_does_not_fit');
});

test('null daily caps mean no job or minute cap, and remain a valid projection',()=>{
 const uncappedUsage={jobs:9,jobLimit:null,minutes:240,minuteLimit:null};
 const projection=projectRequestAdmission({usage:uncappedUsage,accountedMilliseconds:0,dailyMinutes:null,wallSeconds:1200});
 assert.deepEqual(projection,{schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,
  evidence:{jobCap:null,minuteCap:null}});
 assert.deepEqual(validateRequestAdmission(projection),projection);
 const jobCap=projectRequestAdmission({usage:{...uncappedUsage,jobLimit:3},accountedMilliseconds:0,dailyMinutes:null,wallSeconds:1200});
 assert.equal(jobCap.admission,'blocked');assert.equal(jobCap.reasonCode,'job_cap');
 assert.equal(validateRequestAdmission(jobCap).admission,'blocked');
});

test('request admission fails closed on malformed supplied evidence',()=>{
 for(const input of [
  {usage:{...usage,jobs:-1},accountedMilliseconds:0,dailyMinutes:60,wallSeconds:1},
  {usage,accountedMilliseconds:-1,dailyMinutes:60,wallSeconds:1},
  {usage,accountedMilliseconds:0,dailyMinutes:NaN,wallSeconds:1},
  {usage,accountedMilliseconds:0,dailyMinutes:60,wallSeconds:undefined},
 ]) assert.equal(projectRequestAdmission(input).admission,'unknown');
});

test('request admission validator rejects malformed and contradictory projections',()=>{
 const allowed=projectRequestAdmission({usage,accountedMilliseconds:0,dailyMinutes:60,wallSeconds:1});
 assert.equal(validateRequestAdmission(allowed).admission,'allowed');
 assert.equal(validateRequestAdmission({...allowed,evidence:{}}).admission,'unknown');
 assert.equal(validateRequestAdmission({...allowed,admission:'blocked',reasonCode:'unrecognized'}).admission,'unknown');
 assert.equal(validateRequestAdmission({...allowed,evidence:{...allowed.evidence,jobCap:{used:3,limit:3}}}).admission,'unknown');
 assert.equal(validateRequestAdmission({...allowed,admission:'blocked',reasonCode:'job_cap'}).admission,'unknown',
  'a blocked reason must be proved by its own normalized evidence');
 const capped=projectRequestAdmission({usage:{...usage,jobs:3},accountedMilliseconds:0,dailyMinutes:60,wallSeconds:1});
 assert.equal(validateRequestAdmission({...capped,evidence:{...capped.evidence,jobCap:{used:0,limit:3}}}).admission,'unknown');
});
