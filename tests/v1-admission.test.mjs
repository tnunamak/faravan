import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHostAdmission} from '../lib/v1/admission.mjs';

const limited=fn=>assert.throws(fn,{code:'rate_limited'});

test('host request ceiling still applies across sources and circles, with idempotent release',()=>{
  const admission=createHostAdmission({limits:{maxRequests:4,maxRequestsPerSource:3}});
  const leases=Array.from({length:4},(_,i)=>admission.acquire('requests',i<3?'proxy-a':'proxy-b','member-'+i,'circle-'+i));
  limited(()=>admission.acquire('requests','proxy-c','other','other-circle'));
  assert.equal(admission.pending('requests'),4);leases[0]();leases[0]();assert.equal(admission.pending('requests'),3);
  const replacement=admission.acquire('requests','proxy-a','other','other-circle');
  leases.forEach(release=>release());replacement();assert.equal(admission.pending('requests'),0);
});

for(const pool of ['polls','downloads'])test(pool+' have independent member, circle and global ceilings',()=>{
  const prefix=pool==='polls'?'Polls':'Downloads';
  const admission=createHostAdmission({limits:{['max'+prefix]:4,['max'+prefix+'PerDevice']:1,['max'+prefix+'PerCircle']:2}});
  const first=admission.acquire(pool,'proxy','a1','A');limited(()=>admission.acquire(pool,'proxy','a1','A'));
  const second=admission.acquire(pool,'proxy','a2','A');limited(()=>admission.acquire(pool,'proxy','a3','A'));
  const third=admission.acquire(pool,'proxy','b1','B'),fourth=admission.acquire(pool,'proxy','b2','B');
  limited(()=>admission.acquire(pool,'proxy','c1','C'));
  [first,second,third,fourth].forEach(release=>release());assert.equal(admission.pending(pool),0);
});

test('physical headroom reservations use filesystem units and are shared across circles',()=>{
  const admission=createHostAdmission({limits:{minFreeDiskBytes:0,minFreeInodes:0}});
  const capacity={bsize:512n,bavail:6n,files:100n,ffree:2n};
  const a=admission.reserveStorage(capacity,1),b=admission.reserveStorage(capacity,1);
  limited(()=>admission.reserveStorage(capacity,1));a();a();
  const replacement=admission.reserveStorage(capacity,1);b();replacement();
  admission.reserveStorage({...capacity,files:0n,ffree:0n},1)();
});

test('bootstrap attempts and successful redemption budgets reset independently',()=>{
  let now=0;
  const admission=createHostAdmission({clock:()=>now,limits:{bootstrapWorkPerWindow:1,bootstrapPerDevice:1,bootstrapWindowSeconds:10}});
  admission.bootstrapWork('proxy');limited(()=>admission.bootstrapWork('proxy'));
  admission.enrollment('verified-member');limited(()=>admission.enrollment('verified-member'));
  now=10;admission.bootstrapWork('proxy');admission.enrollment('verified-member');
});

test('job watches reuse poll limits without spending lender poll capacity',()=>{
  const admission=createHostAdmission({limits:{maxPollsPerDevice:4}});
  const watches=Array.from({length:4},()=>admission.acquire('watches','proxy','device','circle'));
  limited(()=>admission.acquire('watches','proxy','device','circle'));
  const offers=admission.acquire('polls','proxy','device','circle');
  const claim=admission.acquire('polls','proxy','device','circle');
  assert.equal(admission.pending('watches'),4);assert.equal(admission.pending('polls'),2);
  [...watches,offers,claim].forEach(release=>release());
  const custom=createHostAdmission({limits:{maxPollsPerDevice:1}});
  const release=custom.acquire('watches','proxy','device','circle');
  limited(()=>custom.acquire('watches','proxy','device','circle'));release();
});
