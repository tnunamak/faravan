import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';

// The two-state Stop's front door (design 1119 item 4): only the submitting borrower or the circle's
// steward may cancel, enforced where the cancellation enters. Authority revocation is immediate;
// compute stopping is observed separately, and the local safety Stop and exact cleanup stay untouched
// (their paths are covered by stop-statechart-paths.test.mjs).

const input=id=>({circle:id,prompt:'Steward front door probe',
  git:'https://github.com/example/app.git@'+'a'.repeat(40),harness:'claude-code',send_anyway:true});

async function join(c,owner,name) {
  const device=await c.device(name);
  await device.joinCircle((await owner.createInviteLinks(c.circle.id)).long,{deviceName:name});
  await owner.approveEnrollments(c.circle.id);
  await device.refreshRoster(c.circle.id);
  return device;
}

test('a steward may cancel another member\u2019s job; a plain member may not', async t => {
  const c=await realCoordinator(t),owner=c.owner,id=c.circle.id;
  const borrower=await join(c,owner,'borrower'), steward=await join(c,owner,'steward'), plain=await join(c,owner,'plain');
  await owner.setBackupSteward(id,steward.keyId);
  await steward.refreshRoster(id);
  assert.equal(steward.selectCircle(id).steward,true,'the roster carries the steward authority');

  const operations=device=>createJobOperations({device,clock:()=>Math.floor(Date.now()/1000)});
  const submitted=await operations(borrower).submit(input(id));
  const client=await borrower.client(id);

  // A plain member is refused at the front door, before any state changes.
  await assert.rejects(operations(plain).cancel({digest:submitted.jobDigest,circle:id}),
    error=>error.code==='forbidden');
  assert.equal((await client.getJob(submitted.jobDigest)).state,'queued','a refused cancel changes nothing');

  // The steward cancels: authority is revoked at once; compute stopping is its own observed fact.
  const ack=await operations(steward).cancel({digest:submitted.jobDigest,circle:id});
  assert.equal(ack.authority_revoked,true);
  assert.equal(ack.compute_stopped,true,'nothing started, so compute is already stopped');
  const view=await client.getJob(submitted.jobDigest);
  assert.equal(view.state,'cancelled');
  assert.equal(view.current_attempt?.compute_stopped??true,true);

  // The borrower keeps their own front-door right on a later job.
  const second=await operations(borrower).submit({...input(id),prompt:'Borrower front door probe'});
  const own=await operations(borrower).cancel({digest:second.jobDigest,circle:id});
  assert.equal(own.authority_revoked,true);
  assert.equal((await client.getJob(second.jobDigest)).state,'cancelled');
});
