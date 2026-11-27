import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import renderToString from 'preact-render-to-string';
import {ProjectPickerBody} from './project-picker.jsx';
import {HostChoose} from './host.jsx';
import {composeVM, hostComputerReference, hostFactsFor, hostStatusVM, hostStopCopy, nameHostComputerInCopy} from './view-models.mjs';
import {renderedText} from './render.test-helper.mjs';

const phoneSession = {computer: "Tessa's desktop", phone: {label: 'Pixel 8', scopes: ['inbox:read']}};
const localSession = {kind: 'local', label: 'Browser on this computer'};
const repo = {path: '/home/sam/code/sandbox', name: 'sandbox'};
const callbacks = {onQuery() {}, onBrowse() {}, onChoose() {}, onClose() {}};
const renderTheme = (Component, props, theme) => renderToString(
  h('div', {'data-theme': theme}, h(Component, props)),
);
const pickerProps = viewerSession => ({
  viewerSession,
  data: {recent: [], repos: [repo]},
  browse: {path: '/home/sam', home: '/home/sam', folders: []},
  ...callbacks,
});
const choice = {method: 'tailscale', address: '', domain: '', name: ''};
const hostProps = viewerSession => ({viewerSession, choice, onChoice() {}, onStart() {}});

for (const theme of ['light', 'dark']) {
  test(`paired-phone folder copy names the host in ${theme} theme`, () => {
    const html = renderTheme(ProjectPickerBody, pickerProps(phoneSession), theme);
    const text = renderedText(html);
    assert.match(html, new RegExp(`data-theme="${theme}"`));
    assert.match(text, /Projects on Tessa's desktop/);
    assert.match(text, /Projects stay on Tessa's desktop until you send a job\./);
    assert.doesNotMatch(text, /Projects? (?:on|stay on) this computer/);
  });

  test(`paired-phone hosting copy names the host in ${theme} theme`, () => {
    const html = renderTheme(HostChoose, hostProps(phoneSession), theme);
    const text = renderedText(html);
    assert.match(html, new RegExp(`data-theme="${theme}"`));
    assert.match(hostStatusVM({configured: false}, {viewerSession: phoneSession}).title, /Start a circle on Tessa's desktop/);
    assert.match(text, /How friends reach Tessa's desktop/);
    assert.match(text,/Friends with access to the same private network/);
    assert.match(text, /Tessa's desktop runs the circle\./);
    assert.match(text, /Jobs, code and results kept on Tessa's desktop/);
    assert.match(text, /jobs already sent wait on Tessa's desktop/i);
    assert.doesNotMatch(text, /this computer/i);
    assert.doesNotMatch(text, /wait here|kept here/i);
  });
}

test('the host computer keeps local wording for its local browser session', () => {
  const picker = renderedText(renderTheme(ProjectPickerBody, pickerProps(localSession), 'light'));
  const host = renderedText(renderTheme(HostChoose, hostProps(localSession), 'light'));
  assert.match(picker, /Projects on this computer/);
  assert.match(picker, /Projects stay on this computer until you send a job\./);
  assert.equal(hostStatusVM({configured: false}, {viewerSession: localSession}).title, 'Start a circle on this computer');
  assert.match(host, /How friends reach this computer/);
  assert.match(host, /This computer runs the circle\./);
  const stopped = hostStatusVM({configured: true, running: false, name: 'Weekend projects', circle: 'c1'}, {viewerSession: phoneSession});
  assert.match(stopped.banner.text, /Jobs already sent wait on Tessa's desktop/);
  assert.match(stopped.banner.text, /Start it again on Tessa's desktop/);
  assert.equal(nameHostComputerInCopy('Your data stays here until you delete it.', "Tessa's desktop"), 'Your data stays on Tessa\'s desktop until you delete it.');
  assert.equal(hostFactsFor(null)[0].text, 'This computer runs the circle. While it is asleep or off, nobody in the circle can send or get jobs; jobs already sent wait here.');
});

test('only an explicit phone or remote session changes the viewer perspective', () => {
  assert.equal(hostComputerReference(phoneSession), "Tessa's desktop", 'the phone inbox session explicitly names its host');
  assert.equal(hostComputerReference({kind: 'phone', scopes: ['inbox:read']}, "Tessa's desktop"), "Tessa's desktop");
  assert.equal(hostComputerReference({kind: 'remote'}, "Tessa's desktop"), "Tessa's desktop");
  assert.equal(hostComputerReference({kind: 'local', computer: "Other desktop"}, "Tessa's desktop"), null);
  assert.equal(hostComputerReference({}, "Tessa's desktop"), null, 'an unknown context keeps local wording');
  assert.equal(hostComputerReference({kind: 'unexpected'}, "Tessa's desktop"), null, 'an unknown session kind keeps local wording');
});

test('host copy never rewrites user supplied circle names', () => {
  const stopped = hostStatusVM({configured: true, running: false, name: 'Here and there', circle: 'c1'}, {viewerSession: phoneSession});
  assert.equal(stopped.banner.headline, "Here and there isn’t running on Tessa's desktop.");
  const stop = hostStopCopy({circles: [{name: 'Here and there'}, {name: 'This computer'}]}, "Tessa's desktop");
  assert.equal(stop.members, 'Members of Here and there and This computer cannot send or get jobs.');
  assert.equal(stop.data, "Stopping hosting does not delete data on Tessa's desktop. Jobs, code and results are still deleted 30 days after each job ends.");
  assert.equal(nameHostComputerInCopy('This computer runs the circle.', 'Here and there'), 'Here and there runs the circle.');
});

test('sentence-leading copy preserves saved host name casing and capitalizes the fallback', () => {
  assert.equal(hostFactsFor('iMac')[0].text, 'iMac runs the circle. While it is asleep or off, nobody in the circle can send or get jobs; jobs already sent wait on iMac.');
  const fallback = hostComputerReference({kind: 'phone'}, null);
  assert.equal(nameHostComputerInCopy('This computer runs the circle.', fallback), 'The host computer runs the circle.');
});

test('compose empty state names the remote host when it offers starting a circle', () => {
  const remote = composeVM({circle: {id: 'c', state: {networked: false}}, viewerSession: phoneSession, computerName: "Tessa's desktop"});
  const local = composeVM({circle: {id: 'c', state: {networked: false}}, viewerSession: localSession});
  assert.equal(remote.send.why, "Start a circle on Tessa's desktop, or join with an invitation.");
  assert.equal(local.send.why, 'Start a circle on this computer, or join with an invitation.');
});
