import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { codeFromHash, defaultPhoneName, iosNeedsHomeScreen, pairOutcome, inboxView, cardView, timeLeft, problemText } from '../public/phone/phone-view.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const card = {id: 'a', requester: 'Ana', agent: 'codex', runtimeSeconds: 1200, network: 'internet', sourceFiles: 12,
  startsNow: true, expiresAt: '2026-10-20T12:04:30Z', prompt: 'Fix the parser.'};

test('the QR fragment is read as a code only when it has the code shape', () => {
  assert.equal(codeFromHash('#K7QF2M9D'), 'K7QF-2M9D');
  assert.equal(codeFromHash('#k7qf-2m9d'), 'K7QF-2M9D');
  for (const hash of ['', '#', '#<img src=x>', '#K7QF2M9DX', '#/inbox']) assert.equal(codeFromHash(hash), null, hash);
  // Long s (ſ) upper-cases to S, which is in the code alphabet; the device must refuse it before upper-casing.
  assert.equal(codeFromHash('#K7QFſM9D'), null);
  assert.equal(codeFromHash('#K7QF2M9ı'), null);
});

test('the suggested phone name comes from the platform, never from anything identifying', () => {
  assert.equal(defaultPhoneName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(defaultPhoneName('Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro)'), 'Android device');
  assert.equal(defaultPhoneName('Mozilla/5.0 (iPad; CPU OS 18_0)'), 'iPad');
  assert.equal(defaultPhoneName('Something else'), 'Device');
});

test('iPhone in a Safari tab is told to pair from the Home Screen app, because the two keep separate sign-ins', () => {
  assert.equal(iosNeedsHomeScreen('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', false), true);
  assert.equal(iosNeedsHomeScreen('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', true), false);
  assert.equal(iosNeedsHomeScreen('Mozilla/5.0 (Linux; Android 15)', false), false);
});

test('every pairing state the server can report has a plain outcome, and unknown ones end safely', () => {
  assert.deepEqual(pairOutcome('waiting_for_computer'), {done: false, message: null});
  assert.equal(pairOutcome('paired').done, true);
  assert.match(pairOutcome('rejected').message, /didn.t match/);
  assert.deepEqual([pairOutcome('too_many_phones').done, /Remove one/.test(pairOutcome('too_many_phones').message)], [false, true], 'full is recoverable: keep waiting');
  assert.match(pairOutcome('expired').message, /wasn’t confirmed in time\. Open a new pairing link/, 'a timed-out pairing says so and offers a step on the device');
  for (const state of ['expired', 'cancelled', 'unknown', 'too_many_tries', 'collected', 'something-new']) {
    const outcome = pairOutcome(state);
    assert.equal(outcome.done, true, state);
    assert.match(outcome.message, /new pairing link|Start pairing again/, state);
  }
});

test('time left is honest and never negative', () => {
  assert.equal(timeLeft('2026-10-20T12:04:30Z', NOW), '4 min left');
  assert.equal(timeLeft('2026-10-20T12:00:40Z', NOW), 'Less than a minute left');
  assert.equal(timeLeft('2026-10-20T11:59:00Z', NOW), 'Expired');
  assert.equal(timeLeft(null, NOW), null);
  assert.equal(timeLeft('2026-10-21T11:59:30Z', NOW), '23 h left');
});

test('a card names who, what agent, how long, what network, and shows the prompt only when the server sent it', () => {
  const view = cardView(card, {canAnswer: true, now: NOW});
  assert.equal(view.title, 'Ana');
  assert.deepEqual(view.facts, ['codex', 'Up to 20 min', 'Internet access', '12 files']);
  assert.equal(view.prompt, 'Fix the parser.');
  assert.equal(view.canAnswer, true);
  const hidden = cardView({...card, prompt: undefined, promptHidden: true}, {canAnswer: false, now: NOW});
  assert.equal(hidden.prompt, null);
  assert.match(hidden.promptNote, /view-only access; pair over trusted HTTPS/);
  assert.equal(hidden.canAnswer, false);
  assert.match(hidden.answerNote, /Answer on your computer/);
});

test('the inbox splits into Needs your answer / Answered / Expired with answer attribution', () => {
  const view = inboxView({computer: 'Studio', canAnswer: false, https: false,
    needs: [card], answered: [{...card, id: 'b', state: 'declined', by: 'Pixel 8', at: '2026-10-20T11:50:00Z'}],
    expired: [{...card, id: 'c', state: 'expired', at: '2026-10-20T11:40:00Z'}]}, NOW);
  assert.equal(view.heading, 'Requests for Studio');
  assert.deepEqual(view.sections.map(s => [s.title, s.items.length]), [['Needs your answer', 1], ['Answered', 1], ['Expired', 1]]);
  assert.equal(view.sections[1].items[0].status, 'Not now · answered on Pixel 8', 'the desktop request page’s words');
  assert.equal(view.sections[0].empty, null);
  const empty = inboxView({computer: 'Studio', needs: [], answered: [], expired: []}, NOW);
  assert.equal(empty.sections[0].empty, 'Nothing needs your answer.');
  assert.match(empty.reachNote, /can reach your computer and Faravan is running/);
});

test('problems from the device listener read as recovery steps, never as codes', () => {
  assert.match(problemText({code: 'wrong_code'}), /check the code/i);
  assert.match(problemText({code: 'pairing_not_open'}), /expired or was already used\. Open a new pairing link/);
  assert.match(problemText({code: 'network'}), /tailnet.*awake.*Faravan is running/);
  assert.match(problemText({code: 'not_paired'}), /Open a new pairing link, or pair it again/);
  assert.equal(/_/.test(problemText({code: 'weird_new_code'})), false);
});

test('offers are hidden locally, with the same words as the computer', () => {
  const view = cardView({...card, offer: true}, {canAnswer: true, now: NOW});
  assert.equal(view.declineLabel, 'Not for me');
  assert.match(view.declineNote, /hides.*this computer/);
  const done = inboxView({answered: [{...card, offer: true, state: 'dismissed', by: 'Pixel'}]}, NOW);
  assert.equal(done.sections[1].items[0].status, 'Not for me · answered on Pixel');
});

// The pairing page is used on phones, tablets, laptops and PCs, so its copy never names the kind of device.
// Human copy is any quoted literal with a space; identifiers, paths and storage keys have no space and are not checked.
test('the pairing page says device: heading and button read "Pair this device", and no copy says phone', async () => {
  const { readFile } = await import('node:fs/promises');
  const sources = await Promise.all(['../public/phone/phone.mjs', '../public/phone/phone-view.mjs'].map(file =>
    readFile(new URL(file, import.meta.url), 'utf8')));
  const [page, view] = sources;
  assert.match(page, /el\('h1', \{class: 't-page'\}, 'Pair this device'\)/, 'the pairing page heading');
  assert.match(page, /el\('button', \{class: 'btn btn-primary btn-block', type: 'submit'\}, 'Pair this device'\)/, 'the pairing button');
  for (const source of sources) {
    for (const [literal] of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
      if (!literal.includes(' ')) continue;
      assert.doesNotMatch(literal, /\bphone\b/i, `copy must not say phone: "${literal}"`);
    }
  }
  assert.doesNotMatch(view, /'Phone'/, 'the default device name is not Phone');
});

test('the pairing field takes the code with or without the dash, and a pasted code with spaces is not cut off', async () => {
  const source = await readFile(new URL('../public/phone/phone.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /maxlength: '9'/, 'maxlength 9 cuts a pasted "JK0Z A0XP " before the server sees it');
  assert.match(source, /the dash is optional/, 'the help text says the dash is optional');
});
