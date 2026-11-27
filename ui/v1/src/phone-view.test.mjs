import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneVM, phoneErrorText, scopeLines } from './phone-view.mjs';
import { Phone } from './phone.jsx';
import { renderFixture, renderedText } from './render.test-helper.mjs';

// Fixtures follow the real GET /api/phone object (flat; briefs/shell-access-integration.md REVISION 3).
const NOW = Date.parse('2026-10-20T12:00:00Z');
const base = {confirmHere: true, computer: 'Studio Mac', enabled: false, address: null, hostname: null, https: false, certFile: null, keyFile: null, origin: null,
  reach: {state: 'off', headline: 'Device access is off', facts: ['This computer accepts connections only from itself.']},
  addresses: [{address: '10.23.1.20', interface: 'wlan0', kind: 'lan'}], phones: [], pairing: null};
const on = {...base, enabled: true, address: '10.23.1.20', origin: 'http://10.23.1.20:47321',
  reach: {state: 'http', headline: 'Paired devices can see requests, not answer them', facts: ['To answer from a paired device, add an HTTPS certificate that device trusts.']},
  phones: [{id: 'p1', label: 'Pixel 7', kind: 'phone', scopes: ['inbox:read'], created_at: NOW - 86400000 * 3, last_used_at: NOW - 7200000}]};
const waiting = {...on, pairing: {id: 'w1', state: 'waiting', code: 'K7QF-2M9D', expiresAt: new Date(NOW + 4 * 60000 + 10000).toISOString(),
  phrase: null, phone: null, url: 'http://10.23.1.20:47321/pair#K7QF2M9D', qr: {size: 9, d: 'M4 4h1v1h-1z'}, scopes: ['inbox:read']}};
const claimed = {...on, pairing: {id: 'w1', state: 'claimed', code: null, expiresAt: new Date(NOW + 60000).toISOString(),
  phrase: ['amber', 'otter', 'lamp'], phone: {label: 'Pixel 8', address: '10.23.1.31'}, url: null, qr: null, scopes: ['inbox:read']}};

test('loading, and anything that is not the backend object, draws safely with empty lists', () => {
  for (const value of [null, undefined, {}, {access: {enabled: true}}]) {
    const vm = phoneVM(value);
    assert.equal(vm.state, 'loading');
    assert.deepEqual(vm.phones, []);
  }
  assert.match(renderFixture(Phone, {initial: null}), /Pairing/);
});

test('states come from enabled, reach and pairing, never guessed', () => {
  assert.equal(phoneVM(base).state, 'off');
  assert.equal(phoneVM(on).state, 'on');
  assert.equal(phoneVM({...on, reach: {state: 'problem', headline: 'Device access is not running', facts: ['x']}}).state, 'problem');
  assert.equal(phoneVM(waiting, {now: NOW}).state, 'waiting');
  assert.equal(phoneVM(claimed, {now: NOW}).state, 'claimed');
  assert.equal(phoneVM({...on, pairing: {...claimed.pairing, state: 'rejected'}}).ended,
    'Pairing stopped because the words didn’t match. No device was paired.');
  assert.equal(phoneVM({...on, pairing: {...claimed.pairing, state: 'cancelled'}}).ended,
    'Pairing was cancelled. Start again when your device is ready.');
  assert.match(phoneVM(waiting, {now: NOW}).countdown, /5 more minutes/);
  assert.match(phoneVM(waiting, {now: NOW + 10 * 60000}).countdown, /expired/);
});

test('what a device may do comes from its scopes: view only unless the backend granted answering', () => {
  assert.deepEqual(scopeLines(['inbox:read']).short, 'View only');
  assert.match(scopeLines(['inbox:read']).cannot[0], /needs HTTPS/);
  assert.equal(scopeLines(['inbox:read', 'requests:answer']).short, 'Can answer requests');
  assert.equal(scopeLines(undefined).can.length, 0);
  assert.equal(phoneVM(on).phones[0].access, 'View only');
});

test('the waiting card draws the QR as data and keeps the code out of the shown link', () => {
  const html = renderFixture(Phone, {initial: waiting, now: NOW});
  assert.match(html, /<svg class="phone-qr" viewBox="0 0 9 9"/);
  assert.match(html, /<path fill="#000" d="M4 4h1v1h-1z"/);
  assert.match(html, /http:\/\/10\.23\.1\.20:47321\/pair</);
  assert.equal(html.includes('#K7QF2M9D'), false);
  assert.match(html, /K7QF-2M9D/);
  assert.equal(phoneVM({...waiting, pairing: {...waiting.pairing, qr: {size: 9, d: '<script>'}}}, {now: NOW}).pairing.qr, null, 'a malformed path is dropped');
});

test('the confirm step shows the words, the device, and exactly what it will be able to do', () => {
  const html = renderFixture(Phone, {initial: claimed, now: NOW});
  assert.match(html, /Is this your device\?/);
  assert.match(html, /amber · otter · lamp/);
  assert.match(html, /Pixel 8.*10\.23\.1\.31/);
  assert.match(html, /See requests to use this computer/);
  assert.match(html, /Answer requests \(that needs HTTPS\)/);
  assert.match(html, /The words match — pair/);
  assert.doesNotMatch(html, /Allow|Decline/);
});

test('on: reach headline and facts from the backend, the device address, paired devices with Remove', () => {
  const html = renderFixture(Phone, {initial: on, now: NOW});
  assert.match(html, /Paired devices can see requests, not answer them/);
  assert.match(html, /http:\/\/10\.23\.1\.20:47321/);
  assert.match(html, /Pixel 7/);
  assert.match(html, /View only/);
  assert.match(html, />Remove</);
  assert.match(renderFixture(Phone, {initial: base}), /Turn on device access/);
});

test('every error code the device API returns reads as a next step', () => {
  for (const code of ['local_session_required', 'confirm_on_this_computer', 'phone_access_off', 'pairing_not_open',
    'too_many_phones', 'no_network', 'address_not_available', 'invalid_hostname', 'not_found']) {
    assert.notEqual(phoneErrorText({code}), 'That didn’t work. Try again.', code);
    assert.equal(/_/.test(phoneErrorText({code})), false, code);
  }
  assert.match(phoneErrorText({code:'invalid_hostname'}), /faravan\.home\.example/);
});

test('Phone exposes network and HTTPS setup with labelled fields and no automatic enable', () => {
  const html = renderFixture(Phone, {initial: base});
  for (const label of ['Connection settings', 'Private network address', 'Host name', 'Certificate file', 'Private key file', 'Save connection']) assert.ok(html.includes(label), label);
  assert.match(html, /10\.23\.1\.20/);
  assert.match(html, /faravan\.home\.example/);
  assert.match(html, /certificate your device trusts/);
});

test('pairing without a QR gives manual instructions and keeps the code visible', () => {
  const html=renderFixture(Phone,{initial:{...waiting,pairing:{...waiting.pairing,qr:null}},now:NOW});
  assert.match(html,/Enter this code on your device/);
  assert.match(html,/K7QF-2M9D/);
  assert.doesNotMatch(html,/Scan this with/);
});

test('confirmation is absent unless exactly three valid words arrived', () => {
  for (const phrase of [undefined, null, [], Array(3), ['amber'], ['amber', 'otter'], ['amber', 'otter', 'lamp', 'extra'], ['amber', '', 'lamp'], ['amber', 'two words', 'lamp'], ['amber', 1, 'lamp'], ['amber', {}, 'lamp'], ['amber', ' ', 'lamp']]) {
    const initial = {...claimed, pairing: {...claimed.pairing, phrase}};
    assert.equal(phoneVM(initial).validPhrase, false);
    const html = renderFixture(Phone, {initial, now: NOW});
    assert.doesNotMatch(html, /The words match — pair|exactly these three words/);
    assert.match(html, /The pairing words didn’t arrive/);
    assert.match(html, /They don’t match/);
  }
  assert.equal(phoneVM(claimed).validPhrase, true);
});

test('expired waiting codes disappear and offer restarting', () => {
  const html = renderFixture(Phone, {initial: waiting, now: NOW + 10 * 60000});
  assert.doesNotMatch(html, /phone-qr|K7QF-2M9D|Scan this with|Enter this code/);
  assert.match(html, /Pair a device again/);
  assert.match(html, /This code has expired/);
});

test('manual instructions, empty grants, and connection status remain meaningful', () => {
  const manual = renderFixture(Phone, {initial: {...waiting, pairing: {...waiting.pairing, qr: null}}, now: NOW});
  assert.match(manual, /<p>Open /);
  assert.doesNotMatch(manual, /Or open/);
  const empty = renderFixture(Phone, {initial: {...claimed, pairing: {...claimed.pairing, scopes: []}}, now: NOW});
  assert.match(empty, /This device will not be able to do anything yet/);
  const absent = renderFixture(Phone, {initial: {...on, origin: ''}});
  assert.doesNotMatch(absent, /Devices open/);
  // Encryption is stated by the server's reach facts, which know about Tailscale; plain HTTP over a tailnet is encrypted.
  assert.doesNotMatch(absent, /Not encrypted/);
  assert.match(renderFixture(Phone, {initial: on}), /overflow-wrap:anywhere/);
});

test('problem and starting headings have a fallback; off facts need a heading', () => {
  for (const state of ['problem', 'starting']) {
    assert.match(renderFixture(Phone, {initial: {...on, reach: {state, facts: []}}}), /Device access isn’t ready/);
  }
  assert.doesNotMatch(renderFixture(Phone, {initial: {...base, reach: {state: 'off', facts: ['Unexplained fact']}}}), /Unexplained fact/);
  assert.match(renderFixture(Phone, {initial: base}), /Device access is off/);
});

// Item 9 (1102 review): when a full-app pairing is offered, the choice says what each access allows before the buttons.
test('a full-app pairing option names the difference in access before the pairing buttons', () => {
  const html = renderFixture(Phone, {initial: {...on, fullAvailable: true}, now: NOW});
  assert.ok(renderedText(html).includes('Choose access before pairing. The default lets a device see requests to this computer. The full-app option also lets it send jobs and change settings.'));
  assert.doesNotMatch(renderFixture(Phone, {initial: on, now: NOW}), /Choose access before pairing/);
});

test('Settings > Pairing says what it does for this computer, not for "your device"', () => {
  const html = renderFixture(Phone, {initial: null});
  assert.match(html, /Use Faravan on this computer from another device\. Paired devices connect to this computer directly; nothing goes through a Faravan server\./);
  assert.doesNotMatch(html, /See and answer requests/);
  assert.doesNotMatch(html, /on your device/);
});
