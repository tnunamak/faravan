import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfferReader, matchingRule} from '../lib/v1/offers.mjs';
const view=i=>({job_digest:'sha256:'+String(i).padStart(64,'0'),state:'queued',published_at:'2026-10-20T00:00:00Z',job:{payload:{author:'sam',circle:'circle',expires_at:'2026-10-22T00:00:00Z',requirements:{harness:['codex'],limits:{wall_seconds:30}}}}});
test('old host full scan reaches the last job at 2000, and scans at most once per minute',async()=>{
 let now=0,requests=0;
 const client={capabilities:async()=>({capabilities:[]}),async *listJobs(){requests++;for(let i=1;i<=2000;i++)yield {...view(i),state:i===2000?'queued':'result-accepted'};}};
 const reader=createOfferReader({client,now:()=>now});
 assert.equal((await reader.read()).items[0].job_digest,view(2000).job_digest);
 now=59999;await reader.read();assert.equal(requests,1);
 now=60000;await reader.read();assert.equal(requests,2);
});
test('old host 2001 switches to explicitly labeled short hold, without partial offers',async()=>{
 const client={capabilities:async()=>({capabilities:[]}),async *listJobs(){for(let i=1;i<=2001;i++)yield view(i);}};
 const page=await createOfferReader({client}).read();assert.equal(page.legacy,true);assert.deepEqual(page.items,[]);assert.match(page.label,/host.*old.*offers/i);
});
test('offers host uses queued read and does not fetch any artifacts or claims',async()=>{
 const client={capabilities:async()=>({capabilities:['offers_v1']}),async *listOffers(){yield view(1);},fetchArtifact(){assert.fail('no source or prompt read for discovery');}};
 assert.deepEqual((await createOfferReader({client}).read()).items,[view(1)]);
});
test('standing grant matches only scope, size, time, expiry and both usage caps',()=>{
 const job=view(1).job.payload,now=Date.parse('2026-10-20T12:00:00Z');
 const rule={id:'r',circle:'circle',people:['sam'],agents:['codex'],maxWallSeconds:30,dailyJobs:2,weeklyJobs:3,dailyMinutes:3,weeklyMinutes:5,expiresAt:now+86400000};
 const matches=(patch={},usage={})=>matchingRule([{...rule,...patch}],job,'codex',{now,usage:()=>usage});
 assert.equal(matches()?.id,'r');
 for(const patch of [{circle:'other'},{people:['jo']},{agents:['claude']},{maxWallSeconds:29},{expiresAt:now}])assert.equal(matches(patch),null);
 assert.equal(matches({}, {dailyJobs:2}),null);assert.equal(matches({}, {weeklyJobs:3}),null);
 assert.equal(matches({}, {dailyMs:180000}),null);assert.equal(matches({}, {weeklyMs:300000}),null);
 assert.equal(matches({timeZone:'UTC',schedule:{days:[2],from:'13:00',to:'14:00',weekends_all_day:false}}),null);
 assert.equal(matches({timeZone:'UTC',schedule:{days:[2],from:'11:00',to:'13:00',weekends_all_day:false}})?.id,'r');
});
test('a standing grant with no picked wall-time limit matches jobs within the engine limit',()=>{
 const job={...view(1).job.payload,requirements:{harness:['codex'],limits:{wall_seconds:1201}}};
 const rule={id:'r',circle:'circle',people:['sam'],agents:['codex'],maxWallSeconds:null,dailyJobs:null,weeklyJobs:null,
  dailyMinutes:null,weeklyMinutes:null,expiresAt:Date.parse('2026-10-22T00:00:00Z')};
 assert.equal(matchingRule([rule],job,'codex',{now:Date.parse('2026-10-20T12:00:00Z')})?.id,'r');
});
