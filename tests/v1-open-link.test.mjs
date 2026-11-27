import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { invitationFromOpenLinkArgument, appUrlForInvitation, runOpenLink, JOIN_PREFILL_PREFIX } from '../lib/v1/open-link.mjs';
import { takeJoinPrefill } from '../ui/v1/src/join-prefill.mjs';
import { helpFor, topLevelUsage, COMMANDS } from '../lib/v1/help.mjs';
import * as p from '../lib/protocol/index.mjs';
import { installBrowserShims } from './helpers/no-browser.mjs';
import { openCommand } from '../lib/v1/open-url.mjs';

// Hermetic: no browser is ever opened (recording shims stand in for open and xdg-open), no join is ever made.
const bin = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const SEED = Buffer.alloc(32, 7).toString('base64url');
const SHORT = 'https://queue.example/i/abcde23456#' + SEED;
const TOKEN = 'session-token-for-tests-only';
const HANDOFF = 'http://127.0.0.1:43210/auth/handoff?code=once-use';
const wrap = (link, scheme = 'faravan') => scheme + '://join?link=' + encodeURIComponent(link);

test('open-link accepts the faravan:// wrapper and bare links, and refuses everything else', () => {
  assert.equal(invitationFromOpenLinkArgument(wrap(SHORT)), SHORT);
  assert.equal(invitationFromOpenLinkArgument(wrap(SHORT, 'faravan')), SHORT); // legacy faravan:// remains accepted
  assert.equal(invitationFromOpenLinkArgument(SHORT), SHORT);
  assert.equal(invitationFromOpenLinkArgument(wrap(readLong())), readLong());
  for (const junk of ['', 'hello', 'faravan://join', 'faravan://join?link=', 'faravan://join?link=' + encodeURIComponent('https://queue.example/other'),
    wrap('https://queue.example/i/abcde23456#short'), wrap(SHORT) + '&extra=1', 'faravan://join?coordinator=https%3A%2F%2Fa&token=b', 'javascript:alert(1)'])
    assert.throws(() => invitationFromOpenLinkArgument(junk), e => e.code === 'invalid_request', junk);
});
function readLong() {
  return JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url))).invite_link;
}

test('the review URL is a one-time handoff link and puts the invitation only in the fragment', () => {
  const url = new URL(appUrlForInvitation(HANDOFF, SHORT));
  assert.equal(url.origin, 'http://127.0.0.1:43210');
  assert.equal(url.pathname, '/auth/handoff');
  assert.equal(url.searchParams.get('code'), 'once-use');
  assert.equal(url.searchParams.has('token'), false, 'the session token never rides in the link');
  assert.equal(url.hash, JOIN_PREFILL_PREFIX + encodeURIComponent(SHORT));
  assert.ok(!url.href.includes(TOKEN) && !decodeURIComponent(url.hash).includes(TOKEN));
  assert.throws(() => appUrlForInvitation('http://10.23.1.2:1/auth/handoff?code=t', SHORT), e => e.code === 'invalid_request');
  assert.throws(() => appUrlForInvitation('https://evil.example/auth/handoff?code=t', SHORT), e => e.code === 'invalid_request');
});

test('the app page consumes the fragment: it returns the link once and clears it from the address bar', () => {
  const url = new URL(appUrlForInvitation('http://127.0.0.1:43210/', SHORT));
  const history = [], location = {hash: url.hash, pathname: url.pathname, search: url.search};
  assert.equal(takeJoinPrefill(location, {state: null, replaceState: (...args) => history.push(args)}), SHORT);
  assert.deepEqual(history, [[null, '', '/#/circles']]);
  const noop = {state: null, replaceState() { assert.fail('nothing to clear'); }};
  for (const hash of ['', '#/circles', '#/jobs', '#/circles?other=1']) assert.equal(takeJoinPrefill({hash, pathname: '/', search: ''}, noop), '');
  const clears = [];
  for (const hash of [JOIN_PREFILL_PREFIX + '%E0%A4%A', JOIN_PREFILL_PREFIX + encodeURIComponent('javascript:alert(1)'), JOIN_PREFILL_PREFIX + encodeURIComponent('https://a/' + 'x'.repeat(16400)), JOIN_PREFILL_PREFIX]) {
    assert.equal(takeJoinPrefill({hash, pathname: '/', search: ''}, {state: null, replaceState: (...args) => clears.push(args)}), '', hash.slice(0, 40));
  }
  assert.equal(clears.length, 4, 'a bad prefill is still removed from the address bar');
});

function recorder(overrides = {}) {
  const calls = {ensure: 0, opened: [], out: '', err: ''};
  return {calls, options: {ensureHandoff: async () => { calls.ensure++; return HANDOFF; }, openUrl: url => calls.opened.push(url),
    stdout: {write: s => { calls.out += s; }}, stderr: {write: s => { calls.err += s; }}, ...overrides}};
}

test('runOpenLink opens exactly the review URL and prints neither the token nor the seed', async () => {
  const {calls, options} = recorder();
  assert.equal(await runOpenLink([wrap(SHORT)], options), 0);
  assert.deepEqual(calls.opened, [appUrlForInvitation(HANDOFF, SHORT)]);
  assert.equal(calls.ensure, 1);
  assert.match(calls.out, /Nothing is joined until you confirm/);
  for (const secret of [TOKEN, SEED]) assert.ok(!(calls.out + calls.err).includes(secret));
  assert.ok(!calls.opened.join('').includes(TOKEN), 'the session token never reaches the opener');
});

test('runOpenLink refuses bad input before starting the app or a browser, and hides failure details', async () => {
  for (const argv of [[], ['a', 'b'], ['--help-me'], ['junk'], [wrap('https://queue.example/i/abcde23456#short')]]) {
    const {calls, options} = recorder();
    assert.equal(await runOpenLink(argv, options), 2, JSON.stringify(argv));
    assert.equal(calls.ensure, 0);
    assert.deepEqual(calls.opened, []);
    assert.equal(calls.out, '');
  }
  const failing = recorder({ensureHandoff: async () => { throw new Error('boom ' + TOKEN + ' ' + SEED); }});
  assert.equal(await runOpenLink([SHORT], failing.options), 1);
  assert.deepEqual(failing.calls.opened, []);
  assert.ok(!failing.calls.err.includes(TOKEN) && !failing.calls.err.includes(SEED));
});

test('help: open-link has its own help and stays out of the top-level list', () => {
  assert.ok(COMMANDS['open-link']);
  assert.match(helpFor(['open-link']), /faravan open-link/);
  assert.match(helpFor(['open-link']), /Nothing is joined until you confirm/);
  assert.ok(!topLevelUsage().includes('open-link'));
});

// The real binary against a real running app: it reuses that app, opens one URL, and joins nothing.
test('faravan open-link finds the running app, opens the join review and never joins', {timeout: 30000}, async t => {
  const f = await appFixture(t), {app} = await f.start('owner');
  const home = await f.home('owner'), shims = mkdtempSync(join(tmpdir(), 'faravan-open-link-'));
  t.after(() => rmSync(shims, {recursive: true, force: true}));
  const log = join(shims, 'opened.log');
  installBrowserShims(shims, log);
  const env = {...process.env, HOME: home, FARAVAN_HOME: home, PATH: shims + delimiter + process.env.PATH};
  delete env.FARAVAN_NO_BROWSER; // this child really opens "a browser": the recording shim above
  const run = async args => {
    const child = spawn(process.execPath, [bin, ...args], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    const [code] = await once(child, 'close');
    return {code, stdout, stderr};
  };
  const before = f.rawRequests.length;
  const result = await run(['open-link', wrap(SHORT)]);
  assert.equal(result.code, 0, result.stderr);
  for (const secret of [app.token, SEED]) assert.ok(!(result.stdout + result.stderr).includes(secret));
  for (let n = 0; n < 100 && !existsSync(log); n++) await new Promise(resolve => setTimeout(resolve, 50));
  const opened = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(opened.length, 1);
  const command = openCommand('unused')[0];
  assert.ok(opened[0].startsWith(command + ' '), 'the platform opener used the private recording shim');
  const url = new URL(opened[0].slice(command.length + 1));
  assert.equal(url.origin, app.origin);
  assert.equal(url.pathname, '/auth/handoff');
  assert.ok(url.searchParams.get('code'), 'the opener got a one-time code');
  assert.equal(url.searchParams.has('token'), false);
  assert.ok(!opened[0].includes(app.token), 'the session token never reaches the opener');
  assert.equal(takeJoinPrefill({hash: url.hash, pathname: url.pathname, search: url.search}, {state: null, replaceState() {}}), SHORT);
  // Nothing was joined or sent anywhere: no circle, no coordinator traffic.
  assert.equal(f.rawRequests.length, before);
  assert.deepEqual((await api(app, '/api/circles')).map(c => c.name), ['My devices']);
  // The command is hidden from the top-level help, has its own, and bad input exits 2 without opening anything.
  const top = await run(['--help']);
  assert.ok(!top.stdout.includes('open-link'));
  assert.match((await run(['open-link', '--help'])).stdout, /faravan open-link/);
  const bad = await run(['open-link', 'not a link']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not a Faravan invitation link/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'bad input opened nothing');
});
