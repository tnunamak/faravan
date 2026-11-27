import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {formatMembership, membershipProjectionFor} from './membership-projection-view.mjs';

const projected = (phase, enrollmentState = phase, origin = true, invitationPolicy = 'unknown') => ({
  schemaVersion: 2, kind: 'membership', phase, evidence: {enrollmentState, origin}, invitationPolicy,
});

test('explicit projection wins over conflicting raw enrollment and invite configuration', () => {
  const circle = {origin: 'https://c', enrollment: {state: 'pending'}, approveEach: true,
    joinInfo: {approval: 'each'}, membershipProjection: projected('approved')};
  assert.equal(formatMembership(circle).phase, 'approved');
  assert.equal(formatMembership(circle, {surface: 'outcome'}).joined, true);
  assert.equal(formatMembership(circle, {surface: 'outcome'}).message, 'You joined this circle');
});

test('an approved join says the same thing in the outcome and in the banner', () => {
  const circle = {name: 'Book club', origin: 'https://c', membershipProjection: projected('approved')};
  const outcome = formatMembership(circle, {surface: 'outcome'}).message;
  const banner = formatMembership(circle, {surface: 'banner'}).message;
  assert.equal(outcome, 'You joined the circle “Book club”');
  assert.equal(banner, outcome);
});

test('explicit invalid projection stays unknown and never falls back to raw joined state', () => {
  const circle = {origin: 'https://c', enrollment: {state: 'approved'}, membershipProjection: {schemaVersion: 2}};
  assert.equal(membershipProjectionFor(circle).phase, 'unknown');
  assert.equal(formatMembership(circle, {surface: 'outcome'}).joined, false);
  assert.match(formatMembership(circle, {surface: 'outcome'}).message, /not confirmed/);
});

test('one projection gives matching list, detail and join outcome phases', () => {
  for (const phase of ['approved', 'pending', 'expired', 'rejected', 'unknown']) {
    const enrollmentState = ['approved', 'pending', 'expired', 'rejected'].includes(phase) ? phase : null;
    const circle = {id: 'c', name: 'Friends', origin: 'https://c', joinInfo: {ownerName: 'Ana', approval: 'each'},
      membershipProjection: projected(phase, enrollmentState, phase === 'approved')};
    const list = formatMembership(circle);
    const detail = formatMembership(circle, {surface: 'banner'});
    const outcome = formatMembership(circle, {surface: 'outcome'});
    assert.equal(list.phase, detail.phase);
    assert.equal(list.phase, outcome.phase);
    assert.equal(list.joined, outcome.joined);
    assert.equal(list.waiting, detail.waiting);
  }
});

test('invitation wording appears only for pending membership', () => {
  const circle = {origin: 'https://c', joinInfo: {approval: 'each'}, membershipProjection: projected('approved')};
  assert.doesNotMatch(formatMembership(circle, {surface: 'banner'}).message, /Waiting for/);
  const pending = {...circle, membershipProjection: projected('pending', 'pending', true, 'each')};
  assert.match(formatMembership(pending, {surface: 'banner'}).message, /approve this computer/);
  const unknown = {...circle, membershipProjection: projected('unknown', null, false)};
  assert.doesNotMatch(formatMembership(unknown, {surface: 'banner'}).message, /invitation|approve/);
});

test('an uncertain join says the host was unreachable and offers a retry check',()=>{
  const circle={id:'c',origin:'https://c',joinIntent:{outcome:'unknown'},membershipProjection:{
    schemaVersion:3,kind:'membership',phase:'unknown',
    evidence:{enrollmentState:null,origin:true,rosterMembershipVerified:false},invitationPolicy:'each'}};
  for(const surface of ['banner','join-status','outcome']) {
    const view=formatMembership(circle,{surface});
    assert.match(view.message,/Couldn’t reach the host\. Faravan will retry this join\./);
    assert.equal(view.waiting,true);
  }
  assert.equal(formatMembership({origin:'https://c'}).phase,'unknown');
});

test('migrated membership consumers do not classify raw enrollment state', () => {
  const files = ['circles-view.mjs', 'circles.jsx', 'compose-model.mjs', 'onboarding.mjs', 'member-host.jsx',
    'main.jsx', 'lend.jsx', 'helpers.mjs', 'view-models.mjs'];
  for (const file of files) {
    const source = readFileSync(new URL('./' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /enrollment\s*\?\.\s*state|enrollment\s*\.\s*state/, file + ' uses membershipProjectionFor/formatMembership');
  }
});

test('safe-name leaf keeps the membership boundary out of helpers import cycles', () => {
  const boundary = readFileSync(new URL('./membership-projection-view.mjs', import.meta.url), 'utf8');
  const helpers = readFileSync(new URL('./helpers.mjs', import.meta.url), 'utf8');
  assert.match(boundary, /from '\.\/safe-name\.mjs'/);
  assert.doesNotMatch(boundary, /from '\.\/helpers\.mjs'/);
  assert.match(helpers, /import \{safeName\} from '\.\/safe-name\.mjs'/);
  assert.match(helpers, /export \{safeName\}/);
});
