import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMembershipProjection, projectMembership} from '../lib/v1/membership-projection.mjs';

const states = ['approved', 'pending', 'expired', 'rejected'];
const valid = (phase, enrollmentState = phase, origin = phase === 'approved', rosterMembershipVerified = phase === 'approved', invitationPolicy = 'unknown') => ({
  schemaVersion: 3, kind: 'membership', phase,
  evidence: {enrollmentState, origin, rosterMembershipVerified}, invitationPolicy,
});
const unknown = {schemaVersion:3,kind:'membership',phase:'unknown',
  evidence:{enrollmentState:null,origin:null,rosterMembershipVerified:false},invitationPolicy:'unknown'};

test('verified enrollment determines phase and invitation policy remains separate evidence', () => {
  for (const phase of states) {
    // Only an approval is confirmed by a verified roster; the other phases come from the enrollment answer alone.
    const projection = projectMembership({origin: 'https://circle.example', enrollment: {state: phase},
      rosterMembershipVerified: phase === 'approved', approveEach: true, joinInfo: {approval: 'each'}});
    assert.equal(projection.phase, phase);
    assert.equal(projection.evidence.rosterMembershipVerified,phase==='approved');
    assert.equal(projection.invitationPolicy, 'each');
  }
  assert.equal(projectMembership({origin: 'https://circle.example', owned:true}).phase, 'approved');
  assert.equal(projectMembership({origin: 'https://circle.example', enrollment: {state: 'pending'}, approveEach: false}).phase, 'pending');
});

test('origin alone, malformed enrollment and malformed circle fail closed as unknown', () => {
  for (const circle of [null, [], {}, {origin: null}, {origin: 'https://c'},
    {origin: 'https://c', enrollment: {}}, {origin: 'https://c', enrollment: {state: 'waiting'}}]) {
    assert.equal(projectMembership(circle).phase, 'unknown');
  }
  assert.equal(projectMembership({origin:'https://c',enrollment:{state:'approved'},rosterMembershipVerified:false}).phase,'unknown');
});

test('a host approval is approved only when a verified roster lists this device', () => {
  // The enrollment answer alone is not proof: without an accepted roster the join stays unconfirmed.
  assert.equal(projectMembership({origin:'https://c',enrollment:{state:'approved'}}).phase,'unknown');
  assert.equal(projectMembership({origin:'https://c',enrollment:{state:'approved'},rosterMembershipVerified:true}).phase,'approved');
});

test('legacy projection accepts explicit enrollment evidence but rejects origin-only approval', () => {
  const legacyApproved={schemaVersion:2,kind:'membership',phase:'approved',
    evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown'};
  assert.equal(createMembershipProjection(legacyApproved).phase,'approved');
  assert.equal(createMembershipProjection({...legacyApproved,evidence:{enrollmentState:null,origin:true}}).phase,'unknown');
  assert.equal(createMembershipProjection({schemaVersion:2,kind:'membership',phase:'unknown',
    evidence:{enrollmentState:null,origin:true},invitationPolicy:'each'}).phase,'unknown');
});

test('versioned constructor accepts legal evidence and rejects generated contradictions', () => {
  for (const phase of states) assert.equal(createMembershipProjection(valid(phase)).phase, phase);
  assert.equal(createMembershipProjection(valid('approved', null, true, true)).phase, 'approved');
  assert.equal(createMembershipProjection(valid('unknown', null, true, false)).phase, 'unknown');
  const contradictory = states.flatMap(phase => states.filter(state => state !== phase).map(state =>
    valid(phase, state, true, false)));
  const bad = [
    ...contradictory,
    valid('approved',null,true,false),
    valid('approved','approved',false,true),
    valid('unknown',null,true,true),
    valid('pending','pending',true,true),
    {...valid('pending'), invitationPolicy: 'sometimes'},
    {...valid('pending'), schemaVersion: 1},
    {...valid('pending'), kind: 'lending'},
    {...valid('pending'), evidence: null},
  ];
  for (const candidate of bad) assert.deepEqual(createMembershipProjection(candidate), unknown);
});
