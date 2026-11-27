import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

test('join, circle list, and home expose current membership independently of invite policy', {timeout:60000}, async t=>{
  const f=await appFixture(t),owner=await f.start('owner',{autoApprove:false,pollMs:250}),joiner=await f.start('joiner',{joinWaitMs:0});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Membership projection circle'}});
  assert.deepEqual(circle.membershipProjection,{schemaVersion:3,kind:'membership',phase:'approved',
    evidence:{enrollmentState:null,origin:true,rosterMembershipVerified:true},invitationPolicy:'unknown'});
  await api(owner.app,'/api/circles/'+circle.id+'/approval-mode',{method:'POST',body:{approveEach:true}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});

  const joined=await api(joiner.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  assert.equal(joined.enrollment.state,'pending');
  assert.deepEqual(joined.membershipProjection,{schemaVersion:3,kind:'membership',phase:'pending',
    evidence:{enrollmentState:'pending',origin:true,rosterMembershipVerified:false},invitationPolicy:'each'});
  const pendingCircle=(await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id);
  assert.deepEqual(pendingCircle.membershipProjection,joined.membershipProjection);
  assert.deepEqual((await api(joiner.app,'/api/home')).circles.find(item=>item.id===circle.id).membershipProjection,
    joined.membershipProjection);
  const pendingGroup=(await api(joiner.app,'/api/devices')).circles.find(item=>item.circle===circle.id);
  assert.deepEqual([pendingGroup.rosterHeld,pendingGroup.members],[false,[]],'a pending joiner holds no roster, so its empty list is not a count');

  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{enrollmentId:joined.enrollment.enrollment_id}});
  assert.deepEqual(await api(joiner.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}}),{
    state:'approved',membershipProjection:{schemaVersion:3,kind:'membership',phase:'approved',
      evidence:{enrollmentState:'approved',origin:true,rosterMembershipVerified:true},invitationPolicy:'each'}});

  const approvedCircle=(await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id);
  const approvedProjection={schemaVersion:3,kind:'membership',phase:'approved',
    evidence:{enrollmentState:'approved',origin:true,rosterMembershipVerified:true},invitationPolicy:'each'};
  assert.deepEqual(approvedCircle.membershipProjection,approvedProjection);
  assert.equal(approvedCircle.joinInfo.approval,'each');
  assert.deepEqual((await api(joiner.app,'/api/home')).circles.find(item=>item.id===circle.id).membershipProjection,
    approvedProjection);
  const approvedGroup=(await api(joiner.app,'/api/devices')).circles.find(item=>item.circle===circle.id);
  assert.deepEqual(approvedGroup.membershipProjection,approvedProjection);
  assert.equal(approvedGroup.rosterHeld,true);
  assert.ok(approvedGroup.members.length>=2);
});
