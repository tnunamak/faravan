import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {jobWatchRevision} from '../lib/v1/job-watch.mjs';

const digest='sha256:'+'a'.repeat(64);
const base={job_digest:digest,state:'claimed'};

test('job watch revisions tolerate omitted optional lifecycle fields deterministically',()=>{
  const view={...base,current_attempt:{attempt_id:'attempt-1',generation:1}};
  assert.equal(jobWatchRevision(view),jobWatchRevision(view));
  assert.doesNotThrow(()=>jobWatchRevision(view));
});

test('job watch revisions change for execution and stop lifecycle transitions',()=>{
  const queued={...base,current_attempt:{attempt_id:'attempt-1',generation:1,state:'claimed'}};
  const running={...queued,state:'claimed',current_attempt:{...queued.current_attempt,state:'active',
    execution_started_at:'2026-10-23T18:00:00Z'}};
  const stopping={...running};
  const stopRequest={attempt_id:'attempt-1',generation:1,job_digest:digest,requested_at:'2026-10-23T18:00:01Z'};

  assert.notEqual(jobWatchRevision(queued),jobWatchRevision(running));
  assert.notEqual(jobWatchRevision(running),jobWatchRevision(stopping,stopRequest));
});

test('job watch revisions reject an attempt without its signed identity',()=>{
  assert.throws(()=>jobWatchRevision({...base,current_attempt:{generation:1,state:'active'}}));
  assert.throws(()=>jobWatchRevision({...base,current_attempt:{attempt_id:'attempt-1',state:'active'}}));
});

import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {until} from './helpers/v1-lender-fixture.mjs';

for(const [state,status,reason,kept] of [
  ['result-accepted','Stopped by lender',null,false],
  ['cancelled','Stopping',null,false],
  ['failed','Failed','lease_expired',true],
  ['expired','Expired',null,false],
  ['failed','Failed',null,false],
])test('job watch follows terminal state for '+status+(kept?' with a possible late result':''),async()=>{
  // Exercise the app's real tracking functions with controlled transport responses.
  const source=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
  const functions=section('  async function recordTrackedJob(', '  async function observeTrackedJob(')+
    section('  async function observeTrackedJob(', '  // The coordinator answers 404')+
    section('  function forgetJob(', '  async function jobGone(')+
    section('  async function runJobWatch(', '  function startJobWatch(');
  const localRecords=new Map([[digest,{state,status}]]),tracked=new Map(),item={circle:'circle'};
  tracked.set(digest,item);
  const stop=new AbortController(),jobWatchStops=new Map([[digest,stop]]);
  let calls=0;
  const view={job_digest:digest,state,status,current_attempt:{reason},jobWatchRevision:'changed'};
  const operations={get:async()=>view,waitForJobChange:async(_job,{signal})=>{
    calls++;
    if(calls===1)return {revision:'changed'};
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }};
  const run=new Function('operations','tracked','jobWatchStops','delay',`
    const closed=false,refreshAbort=new AbortController(),legacyJobDigests=new Set();
    const jobEventSignature=JSON.stringify,emit=()=>{},startLegacyJobPoller=()=>{};
    const settings={notifications:{}},notificationFeed={observe:async()=>{},status:()=>({degraded:false})};
    const withBorrowerOutcome=async value=>value,isJobNotFound=()=>false,STOP_READ_RETRY_MAX_MS=1000;
    ${functions}
    return runJobWatch;
  `)(operations,tracked,jobWatchStops,delay);
  const watching=run(digest,item,{job_digest:digest,state:'claimed',status:'Running',jobWatchRevision:'initial'},stop);
  try {
    await until(()=>kept?calls>=2:!tracked.has(digest),'watch tracking decision',1000);
    assert.equal(calls,kept?2:1);
    assert.equal(tracked.has(digest),kept);
    assert.ok(localRecords.has(digest),'ending the watch preserves the local job record');
  } finally {stop.abort();await watching;}
});
