import test from 'node:test';
import assert from 'node:assert/strict';
import {TELEMETRY_COPY} from '../../../lib/v1/telemetry/copy.mjs';
import {privacyCardModel, firstRunModel, firstRunShown, selectedLevel, envLine, stateSentence, chooseBody, recordingsBody} from './telemetry-model.mjs';
import {PrivacyCard, FirstRunCard} from './telemetry-ui.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';

const view = (over = {}) => ({level: null, effective: 'off', reason: {kind: 'notice_pending'}, region: null, notice: {shown: false, pending: true}, uploadable: true, endpoint_configured: true,
  version: '0.1.0', queued: {counts: 0, diagnostics: 0, quota: 0}, queued_bytes: 0, upload: {}, ...over});
const chosen = level => view({level, effective: level, reason: {kind: 'choice'}, notice: {shown: true, pending: false}});
const regionDefault = view({effective: 'on', reason: {kind: 'region_default'}, region: 'US', notice: {shown: true, pending: false}});
const checked = model => model.choices.filter(choice => choice.checked).map(choice => choice.level);

test('card: the copy is the shared copy, word for word, two choices in order', () => {
  const model = privacyCardModel(chosen('on'));
  assert.equal(model.title, TELEMETRY_COPY.settings.title);
  assert.equal(model.intro, TELEMETRY_COPY.settings.intro);
  assert.equal(model.readers, TELEMETRY_COPY.settings.readers);
  assert.deepEqual(model.links, TELEMETRY_COPY.settings.links);
  assert.deepEqual(model.choices.map(choice => [choice.level, choice.label, choice.detail]), TELEMETRY_COPY.settings.choices.map(choice => [choice.level, choice.label, choice.detail]));
  assert.deepEqual(model.choices.map(choice => choice.level), ['on', 'off']);
});

test('card: the radio follows the choice, else the launch default, else nothing', () => {
  for (const level of ['on', 'off']) assert.deepEqual(checked(privacyCardModel(chosen(level))), [level]);
  assert.deepEqual(checked(privacyCardModel(view({effective: 'on', reason: {kind: 'default'}}))), ['on']);
  assert.deepEqual(checked(privacyCardModel(regionDefault)), [], 'an unknown reason does not select a level');
  assert.deepEqual(checked(privacyCardModel(view())), [], 'the pending notice selects nothing');
  assert.deepEqual(checked(privacyCardModel(view({reason: {kind: 'notice_pending'}, notice: {shown: false, pending: true}}))), []);
  assert.equal(selectedLevel(null), null);
  assert.deepEqual(checked(privacyCardModel(chosen('on'), {asked: 'off'})), ['off'], 'a click shows at once, before the app answers');
  assert.deepEqual(checked(privacyCardModel(view(), {asked: 'on'})), ['on']);
  assert.equal(privacyCardModel(chosen('off')).disabled, false);
});

test('card: an environment switch says so and disables the radios', () => {
  const env = view({reason: {kind: 'env', env: 'FARAVAN_NO_TELEMETRY'}});
  const model = privacyCardModel(env);
  assert.equal(model.envLine, 'Off on this computer because FARAVAN_NO_TELEMETRY is set.');
  assert.equal(model.disabled, true);
  assert.equal(envLine(chosen('on')), null);
  const html = renderFixture(PrivacyCard, {view: env});
  assert.match(html, /<fieldset[^>]*disabled/);
  assert.match(renderedText(html), /Off on this computer because FARAVAN_NO_TELEMETRY is set\./);
});

test('card renders the exact copy, two radios, and the three links', () => {
  const html = renderFixture(PrivacyCard, {view: chosen('on')});
  const text = renderedText(html);
  for (const part of [TELEMETRY_COPY.settings.title, TELEMETRY_COPY.settings.intro, TELEMETRY_COPY.settings.readers, ...TELEMETRY_COPY.settings.choices.flatMap(c => [c.label, c.detail])]) assert.ok(text.includes(part), part);
  assert.equal((html.match(/type="radio"/g) || []).length, 2);
  assert.equal((html.match(/checked/g) || []).length, 1);
  assert.match(html, /href="#\/you\/data\/telemetry"[^>]*>See what we send</);
  assert.match(text, /Privacy details/);
  assert.match(text, /Get a new random ID/);
  assert.match(html, /id="telemetry-details"[^>]*hidden/, 'privacy details start closed');
  for (const line of TELEMETRY_COPY.privacyDetails) assert.ok(renderedText(html).includes(line.replace(/`/g, '`')), line.slice(0, 30));
});

test('first run: shows while the notice is pending, and not after a choice', () => {
  assert.equal(firstRunShown(view()), true);
  assert.equal(firstRunShown(view({reason: {kind: 'notice_pending'}, level: null, notice: {shown: false, pending: true}, region: 'US'})), true);
  assert.equal(firstRunShown(chosen('on')), false);
  assert.equal(firstRunShown(regionDefault), false);
  assert.equal(firstRunShown(null), false);
  assert.equal(renderFixture(FirstRunCard, {view: chosen('on')}), '');
});

test('first run defaults to reports on without asking for a region or a choice', () => {
  for (const region of ['DE', 'GB', 'CH', 'FR', 'NO', 'US', '', null, undefined]) {
    const model = firstRunModel(view(), region);
    assert.equal(model.recordsNotice, true);
    assert.equal(model.buttons, undefined, 'no choice is offered in the notice');
    assert.equal(model.body, TELEMETRY_COPY.firstRun.body);
  }
});

test('first run is one short sentence with a Settings link and a named close control, and no choice buttons', () => {
  const html = renderFixture(FirstRunCard, {view: view()});
  const text = renderedText(html);
  assert.ok(text.includes(TELEMETRY_COPY.firstRun.body));
  assert.ok(text.includes('Change in Settings'));
  assert.equal((html.match(/<p /g) || []).length, 1, 'one line');
  assert.equal((html.match(/<button /g) || []).length, 1, 'only the close control');
  assert.match(html, /aria-label="Close"/);
  assert.match(html, /href="#\/you\/data"/);
  assert.match(html, /<aside[^>]*role="status"/, 'a status notice, not a dialog');
  assert.doesNotMatch(html, /role="(alert)?dialog"|aria-modal|<select|<h[1-6]|Keep reports on|Turn reports off|Where do you live/);
  assert.ok(text.length < 160, 'the notice is short: ' + text.length);
});

test('Settings shows retention and the off switch without opening privacy details', () => {
  const html = renderFixture(PrivacyCard, {view: chosen('on')});
  const visible = html.slice(0, html.indexOf('<section id="telemetry-details"'));
  assert.ok(renderedText(visible).includes(TELEMETRY_COPY.settings.retention));
  assert.ok(renderedText(visible).includes(TELEMETRY_COPY.settings.turnOff));
  const unavailable = renderFixture(PrivacyCard, {view: view({uploadable: false})});
  assert.ok(renderedText(unavailable).includes(TELEMETRY_COPY.settings.unavailable));
});

test('the choice body carries only the one setting', () => {
  assert.deepEqual(chooseBody('on'), {level:'on'});
  assert.deepEqual(chooseBody('on','DE',true), {level:'on'});
  assert.deepEqual(chooseBody('off'), {level:'off'});
});

test('the state sentence uses the card wording', () => {
  assert.equal(stateSentence(chosen('on')), 'On. ' + TELEMETRY_COPY.settings.choices[0].detail);
  assert.equal(stateSentence(chosen('on')), 'On. ' + TELEMETRY_COPY.settings.choices[0].detail);
  assert.equal(stateSentence(chosen('off')), 'Off. ' + TELEMETRY_COPY.settings.choices[1].detail);
  assert.equal(stateSentence(view({reason: {kind: 'env', env: 'DO_NOT_TRACK'}})), 'Off on this computer because DO_NOT_TRACK is set.');
});

test("allowance data is included in ON with no allowance checkbox", () => {
  const html = renderFixture(PrivacyCard, {view:chosen('on')});
  assert.doesNotMatch(html, /allowance[^<]*<\/b>/); assert.equal((html.match(/type="checkbox"/g) || []).length, 1, "only the recordings choice");
  assert.deepEqual(privacyCardModel(chosen('on')).choices.map(c=>c.level), ['on','off']);
});

test('Settings shows a separate recordings choice, off by default, and it posts only the recordings boolean', () => {
  const html = renderFixture(PrivacyCard, {view: chosen('on')});
  assert.match(html, /Also send screen recordings \(text and inputs hidden\)/);
  assert.match(html, /name="telemetry-recordings"/);
  assert.doesNotMatch(html, /name="telemetry-recordings"[^>]*checked/);
  assert.equal(privacyCardModel(chosen('on')).recordings.checked, false);
  assert.equal(privacyCardModel({...chosen('on'), recordings: true}).recordings.checked, true);
  assert.equal(privacyCardModel(chosen('off')).recordings.disabled, true, 'needs reports On');
  assert.equal(privacyCardModel({...chosen('off'), recordings: true}).recordings.checked, false);
  assert.deepEqual(recordingsBody(true), {recordings: true});
  assert.deepEqual(chooseBody('on'), {level: 'on'}, 'the reports choice body is unchanged');
});
