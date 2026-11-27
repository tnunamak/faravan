import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createLendingLedger} from '../../lib/v1/lending-launch.mjs';

test('settlement holds unknown or lagged remainder and reconciles exact covered final window after restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'faravan-finality-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const deps={journal:{directory},settings:async()=>({revision:1})};let ledger=createLendingLedger(deps);
 const amount={unit:'window_micro_points',byResource:[{id:'week',instance:'w1',amount:100}]};
 const reserved=await ledger.compareAndReserve({accountId:'a',expectedRevision:0,settingsRevision:1,operationId:'reserve',
  receipt:{accountId:'a',jobId:'j',attemptId:'t',quotedLedgerRevision:0,settingsRevision:1,amount},enforcement:{amount}});
 const usage={accountId:'a',reading:null,jobReadings:[{accountId:'a',attemptId:'t',eventId:'e',sequence:1,atMs:900,
  semantics:'delta',meterEpoch:'epoch',amount:{unit:'tokens',value:3},windowDebits:[{id:'week',instance:'w1',micro:30}]}]};
 const settle=operationId=>ledger.settle({accountId:'a',reservationId:reserved.value.reservationId,operationId,cessationAtMs:1000,usage});
 const row=async()=> (await ledger.snapshot('a')).resources[0];
 await settle('unknown');assert.deepEqual(await row(),{id:'week',instance:'w1',unit:'window_micro_points',reserved:70,consumed:30,unrepresented:30});
 ledger=createLendingLedger(deps);await settle('restart');assert.equal((await row()).reserved,70);
 usage.reading={accountId:'a',observedAtMs:1100,receivedAtMs:1100,postingUncertaintyMs:null,
  coverage:{kind:'proven',throughSequenceByAttempt:{t:1}},windows:[{id:'week',instance:'w1'}]};
 await settle('unknown-lag');assert.equal((await row()).reserved,70);
 usage.reading.postingUncertaintyMs=200;await settle('lagged');assert.equal((await row()).reserved,70);
 usage.reading.observedAtMs=usage.reading.receivedAtMs=1200;
 usage.reading.windows[0].instance='foreign';await settle('foreign-window');assert.equal((await row()).reserved,70);
 usage.reading.windows[0].instance='w1';await settle('covered');await settle('covered');
 assert.equal((await row()).reserved,0);assert.equal((await row()).consumed,30);assert.equal((await row()).unrepresented,0);
});
