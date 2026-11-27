import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Listing order is shared by every actor that writes one proof file: the app, the watcher, a restarted app, a restarted
// watcher. Each actor below loads its own copy of the module, so no counter is shared in memory. The only thing they share is
// the file, and a clock that may stand still or step back.
const NAME='wf-0123456789abcdef',OWNER='order-owner';
const actor=async(home,tag,now)=>{
  const {watchProofStore}=await import('../lib/v1/sandbox-watch-proofs.mjs?actor='+tag);
  return watchProofStore({home,owner:OWNER,now});
};
const fixture=t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wf-proof-order-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const row={sandbox_id:NAME,_cleanupId:'01234567-1234-1234-1234-123456789abc',watch_generation:'generation-1'};
  return {home,row,proofFile:path.join(home,'.faravan-shared-watch','proofs.json')};
};

test('an older empty listing from one process never proves gone a name another process saw present later',async t=>{
  const {home,row}=fixture(t);
  // The clock stands still for both. Process A has listed many times; process B has not listed at all.
  const a=await actor(home,'a1',()=>1000),b=await actor(home,'b1',()=>1000);
  for(let i=0;i<10;i++)await a.stamp();
  const olderEmpty=await a.stamp(); // this listing is started first, and its result is held in flight
  const newerPresent=await b.stamp();
  await b.observe(row,true,{listedAt:newerPresent}); // the later listing shows a running sandbox
  await a.observe(row,false,{listedAt:olderEmpty}); // the older empty result arrives last
  assert.equal(a.gone(row),null,'the older empty listing is dropped');
  assert.equal(b.gone(row),null);
  assert.equal(b.matching(row).seen_present,true);
});

test('an old empty listing from before a restart on a clock that stepped back never proves a present name gone',async t=>{
  const {home,row}=fixture(t);
  const before=await actor(home,'before-restart',()=>2000);
  const olderEmpty=await before.stamp();
  // The process restarts after the wall clock stepped back. Its first listing shows the sandbox.
  const after=await actor(home,'after-restart',()=>1000);
  const newerPresent=await after.stamp();
  await after.observe(row,true,{listedAt:newerPresent});
  await before.observe(row,false,{listedAt:olderEmpty});
  assert.equal(after.gone(row),null,'the stale empty result does not close the row');
  // The sandbox is seen present again: still nothing closes.
  await after.observe(row,true,{listedAt:await after.stamp()});
  assert.equal(after.gone(row),null);
});

test('a saved sighting never blocks a later real absence, whatever the clock now says',async t=>{
  const {home,row}=fixture(t);
  const first=await actor(home,'first',()=>9_000_000_000_000);
  await first.observe(row,true,{listedAt:await first.stamp()});
  // A restarted actor whose clock stands far behind the saved sighting starts a listing after it, and the name is gone.
  const second=await actor(home,'second',()=>500);
  const entry=await second.observe(row,false,{listedAt:await second.stamp()});
  assert.equal(entry?.state,'gone','a listing started after the sighting counts as a later absence');
  assert.equal(second.gone(row)?.state,'gone');
});

test('saved gone evidence needs an absence strictly later than the sighting',async t=>{
  const {home,row,proofFile}=fixture(t);
  const store=await actor(home,'evidence',()=>1000);
  await store.observe(row,true,{listedAt:await store.stamp()});
  const good=JSON.parse(fs.readFileSync(proofFile,'utf8'));
  const base={...good.proofs[NAME],state:'gone',seen_present:true,gone_at:9};
  const shapes=[['equal times',{...base,present_at:5,absent_at:5},false],['absence before sighting',{...base,present_at:5,absent_at:4},false],
    ['strictly later absence',{...base,present_at:5,absent_at:6},true]];
  for(const [label,entry,accepted] of shapes) {
    const bytes=JSON.stringify({...good,proofs:{[NAME]:entry}});
    fs.writeFileSync(proofFile,bytes);
    assert.equal(Boolean(store.gone(row)),accepted,label);
    assert.equal(fs.readFileSync(proofFile,'utf8'),bytes,label+': the record is kept as it is');
  }
});
