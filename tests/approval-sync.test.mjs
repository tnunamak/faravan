import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {projectMembership} from '../lib/v1/membership-projection.mjs';
import {createSavedReads,jobReadKey} from '../lib/v1/saved-reads.mjs';

// Real-device synchronization regressions.
test('rejection reaches the joining device through the coordinator', async t=>{
  const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
  const joined=await member.joinCircle((await f.owner.createInviteLinks(id)).long,{waitMs:0});
  const enrollment=joined.enrollment.enrollment_id;
  const rejected=await f.owner.rejectEnrollment(id,enrollment);
  assert.equal(rejected.state,'rejected');
  assert.deepEqual(await f.owner.listEnrollments(id),[]);
  await assert.rejects(f.owner.approveEnrollment(id,enrollment),e=>e.code==='enrollment_rejected');
  // The joining device observes the shared rejection, not a local owner marker.
  await assert.rejects(member.refreshRoster(id),e=>e.code==='enrollment_rejected');
  assert.equal(member.selectCircle(id).enrollment.state,'rejected');
});

test('the joining device keeps reporting a shared rejection on every later poll', async t=>{
  const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
  const joined=await member.joinCircle((await f.owner.createInviteLinks(id)).long,{waitMs:0});
  await f.owner.rejectEnrollment(id,joined.enrollment.enrollment_id);
  await assert.rejects(member.refreshRoster(id),e=>e.code==='enrollment_rejected');
  // The first poll stored the rejected state. A later poll must not fall through to a roster read.
  await assert.rejects(member.refreshRoster(id),e=>e.code==='enrollment_rejected');
  const reopened=await f.device('member');
  await assert.rejects(reopened.refreshRoster(id),e=>e.code==='enrollment_rejected');
  assert.equal(reopened.selectCircle(id).enrollment.state,'rejected');
});

test('an owner retry after a lost rejection response reports the shared rejection', async t=>{
  const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
  const joined=await member.joinCircle((await f.owner.createInviteLinks(id)).long,{waitMs:0});
  const enrollment=joined.enrollment.enrollment_id;
  // The coordinator commits each rejection, then the connection drops before the owner reads any answer,
  // including the client's own automatic retries.
  let dropping=true,drops=0;
  f.override=(req,res)=>{
    if(!dropping||req.method!=='POST'||!req.url.endsWith('/enrollments/reject'))return false;
    drops++;res.end=()=>res.socket?.destroy();return false;
  };
  await assert.rejects(f.owner.rejectEnrollment(id,enrollment));
  assert.ok(drops>=1,'the drop must hit the rejection request');
  dropping=false;f.override=null;
  const retried=await f.owner.rejectEnrollment(id,enrollment);
  assert.equal(retried.state,'rejected');
  await assert.rejects(member.refreshRoster(id),e=>e.code==='enrollment_rejected');
});

test('a failed shared rejection leaves the request pending on both devices', async t=>{
  const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
  const joined=await member.joinCircle((await f.owner.createInviteLinks(id)).long,{waitMs:0});
  const enrollment=joined.enrollment.enrollment_id;
  f.override=(req,res)=>{
    if(req.method!=='POST'||!req.url.endsWith('/enrollments/reject'))return false;
    res.writeHead(503);res.end();return true;
  };
  await assert.rejects(f.owner.rejectEnrollment(id,enrollment));
  f.override=null;
  // No local decline is recorded: the owner still sees the request, and the joiner still waits.
  assert.deepEqual((await f.owner.listEnrollments(id)).map(e=>e.enrollment_id),[enrollment]);
  await assert.rejects(member.refreshRoster(id),e=>e.code==='enrollment_pending');
});

test('a roster/state split never advertises a removed member as approved', {timeout:30000}, async t=>{
  const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
  await member.joinCircle((await f.owner.createInviteLinks(id)).long,{waitMs:0});
  await f.owner.approveEnrollments(id);await member.refreshRoster(id);
  assert.equal(projectMembership(member.selectCircle(id)).phase,'approved');
  await f.owner.removeMember(id,member.keyId);
  const removed=await f.owner.rosterCache(id).get();
  // Force the second file write to fail after roster.json commits. No product
  // function is replaced: the real state writer encounters a real live lock.
  const release=acquireProcessLockSync(join(member.directory,'state.lock'));
  try {await assert.rejects(member.rosterCache(id).set(removed),e=>e.code==='device_busy');}
  finally {release();}
  const cache=await member.rosterCache(id).get();
  assert.ok(!cache.current.payload.members.some(m=>m.key_id===member.keyId));
  const splitPhase=projectMembership(member.selectCircle(id)).phase;
  // Equal-byte replay must repair the split before checking the desired result.
  await member.rosterCache(id).set(removed);
  assert.equal(member.selectCircle(id).rosterDigest,removed.highestAcceptedDigest);
  assert.equal(splitPhase,'unknown');
});

test('a fully applied removal clears verified membership', async t=>{
  const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
  await member.joinCircle((await f.owner.createInviteLinks(id)).long,{waitMs:0});
  await f.owner.approveEnrollments(id);await member.refreshRoster(id);
  await f.owner.removeMember(id,member.keyId);
  const removed=await f.owner.rosterCache(id).get();
  await member.rosterCache(id).set(removed);
  assert.equal(member.selectCircle(id).rosterDigest,removed.highestAcceptedDigest);
  assert.equal(member.selectCircle(id).rosterMembershipVerified,false);
});

test('late saved read is fenced after leaving, including a cache restart',async t=>{
  const f=await realCoordinator(t),directory=join(f.dir,'saved'),key=jobReadKey(f.circle.id,'job');
  const reads=createSavedReads({directory});
  reads.remember(key,{state:'queued'},reads.ticket(key));
  const ticket=reads.ticket(key);
  reads.forgetCircle(f.circle.id);
  reads.remember(key,{state:'queued'},ticket);
  assert.equal(reads.recall(key),null);
  assert.equal(createSavedReads({directory}).recall(key),null);
});
