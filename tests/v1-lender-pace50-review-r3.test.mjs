import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT,WEEK,NOW,MICRO} from './helpers/pace50-fixtures.mjs';
import {parseGuardLine} from '../lib/faravan-guard-host.mjs';
function fixture(t){
 const directory=fs.mkdtempSync(join(tmpdir(),'r3-probe-'));
 const clock={at:NOW};
 const source=createSyntheticPace50Source({start:NOW,used:{weekly:20*MICRO,short:0}});
 const pace=createPace50Candidate({directory,now:()=>clock.at,account:ACCOUNT,account_week_id:WEEK,source,
  contextFor:()=>({consent:true,people:true,agents:true,schedule:true,unexpired:true})});
 t.after(async()=>{await pace.adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
 const reserve=id=>pace.candidate.reserve({attemptId:id,jobId:id,provider:'claude',model:'claude-haiku-5-5',
  job:{budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:300}},expires_at:new Date(NOW+7*86400000).toISOString()},
  automatic:true,ownerAbsent:true});
 return {...pace,clock,source,reserve};
}
// The former fixed 1.5-point cap assertion is replaced by the objective-capacity
// regression in v1-lender-pace50-review-r3-slack.test.mjs.
test('R3 an empty nonfinal guard observation is unknown usage, never a zero-cost completed run',async t=>{
 const f=fixture(t);assert.equal((await f.reserve('empty-meter')).ok,true);
 await f.candidate.started('empty-meter',{ok:true});
 // The production guard can emit a rate-limit-only record before any usage or final cost arrives.
 f.source.state.used.weekly+=125000;f.source.state.used.short+=500000;
 await f.candidate.recordCleanup('empty-meter',{removed:true});
 const meter=parseGuardLine(JSON.stringify({type:'faravan.meter',v:1,seq:1,at:new Date(NOW).toISOString(),source:'claude-stream',tokens:{input:0,cached_input:0,output:0,reasoning_output:0},cost_usd:null,windows:[],final:false}));
 assert.ok(meter,'production host parser accepts the record');
 const out=await f.candidate.finish({attemptId:'empty-meter',provider:'claude',model:'claude-haiku-5-5',
  execution:{stdout:'',lending_meter:meter}});
 const after=f.adapter.state().attempts[0];
 assert.equal(after.process_state,'ceased','cleanup proves only process exit');
 assert.equal(after.hold_closed,false,'no usage data or final cost proves zero spend');
 assert.ok(after.resources.some(r=>r.held_micro>0||r.unrepresented_micro>0));
});
test('R3: a borrower final zero-cost report leaves the hold open until meter evidence arrives',async t=>{
 const f=fixture(t);assert.equal((await f.reserve('zero')).ok,true);await f.candidate.started('zero',{ok:true});
 await f.candidate.recordCleanup('zero',{removed:true});
 const out=await f.candidate.finish({attemptId:'zero',provider:'claude',model:'claude-haiku-5-5',execution:{stdout:'',lending_meter:{tokens:{input:0,output:0},cost_usd:0,final:true}}});
 assert.equal(out.cessation.reason,'usage_unknown');
 assert.equal(f.adapter.state().attempts[0].process_state,'ceased');
 assert.equal(f.adapter.state().attempts[0].hold_closed,false);
 assert.ok(f.adapter.state().attempts[0].resources.every(r=>r.held_micro>0));
});
