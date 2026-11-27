import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {MemberAddressBody, MemberOriginsBody, memberAddressCopy} from './member-address.jsx';

// The words and the one next action for each state of this computer's address and of an address request.

const text = (Component, props) => renderedText(renderFixture(Component, props));

test('each member state has one useful next action, and none claims more than has happened', () => {
  const actions = Object.fromEntries(['off', 'approved', 'starting', 'ready', 'sent', 'signed', 'lost'].map(state => [state, memberAddressCopy(state, 'member.example')]));
  assert.deepEqual(Object.entries(actions).map(([state, copy]) => [state, copy.action ?? null]), [
    ['off', 'review'], ['approved', 'start'], ['starting', null], ['ready', 'send'], ['sent', 'check'], ['signed', null], ['lost', 'review']]);
  assert.equal(memberAddressCopy('unavailable'), null, 'a computer that cannot use an address shows nothing');
  for (const state of ['off', 'approved', 'ready', 'sent']) assert.match(actions[state].text, /Nothing is shared|until an owner approves|do not see it/, state);
  assert.doesNotMatch(actions.ready.text + actions.sent.text, /visible to the circle|shared with the circle\./);
  assert.match(actions.signed.text, /signed member list/);
  assert.match(actions.lost.text, /stopped working/);
});

test('the member card renders the state, the public host name and a note, and never a handle or target', () => {
  const html = renderFixture(MemberAddressBody, {view: {state: 'ready', address: 'member.example'}, note: 'The address stopped working, so nothing was sent. Review it again.'});
  const words = renderedText(html);
  assert.match(words, /The address member\.example works/);
  assert.match(words, /Send for approval/);
  assert.match(words, /nothing was sent/);
  assert.doesNotMatch(html, /127\.0\.0\.1|handle|target/);
  assert.equal(text(MemberAddressBody, {view: {state: 'unavailable'}}), '');
});

test('a publisher sees what each request allows, and nothing to approve once it cannot be approved', () => {
  const base = {keyId: 'k', name: 'Maya’s laptop', address: 'member.example', signedAddress: null, proposalDigest: 'sha256:d', rosterEpoch: 3};
  const proposed = renderFixture(MemberOriginsBody, {items: [{...base, state: 'proposed'}]});
  assert.match(renderedText(proposed), /Offers the address member\.example\. Approving adds it to the circle’s signed member list\./);
  assert.match(proposed, />Approve address for Maya’s laptop</);
  for (const [state, pattern] of [['withdrawn', /withdrew the address/], ['expired', /expired\. Ask Maya’s laptop to send it again/]]) {
    const html = renderFixture(MemberOriginsBody, {items: [{...base, state}]});
    assert.match(renderedText(html), pattern, state);
    assert.doesNotMatch(html, /Approve address for/, state);
  }
  const done = renderFixture(MemberOriginsBody, {items: [{...base, state: 'proposed', signedAddress: 'member.example'}]});
  assert.match(renderedText(done), /member\.example is in the signed member list/);
  assert.doesNotMatch(done, /Approve address for/);
});

test('an older host gets a plain unavailable state, and an empty list shows nothing', () => {
  assert.match(text(MemberOriginsBody, {unsupported: true, items: []}), /runs an older Faravan and cannot take computer addresses yet/);
  assert.equal(text(MemberOriginsBody, {items: []}), '');
});
