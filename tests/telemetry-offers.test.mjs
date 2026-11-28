import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';

import {createOfferBook,offerReason,MAX_OFFERS,OFFER_REASONS} from '../lib/v1/offer-book.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

// One offer-decision per offer per computer (TELEMETRY.md section 2.3). Synthetic offers and fixtures only.
const START=Date.parse('2026-10-20T12:00:00Z'),HOUR=3600000;
const offer=(n,{expires=START+HOUR,harness=['codex'],wall=120}={})=>({job_digest:'sha256:'+String(n).padStart(64,'0'),
  job:{payload:{circle:'circle-1',expires_at:new Date(expires).toISOString(),requirements:{harness,limits:{wall_seconds:wall}}}}});
const listing=(views,reason='none',mode='ask')=>views.map(view=>({view,reason,mode}));

test('map overflow is counted at 10,000 entries, once per offer, and rides the next decision only when it grows',async()=>{
  const book=createOfferBook({now:()=>START}),root={},views=Array.from({length:MAX_OFFERS+2},(_,i)=>offer(i));
  book.sight(root,{account:'codex:0',readAt:START,listed:listing(views)});
  assert.equal(Object.keys(root.offerBook.entries).length,MAX_OFFERS);
  assert.equal(root.offerBook.overflow,2);
  book.sight(root,{account:'codex:0',readAt:START+1,listed:listing(views)});
  assert.equal(root.offerBook.overflow,2,'the same turned-away offers are not counted again');
  const first=book.settle(root,{view:views[0],outcome:'hidden',mode:'ask'}).decisions;
  assert.equal(first[0].mapOverflow,2);
  const next=book.settle(root,{view:views[1],outcome:'hidden',mode:'ask'}).decisions;
  assert.equal('mapOverflow' in next[0],false);
  assert.deepEqual(book.settle(root,{view:views[MAX_OFFERS],outcome:'hidden',mode:'ask'}).decisions,[],'an untracked offer yields no decision');
});

test('gate codes become members of the closed reason list',()=>{
  for(const code of ['paused','account_slots','machine_capacity','reading_allowance','cessation_unverified','approval_pending','approval_unavailable','update_required',
    'wall_limit','job_expired','readiness_changed','quota_reserve',null,undefined])assert.ok(OFFER_REASONS.includes(offerReason(code)),String(code));
  assert.equal(offerReason('wall_limit'),'cannot_run_here');
  assert.equal(offerReason('machine_capacity'),'busy');
});

// The real lender, under the real pool: which offers it judged on one pass and what it did with them.
const OFFERED=[1,2].map(n=>'sha256:'+String(n).repeat(64));
async function pooledLender(t) {
  const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});
  f.client.capabilities=async()=>({capabilities:['offers_v1','run_request_v1']});
  const views=OFFERED.map(job_digest=>({job_digest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z',current_attempt:null}));
  f.client.listOffers=async function*(){yield* views;};
  f.client.claimJob=async(_digest,_ad,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  f.policy.standingRules=[{id:'rule-1',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['claude-code-subscription'],maxWallSeconds:120,
    dailyJobs:2,weeklyJobs:10,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000}];
  return f;
}
test('a lender without the pool books nothing and still decides the same way',{timeout:60000},async t=>{
  const f=await pooledLender(t),controller=new AbortController();
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal).catch(()=>{});
  await until(()=>f.saved()?.claimPending?.jobDigest===OFFERED[0],'the first offer is picked');
  controller.abort();await running;
  assert.equal(f.events.some(e=>e.status==='offer-decision'),false);
});

test('an offer that expires while visible is decided once, however often it is settled afterwards',()=>{
  let time=START;
  const book=createOfferBook({now:()=>time}),root={},view=offer(7);
  book.sight(root,{account:'codex:0',readAt:time,listed:listing([view])});
  time=START+HOUR+1000; // past its expiry
  const swept=book.sight(root,{account:'codex:0',readAt:time,listed:[]}).decisions;
  assert.deepEqual(swept.map(d=>d.outcome),['expired_visible']);
  assert.deepEqual(book.settle(root,{view,outcome:'expired_visible',mode:'ask'}).decisions,[],'the review card closing afterwards adds nothing');
  assert.deepEqual(book.settle(root,{view,outcome:'expired_visible',mode:'ask'}).decisions,[]);
  // The same on the first touch after expiry: the sweep decides, the settle that follows in the same call adds nothing.
  const other=offer(8);
  book.sight(root,{account:'codex:0',readAt:time,listed:listing([other],'none','ask').map(l=>({...l,view:offer(8,{expires:time+HOUR})}))});
  time+=2*HOUR;
  const first=book.settle(root,{view:offer(8,{expires:time-HOUR}),outcome:'expired_visible',mode:'ask'}).decisions;
  assert.equal(first.length<=1,true);
});
