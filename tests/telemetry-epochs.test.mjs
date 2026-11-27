import './helpers/no-browser.mjs';
// Install identity persists across long-running catalog operations, restarts and resets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTelemetry} from './helpers/telemetry-harness.mjs';
test('one install ID survives sixty days and restarts; internal diagnostic IDs never leave',async()=>{
 let h=makeTelemetry();const id=h.tel.bootstrap().installId;const root=h;
 try{
  for(let day=0;day<60;day++){
   h.tel.observe('lender-failure',{code:'sandbox_start_failed',phase:'prepare'});h.clock.advance(86400000);await h.tel.flushNow();
   assert.equal(h.tel.bootstrap().installId,id);
   if(day%10===0){await h.tel.close();h=makeTelemetry({dir:h.dir,level:null,clock:h.clock,transport:h.transport});}
  }
  const batches=h.transport.bodies();assert.ok(batches.length>0);
  for(const event of batches.flatMap(body=>body.batch)){assert.equal(event.distinct_id,id);for(const key of ['epoch','session','trace','rid','seq'])assert.equal(event.properties[key],undefined);}
 }finally{await h.tel.close();root.cleanup();}
});
test('reset purges records under the previous identity before accepting new work',async()=>{
 const h=makeTelemetry();try{
  const id=h.tel.bootstrap().installId;h.tel.observe('lender-failure',{code:'sandbox_start_failed',phase:'prepare'});h.tel.tick();const generation=h.tel.status().generation;
  h.tel.resetIdentity();assert.ok(h.tel.status().generation>generation);assert.notEqual(h.tel.bootstrap().installId,id);assert.equal(h.tel.preview().items.length,0);
  h.tel.observe('lender-failure',{code:'sandbox_start_failed',phase:'prepare'});await h.tel.flushNow();assert.ok(h.transport.bodies().flatMap(b=>b.batch).every(e=>e.distinct_id!==id));
 }finally{await h.tel.close();h.cleanup();}
});
