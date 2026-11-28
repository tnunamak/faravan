import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {LENDING_REASONS,PRIVATE_LENDING_CAUSES,lendingReasonCode} from '../lib/v1/lending-reasons.mjs';
import {createLendingProjection} from '../lib/v1/state-projection.mjs';
import {offerReason} from '../lib/v1/offer-book.mjs';
import {project} from '../lib/v1/telemetry/projection.mjs';

// Runtime producer guard. Private causes can remain in the backend and diagnostic log, but each public
// lending producer must translate them. The real-loop census and lending-on API test check the full path.
test('private lending causes cannot cross projection, offer or telemetry reason fields unmapped',()=>{
 for(const [cause,code] of Object.entries(PRIVATE_LENDING_CAUSES)){
  assert.ok(Object.hasOwn(LENDING_REASONS,code),cause);
  assert.equal(lendingReasonCode(cause),code,cause);
  const projection=createLendingProjection({schemaVersion:2,kind:'lending',intent:'on',admission:'blocked',admissionReason:cause,
   execution:'idle',executionJob:null,evidence:{intentState:'blocked',executionState:'idle',dailyLimitReached:false},version:null});
  assert.equal(projection.admissionReason,code,cause+' projection');
  assert.equal(offerReason(cause),code,cause+' offer');
  const event=project('event:offer-decision',{reason:cause,outcome:'ineligible',harness:'codex',mode:'ask'},{}).find(e=>e.name==='lending.offer.decision');
  assert.equal(event?.attrs.reason,code,cause+' telemetry');
 }
});
