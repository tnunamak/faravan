import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source,SYNTHETIC_RESET} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT,WEEK,NOW,MICRO} from './helpers/pace50-fixtures.mjs';
const HOUR=3600000, RESET=NOW+SYNTHETIC_RESET.short;
function fixture(t){
 const directory=fs.mkdtempSync(join(tmpdir(),'r3-probe-'));
 const clock={at:NOW},control={fresh:true};
 const source=createSyntheticPace50Source({start:NOW,used:{weekly:20*MICRO,short:0},override:({base,now})=>({...base,
  complete:control.fresh,refresh_succeeded:control.fresh,
  resources:base.resources.map(r=>r.kind==='short'&&now>=RESET?{...r,instance:'short-2',anchor_at:RESET,resets_at:RESET+5*HOUR,used_micro:17.5*MICRO}:r)})});
 const pace=createPace50Candidate({directory,now:()=>clock.at,account:ACCOUNT,account_week_id:WEEK,source});
 t.after(async()=>{await pace.adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
 const reserve=id=>pace.candidate.reserve({attemptId:id,jobId:id,provider:'claude',model:'claude-haiku-5-5',
  job:{budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:300}},expires_at:new Date(NOW+7*86400e3).toISOString()},automatic:true,ownerAbsent:true});
 return {...pace,clock,control,source,reserve};
}
test('an unresolved late start holds admission after a missing covering-window reading',async t=>{
 const f=fixture(t);assert.equal((await f.reserve('a')).ok,true);
 f.clock.at=RESET+3*HOUR;f.control.fresh=false;
 await f.candidate.started('a',{ok:true});
 await f.candidate.finish({attemptId:'a',provider:'claude',model:'claude-haiku-5-5',execution:{stdout:''}});
 await f.candidate.recordCleanup('a',{removed:true});
 await f.candidate.probeHeld();
 const old=f.adapter.state().attempts.find(a=>a.id==='a');
 assert.equal(old.late_ack_unresolved,true);
 f.control.fresh=true;
 const next=await f.reserve('b');
 assert.equal(next.ok,false, 'an uncarried exposure in the old window cannot be ignored');
 assert.equal(next.policyReason,'cross_window_exposure_unreconciled');
 assert.equal(f.adapter.state().attempts.some(a=>a.id==='b'),false,'a held request reserves no new exposure');
});
