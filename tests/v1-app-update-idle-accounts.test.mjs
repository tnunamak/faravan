import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture} from './helpers/v1-app-fixture.mjs';

// The updater may swap and restart only while no lender work is unfinished. The
// counter root mirrors account rows, but the gate reads every row itself.
const KINDS=['pending','claimPending','claimedPending','acceptedClaim','outputPending','resultPending','declinePending','stoppedPending','watchedStops'];

test('the update gate defers for unfinished work in any account row and passes when all rows are clear',{timeout:60000},async t=>{
  const f=await appFixture(t);
  const idles=[];
  const updater={startDelayMs:20,intervalMs:20,check:async()=>({current:'1.0.0',manifest:null}),
    async tick({idle}){idles.push(idle);return 'none';}};
  const {home}=await f.start('gate',{updater,faravanVersion:'1.0.0'});
  const counters=join(home,'v1','app-counters.json');
  const next=async()=>{const seen=idles.length;
    for(let i=0;i<400&&idles.length<seen+3;i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(idles.length>=seen+3,'the update tick ran again');return idles.slice(seen);};
  const stage=async row=>{await writeFile(counters,JSON.stringify({version:1,day:'2026-01-01',jobs:0,milliseconds:0,...row}));};
  await stage({});
  await next();
  assert.equal((await next()).every(idle=>idle===true),true,'all rows clear: idle');
  for(const kind of KINDS){
    await stage({accounts:{codex:{[kind]:kind==='watchedStops'?[{attemptId:'a-'+kind}]:{attemptId:'a-'+kind}}}});
    await next();
    assert.equal((await next()).every(idle=>idle===false),true,kind+' under accounts defers the update');
  }
  await stage({pending:{attemptId:'root'}});
  await next();
  assert.equal((await next()).every(idle=>idle===false),true,'the root still defers');
  await stage({accounts:{codex:{},claude:null}});
  await next();
  assert.equal((await next()).every(idle=>idle===true),true,'empty account rows are idle again');
});
