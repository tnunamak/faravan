import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

// A lender accepts a review card. While the app writes the acceptance receipt, the circle removes the requester and
// the lender's device learns the new roster. The card was shown for the old roster and is not refreshed during the
// write. Whatever the app then decides, the circle host must refuse to let the removed requester's job run.
// Synthetic fixtures with a real coordinator store; no sandbox, model or real backend.
const gitInput=circle=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Identity race',harness:'codex',send_anyway:true});
function heldDecisions(module) {
  const held={gate:null,entered:null,enteredRelease:null,open(){
    let release;this.gate=new Promise(r=>{release=r;});this.entered=new Promise(r=>{this.enteredRelease=r;});return release;
  }};
  held.factory=directory=>{const log=module.createDecisionLog(directory);
    return {...log,async record(row){if(held.gate&&!row.id.endsWith(':not-applied')){held.enteredRelease();await held.gate;}return log.record(row);}};};
  return held;
}

test('a requester removed during the acceptance receipt write cannot have the job run',{timeout:180000},async t=>{
  const held=heldDecisions(await import('../lib/v1/decision-log.mjs'));
  const f=await appFixture(t),{owner,declining:requester,lender,circle}=await f.realConnect({lenderOptions:{decisionLog:held.factory}});
  const sent=await api(requester.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  assert.equal(card.identity.requester,requester.app.device.keyId);
  assert.equal(card.identity.memberPresent,true);
  const release=held.open();
  let answer;
  try {
    const accepting=fetch(lender.app.origin+'/api/approvals/'+card.id+'/accept',{method:'POST',
      headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},body:'{}'});
    await held.entered;
    // The roster changes while the receipt write is in flight; the lender's device accepts the new roster.
    await owner.app.device.removeMember(circle.id,requester.app.device.keyId);
    await lender.app.device.refreshRoster(circle.id);
    const roster=(await lender.app.device.rosterCache(circle.id).get()).current.payload;
    assert.ok(!roster.members.some(m=>m.key_id===requester.app.device.keyId),'the lender holds the removal roster');
    release();
    const response=await accepting;answer={status:response.status,body:await response.json().catch(()=>null)};
  } finally {release();}
  // The coordinator is the authority: the removed requester's job is cancelled and never claimed or run here.
  await new Promise(resolve=>setTimeout(resolve,500));
  const view=await (await owner.app.device.client(circle.id)).getJob(sent.jobDigest);
  assert.equal(view.state,'cancelled',JSON.stringify({answer,state:view.state}));
  assert.equal(view.current_attempt,null,'no lender ever held an attempt');
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false,'nothing ran on the lender');
  // The app's own final check compares the card with the identity it captured, so it lets the answer through; the
  // host's live roster check in the claim is what refuses it.
  assert.deepEqual([answer.status,answer.body?.code],[409,'job_terminal'],JSON.stringify(answer));
});
