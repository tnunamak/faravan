import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/offers-jobs-fixture.mjs';
import {canonicalize} from '../lib/protocol/index.mjs';

// Real apps on both sides of a fake host. The lender asks before each job; the host's presence page is built from the
// heartbeats the lender really sends, so the borrower reads exactly what the lender reported.
test('an unanswered ask card reads as waiting for the lender to approve, and clears when the lender answers',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({heartbeatMs:100});
  const base=f.override;
  f.override=async ctx=>{
    if(ctx.route!=='/presence')return base(ctx);
    const hb=f.heartbeats?.findLast(body=>body.intent);
    const devices=hb?[{device:lender.app.device.keyId,online:true,source:'heartbeat',last_heartbeat_at:new Date().toISOString(),
      intent:hb.intent,execution:hb.execution,blockers:[],agents:hb.agents,budget:hb.budget,capabilities:hb.capabilities,account_offers:(hb.accounts??[]).flatMap(account=>account.models.filter(model=>model.enabled).map(model=>({providerId:account.providerId,modelId:model.id,effortIds:model.efforts.map(effort=>effort.id)})))}]:[];
    const bytes=Buffer.from(canonicalize({now:new Date().toISOString(),online_seconds:90,devices,persons:[]}));
    ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);return true;
  };
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic request',harness:'codex',send_anyway:true}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the ask card');
  await waitFor(()=>f.heartbeats?.findLast(body=>body.intent)?.intent.reason==='approval_pending','the lender reports that it is reviewing');
  const read=async()=>(await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id)).statusContract.explanation;
  const waiting=await waitFor(async()=>{const text=await read();return /^Waiting for .+ to approve$/.test(text)?text:null;},'the borrower sees the approval wait');
  assert.doesNotMatch(waiting,/—/);
  // The lender answers: the card closes and the next report no longer says it is reviewing.
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  await waitFor(()=>f.heartbeats?.findLast(body=>body.intent)?.intent.reason!=='approval_pending','the lender stops reporting a review');
  await waitFor(async()=>!/to approve$/.test(await read()),'the borrower no longer sees the approval wait');
});
