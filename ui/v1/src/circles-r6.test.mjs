import test from 'node:test';
import assert from 'node:assert/strict';
import {circlePerson, circlesListVM, devicesListVM, joinOutcomeVM} from './circles-view.mjs';
import {peopleVM} from './people-view.mjs';
import {onboardingVM} from './onboarding.mjs';
import {Circles, Circle, Devices, JoinOutcome} from './circles.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';

// O5: the join result is a snapshot from the moment of joining. The circle list is the truth.
test('O5: a join that the refreshed list shows as joined reads "You joined", never "not in the circle"', () => {
  const stale = {id: 'book', name: 'Book club', enrollment: {state: 'pending'}, joinInfo: {approval: 'automatic', ownerName: 'Alex Example'}};
  const live = {...stale, origin: 'https://c.example', enrollment: {state: 'approved'}, rosterMembershipVerified:true};
  const waiting = joinOutcomeVM(stale, [{...stale, origin: 'https://c.example'}]);
  assert.equal(waiting.joined, false);
  assert.doesNotMatch(waiting.message, /not in the circle yet|not joined/i);
  const done = joinOutcomeVM(stale, [live]);
  assert.deepEqual([done.joined, done.message, done.circleId, done.closeForm], [true, 'You joined the circle “Book club”', 'book', true]);
  assert.equal(joinOutcomeVM(stale, [{...live, enrollment: undefined}]).joined, true);
  assert.equal(joinOutcomeVM(null, [live]), null);
  // approved at join time, list not refreshed yet: still joined
  assert.equal(joinOutcomeVM({...live}, []).joined, true);
});

test('O5: the join panel closes and a persistent link remains once joined', () => {
  const html = renderFixture(JoinOutcome, {outcome: joinOutcomeVM({id: 'book', name: 'Book club', origin:'https://c.example', enrollment: {state: 'approved'}, rosterMembershipVerified:true}, [])});
  assert.match(renderedText(html), /You joined the circle “Book club”/);
  assert.match(html, /href="#\/circle\/book"/);
  assert.equal(renderFixture(JoinOutcome, {outcome: null}), '');
});

test('O5: Circles renders no join panel when nothing is being joined and no stale "not in the circle" copy', () => {
  const circle = {id: 'book', name: 'Book club', origin: 'https://c.example', enrollment: {state: 'approved'}, rosterMembershipVerified:true, joinInfo: {ownerName: 'Alex Example'}};
  const text = renderedText(renderFixture(Circles, {circles: [circle], data: {circles: [circle], devices: {circles: []}}, api: {}, mutate() {}, refresh() {}}));
  assert.doesNotMatch(text, /not in the circle yet/);
});

// N5: the card and the suggestions leave once the computer has a result or has lent.
test('N5: Getting started retires after the first result; the step label names the action it asks for', () => {
  const home = {lending: {enabled: false}};
  const joined = {id: 'c2', origin: 'https://c.example', name: 'Ana', enrollment: {state: 'approved'}, rosterMembershipVerified:true};
  const sent = (state, extra = {}) => ({job_digest: 'sha256:' + 'a'.repeat(64), role: 'sent', state, circle: {id: 'c2'}, ...extra});
  const fresh = onboardingVM({home, circles: [joined], jobs: []});
  assert.equal(fresh.progress.current.label, 'Send a job');
  assert.equal(fresh.progress.current.turn, 'Your turn: send a job');
  const moving = onboardingVM({home, circles: [joined], jobs: [sent('Waiting')]});
  assert.equal(moving.progress.current.label, 'Waiting for acceptance');
  const ready = onboardingVM({home, circles: [joined], jobs: [sent('Finished')]});
  assert.equal(ready.progress, null);
  assert.deepEqual(ready.suggestions, []);
  const reviewed = onboardingVM({home, circles: [joined], jobs: [sent('Finished', {borrowerOutcome: {verdict: 'unused'}}), sent('Finished'), sent('Finished')]});
  assert.equal(reviewed.progress, null);
});

test('N5: a computer that ran jobs for others sees neither the card nor first-job suggestions', () => {
  const joined = {id: 'c2', origin: 'https://c.example', name: 'Ana', enrollment: {state: 'approved'}, rosterMembershipVerified:true};
  const vm = onboardingVM({home: {lending: {enabled: true}}, circles: [joined], jobs: [{role: 'ran', state: 'Finished', job_digest: 'x'}]});
  assert.equal(vm.progress, null);
  assert.deepEqual(vm.suggestions, []);
});

// M2
test('M2: circle rows carry no filler when the host is unknown', () => {
  const [row] = circlesListVM([{id: 'c', name: 'Friends', origin: 'https://c.example', rosterMembershipVerified:true}], {circles: [{circle: 'c', members: [{}, {}]}]});
  assert.equal(row.meta, '2 computers');
  assert.doesNotMatch(row.meta, /Shared with your circle/);
  const circle = {id: 'c', name: 'Friends', origin: 'https://c.example', rosterMembershipVerified:true};
  const data = {circles: [circle], devices: {fingerprint: 'self', circles: [{circle: 'c', members: [{key_id: 'self'}, {key_id: 'k', device_name: 'kestrel'}]}]}};
  assert.doesNotMatch(renderedText(renderFixture(Circle, {circles: [circle], data, id: 'c', api: {}, mutate() {}, refresh() {}})), /Shared with your circle/);
});

// O8
test('O8: person names beat device names; a nickname beats the person name', () => {
  assert.equal(circlePerson({personName: 'Maya Okafor', device_name: 'kestrel'}), 'Maya Okafor');
  assert.equal(circlePerson({localName: 'Mo', personName: 'Maya Okafor', device_name: 'kestrel'}), 'Mo');
  assert.equal(circlePerson({personName: 'sha256:' + 'a'.repeat(64), device_name: 'kestrel'}), 'kestrel');
});

test('O8: Devices names the person and keeps the computer name beside it', () => {
  const devices = {fingerprint: 'self', name: 'sandpiper', ownerName: 'Alex Example', circles: [{circle: 'c', members: [{key_id: 'self'}, {key_id: 'k', device_name: 'kestrel', personName: 'Maya Okafor'}]}]};
  const row = devicesListVM(devices, [{id: 'c', name: 'Book club', origin: 'https://c.example'}]).rows.find(r => r.id === 'k');
  assert.equal(row.name, 'Maya Okafor');
  assert.match(row.meta, /^kestrel · Book club$/);
});

test('O8: circle member rows read "Maya Okafor · kestrel"', () => {
  const circle = {id: 'c', name: 'Book club', origin: 'https://c.example', owned: true};
  const data = {circles: [circle], devices: {fingerprint: 'self', name: 'sandpiper', ownerName: 'Alex Example', circles: [{circle: 'c', members: [{key_id: 'self', device_name: 'sandpiper'}, {key_id: 'k', device_name: 'kestrel', personName: 'Maya Okafor'}]}]}};
  const text = renderedText(renderFixture(Circle, {circles: [circle], data, id: 'c', api: {}, mutate() {}, refresh() {}}));
  assert.match(text, /Maya Okafor · kestrel/);
  assert.doesNotMatch(text, /kestrel · Member/);
  const alone = renderedText(renderFixture(Circle, {circles: [circle], data: {...data, devices: {...data.devices, circles: [{circle: 'c', members: [{key_id: 'k', device_name: 'kestrel'}]}]}}, id: 'c', api: {}, mutate() {}, refresh() {}}));
  assert.doesNotMatch(alone, /kestrel · kestrel/);
});

test('O8: people lists name a person by nickname, then their own name, then the computer', () => {
  const people = [{personId: 'p', name: '', role: 'member', computers: [{key_id: 'k'}]}];
  assert.equal(peopleVM(people, [{key_id: 'k', device_name: 'kestrel', personName: 'Maya Okafor'}], 'self')[0].name, 'Maya Okafor');
  assert.equal(peopleVM(people, [{key_id: 'k', device_name: 'kestrel', personName: 'Maya Okafor', localName: 'Mo'}], 'self')[0].name, 'Mo');
  assert.equal(peopleVM(people, [{key_id: 'k', device_name: 'kestrel'}], 'self')[0].name, 'kestrel');
});

test('a timed-out or last-known members read says so locally, with retry, and never claims the app is loading', () => {
  const circle = {id: 'book', name: 'Book club', origin: 'https://c.example', enrollment: {state: 'approved'}, rosterMembershipVerified:true, joinInfo: {ownerName: 'Alex Example'}};
  const props = {circles: [circle], data: {circles: [circle], devices: {circles: [{circle:'book',members:[],rosterHeld:true}]}}, api: {}, mutate() {}, refresh() {}};
  const timedOut = renderedText(renderFixture(Circles, {...props, errors: {devices: {code:'read_timeout'}}}));
  assert.match(timedOut, /Could not refresh members.*took too long.*Retry members/);
  assert.doesNotMatch(timedOut, /finished loading|Reload/i);
  const lastKnown = renderedText(renderFixture(Circles, {...props, data: {...props.data, devices: {circles: [{circle:'book',members:[],rosterHeld:true,membersLastKnown:true}]}}}));
  assert.match(lastKnown, /Could not refresh members.*last-known.*Retry members/);
  assert.doesNotMatch(renderedText(renderFixture(Circles, props)), /Could not refresh members/);
});

test('stale member data names only affected circles and does not warn on a healthy sibling', () => {
  const healthy = {id: 'healthy', name: 'Healthy circle', origin: 'https://healthy.example', enrollment: {state: 'approved'}, rosterMembershipVerified: true};
  const stale = {id: 'stale', name: 'Offline circle', origin: 'https://offline.example', enrollment: {state: 'approved'}, rosterMembershipVerified: true};
  const circles = [healthy, stale];
  const data = {circles, devices: {circles: [
    {circle: healthy.id, members: [], rosterHeld: true},
    {circle: stale.id, members: [], rosterHeld: true, membersLastKnown: true},
  ]}};
  const props = {circles, data, api: {}, mutate() {}, refresh() {}};
  const list = renderedText(renderFixture(Circles, props));
  assert.match(list, /Could not refresh members in Offline circle.*Counts for affected circles.*last-known.*Retry members/);
  assert.doesNotMatch(list, /Could not refresh members in Healthy circle|Any counts shown are last-known/);
  const healthyProps = {...props, id: healthy.id};
  assert.doesNotMatch(renderedText(renderFixture(Circle, healthyProps)), /Could not refresh members|Retry members/);
  assert.match(renderedText(renderFixture(Circle, {...props, id: stale.id})), /Could not refresh members.*last-known.*Retry members/);
  assert.match(renderedText(renderFixture(Circle, {...healthyProps, errors: {devices: {code: 'read_timeout'}}})), /Could not refresh members.*took too long.*Retry members/);
});
