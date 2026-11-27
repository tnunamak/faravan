import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../lib/v1/cleanup-status.mjs').catch(()=>({}));
test('home cleanup summary keeps debt counts and reconstructs watching text without raw details',()=>{
  assert.equal(typeof api.cleanupStatusSummary,'function');
  const data=api.cleanupStatusSummary({data_cleanup_pending:3,policy_cleanup_pending:2,policy_cleanup_blocked:1,
    compute_cleanup_pending:4,unknown:1,create_watch:4,remediation:[{home:'/private',reason:'raw'}],
    shared_watch:{healthy:true,count:4,listing_failed:true,message:'unsafe raw text',pid:123,home:'/private'}});
  assert.deepEqual(data,{data_cleanup_pending:3,policy_cleanup_pending:2,policy_cleanup_blocked:1,compute_cleanup_pending:4,unknown:1,create_watch:4,
    shared_watch:{healthy:true,count:4,listing_failed:true,message:'watching 4 names until listing works',
      // Generated copy only: the raw message, pid and home above are still dropped.
      detail:'Waiting for Docker to list sandboxes, so 4 watched sandbox names cannot be confirmed gone yet. Faravan checks again on its own. Nothing to do.',nothing_to_do:true}});
});
test('untrusted or unavailable watcher details never claim health or erase debt',()=>{
  const data=api.cleanupStatusSummary({compute_cleanup_pending:5,shared_watch:{healthy:'true',count:-1,listing_failed:true,message:'all clear'}});
  assert.equal(data.compute_cleanup_pending,5);assert.equal(data.shared_watch.healthy,false);assert.equal(data.shared_watch.count,null);
  assert.equal(data.shared_watch.message,'Shared workspace watcher needs attention.');
});
test('only finite nonnegative integer counts survive summary',()=>{
  const data=api.cleanupStatusSummary({unknown:Infinity,create_watch:-1,data_cleanup_pending:1.5,policy_cleanup_pending:'2'});
  assert.deepEqual(data,{});
});
