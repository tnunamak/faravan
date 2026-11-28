import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  WITNESS_BUDGET_MS, WITNESS_COMMAND, WITNESS_FAMILIES, WITNESS_QUALIFIED, judgeBatch, judgeWitness, ownedCanaries, ownedListener,
  parseWitnessAudit, parseWitnessOutput, runGuestEgressWitness,
} from '../lib/v1/guest-egress-witness.mjs';

const NONCE = 'nonce-1234';
const SANDBOX = 'wf-0123456789abcdef';
const line = body => JSON.stringify({schema: 1, nonce: NONCE, ...body});
const canaryLine = (canary, body = {}) => line({canary: String(canary), direct: '52 000', configured: '0 403', ...body});
const GOOD_GUEST = canaryLine(0);
const SHAPE = {direct: {rc: 52, http: '000'}, configured: {rc: 0, http: '403'}};
const audit = (allowed = [], blocked = []) => JSON.stringify({allowed, blocked});
const row = (host, sandbox_id = SANDBOX) => ({sandbox_id, host, count: 1});
// Raw counts: exact address:port rows (attributable to this run's unique port) and port-less rows (never attributable).
const c = (allowed = 0, blocked = 0, bareAllowed = 0, bareBlocked = 0) => ({allowed, blocked, bareAllowed, bareBlocked});
const ADDRESS = '192.168.7.9', PORT = 40123;
const ENDPOINT = {address: ADDRESS, port: PORT};
// One endpoint's counts: the read for a single listener.
const parseAudit = stdout => parseWitnessAudit(stdout, {sandboxId: SANDBOX, endpoints: [ENDPOINT]})?.[0] ?? null;

test('guest output: one nonce-tagged line per canary, placed by canary number, with banners ignored', () => {
  assert.deepEqual(parseWitnessOutput(GOOD_GUEST + '\n', NONCE, 1), [SHAPE]);
  assert.deepEqual(parseWitnessOutput('warning: banner\n{"not":"ours"}\n' + canaryLine(0) + '\n' + canaryLine(1) + '\n', NONCE, 2), [SHAPE, SHAPE]);
  const slow = {direct: {rc: 7, http: '000'}, configured: {rc: 0, http: '403'}};
  assert.deepEqual(parseWitnessOutput(canaryLine(1, {direct: '7 000'}) + '\n' + canaryLine(0) + '\n', NONCE, 2), [SHAPE, slow], 'lines may arrive in any order');
  assert.deepEqual(parseWitnessOutput(line({tool: 'missing'}), NONCE, 3), {tool: 'missing'});
});

test('guest output: a missing, duplicate, out-of-range, stale, extra-key or malformed report is null', () => {
  const bad = [
    ['', 2], [canaryLine(0), 2], // one of two canaries
    [canaryLine(0) + '\n' + canaryLine(0), 2], // canary 0 twice, canary 1 never
    [canaryLine(0) + '\n' + canaryLine(2), 2], // canary 2 does not exist
    [canaryLine(0) + '\n' + canaryLine(1) + '\n' + canaryLine(1), 2], // one line too many
    [JSON.stringify({schema: 1, nonce: 'other', canary: '1', direct: '52 000', configured: '0 403'}) + '\n' + canaryLine(0), 2], // another run's output
    [canaryLine(0) + '\n' + canaryLine(1, {extra: 1}), 2],
    [canaryLine('01'), 1], [canaryLine('-1'), 1], [canaryLine(' 0'), 1],
    ['direct=52,000\nconfigured=0,403\n', 1], [GOOD_GUEST.slice(0, -4), 1], // the old line format, truncated
    [line({canary: '0', direct: '52 000'}), 1], [line({canary: '0', direct: '52 000', configured: '0 403', tool: 'missing'}), 1],
    [line({tool: 'present'}), 1], [line({tool: 'missing', canary: '0', direct: '52 000', configured: '0 403'}), 1],
    [canaryLine(0, {direct: '52 00'}), 1], [canaryLine(0, {direct: '999 000'}), 1], [canaryLine(0, {configured: 403}), 1],
    [canaryLine(0, {direct: '52 000 '}), 1], [JSON.stringify({schema: 2, nonce: NONCE, canary: '0', direct: '52 000', configured: '0 403'}), 1],
  ];
  for (const [stdout, canaries] of bad) assert.equal(parseWitnessOutput(stdout, NONCE, canaries), null, JSON.stringify(stdout));
  assert.equal(parseWitnessOutput(undefined, NONCE, 1), null);
  assert.equal(parseWitnessOutput(GOOD_GUEST, '', 1), null, 'no nonce, nothing to bind the output to');
  assert.equal(parseWitnessOutput(GOOD_GUEST, NONCE, 0), null, 'no canaries, nothing to report');
});

test('audit: raw counts for this sandbox only, per endpoint; exact address:port rows apart from port-less rows', () => {
  const other = {address: '10.20.30.40', port: 40124};
  const allowedRows = [row(ADDRESS), row(ADDRESS + ':' + PORT), row(ADDRESS + ':1'), row('example.com'), row(ADDRESS, 'wf-other0000000000')];
  const blockedRows = [row(other.address + ':' + other.port), row(other.address)];
  assert.deepEqual(parseWitnessAudit(audit(allowedRows, blockedRows), {sandboxId: SANDBOX, endpoints: [ENDPOINT, other]}),
    [c(1, 0, 1, 0), c(0, 1, 0, 1)]);
  assert.deepEqual(parseAudit(audit()), c());
  const exact = row(ADDRESS + ':' + PORT);
  const distinct = [{...exact, proxy_type: 'http', count: 2}, {...exact, proxy_type: 'tcp'}];
  assert.deepEqual(parseAudit(audit([], distinct)), c(0, 3, 0, 0));
  assert.equal(parseAudit(audit([], [exact, exact])), null, 'duplicate cumulative counters are ambiguous');
  assert.equal(parseAudit(audit([], [{...exact, count: 0}])), null);
});

test('audit: any unreadable row, shape or argument makes the whole log null', () => {
  const unreadable = [
    '', 'not json', '[]', '{}', JSON.stringify({allowed: []}), JSON.stringify({allowed: [], blocked: 'x'}),
    audit([row(ADDRESS), {sandbox_id: SANDBOX}]), audit([], [null]), audit([], [{sandbox_id: 3, host: ADDRESS}]),
    audit([{sandbox_id: 'wf-other0000000000', host: 7}]), // a malformed row of ANOTHER sandbox still poisons the read
  ];
  for (const stdout of unreadable) assert.equal(parseAudit(stdout), null, stdout);
  const endpoints = [ENDPOINT];
  assert.equal(parseWitnessAudit(audit(), {sandboxId: '', endpoints}), null);
  assert.equal(parseWitnessAudit(audit(), {sandboxId: SANDBOX, endpoints: []}), null, 'no endpoints, nothing to attribute');
  assert.equal(parseWitnessAudit(audit(), {sandboxId: SANDBOX, endpoints: [{address: 'example.com', port: PORT}]}), null);
  assert.equal(parseWitnessAudit(audit(), {sandboxId: SANDBOX, endpoints: [{address: ADDRESS, port: 'x'}]}), null);
  assert.equal(parseWitnessAudit(audit(), {sandboxId: SANDBOX, endpoints: [ENDPOINT, {address: ADDRESS, port: 70000}]}), null);
});

test('audit: an existing port-less counter can increase without adding a row', () => {
  const baseline = parseAudit(audit([{...row(ADDRESS), proxy_type: 'http', count: 1}]));
  const current = parseAudit(audit(
    [{...row(ADDRESS), proxy_type: 'http', count: 2}],
    [{...row(ADDRESS + ':' + PORT), proxy_type: 'http', count: 2}],
  ));
  assert.deepEqual([baseline, current], [c(0, 0, 1, 0), c(0, 2, 2, 0)]);
  const verdict = judgeWitness({...clean, before: baseline, after: current});
  assert.deepEqual([verdict.state, verdict.reason], ['inconclusive', 'attribution_ambiguous']);
});

test('owned canaries: the first non-loopback IPv4 inside each declared RFC 1918 family; null where none is owned', () => {
  const nic = (address, family = 'IPv4', internal = false) => ({address, family, internal});
  const addresses = interfaces => ownedCanaries(interfaces).map(canary => canary.address);
  assert.deepEqual(WITNESS_FAMILIES, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
  assert.deepEqual(addresses({lo: [nic('127.0.0.1', 'IPv4', true)], eth0: [nic('fe80::1', 'IPv6'), nic('8.8.8.8'), nic('192.168.1.5')]}),
    [null, null, '192.168.1.5']);
  assert.deepEqual(addresses({a: [nic('172.16.0.2')], b: [nic('10.0.0.2')]}), ['10.0.0.2', '172.16.0.2', null]);
  assert.deepEqual(addresses({a: [nic('172.32.0.2'), nic('100.64.0.1'), nic('169.254.1.1'), nic('10.0.0.2', 'IPv4', true), nic('10.1.1.1', 'IPv6')]}),
    [null, null, null]);
  assert.deepEqual(addresses({a: [nic('10.9.9.9'), nic('10.0.0.2')], b: [nic('172.31.255.1'), nic('172.16.0.2')], c: [nic('192.168.0.9')]}),
    ['10.9.9.9', '172.31.255.1', '192.168.0.9']);
  assert.deepEqual(ownedCanaries({}), WITNESS_FAMILIES.map(family => ({family, address: null})));
  assert.deepEqual(addresses(null), [null, null, null]);
});

const clean = {control: true, hits: 0, guest: {direct: {rc: 52, http: '000'}, configured: {rc: 0, http: '403'}},
  before: c(), after: c(0, 2)};

test('verdict: verified only with every observation, calibrated shapes, no hit, no allow and a fresh block', () => {
  assert.deepEqual(judgeWitness(clean), {state: 'verified', reason: null, hits: 0, allowedDelta: 0, blockedDelta: 2,
    direct: {rc: 52, http: '000'}, configured: {rc: 0, http: '403'}, before: c(), after: c(0, 2)}, 'the raw counts travel with the verdict');
  assert.equal(judgeWitness({...clean, before: c(0, 0, 3, 5), after: c(0, 1, 3, 5)}).state, 'verified', 'old port-less rows do not matter while none are new');
  assert.deepEqual(WITNESS_QUALIFIED, {direct: {rc: 52, http: '000'}, configured: {rc: 0, http: '403'}});
});

test('verdict: host-owned leak evidence fails even when the guest output is missing or the audit is unreadable', () => {
  assert.deepEqual(judgeWitness({...clean, hits: 1}).reason, 'listener_reached');
  assert.equal(judgeWitness({control: true, hits: 2, guest: null, before: null, after: null}).state, 'failed');
  assert.equal(judgeWitness({...clean, control: false, hits: 1}).state, 'failed');
  assert.deepEqual(judgeWitness({...clean, after: c(1, 2)}), {state: 'failed', reason: 'policy_allowed', allowedDelta: 1, before: c(), after: c(1, 2)});
  assert.equal(judgeWitness({...clean, guest: null, after: c(1, 0)}).state, 'failed');
});

test('verdict: every missing or ambiguous observation is inconclusive, never verified', () => {
  const cases = {
    host_control_failed: {...clean, control: false}, listener_hits_unreadable: [{...clean, hits: null}, {...clean, hits: -1}, {...clean, hits: '0'}],
    audit_unavailable: [{...clean, before: null}, {...clean, after: null}, {...clean, after: {allowed: 0, blocked: 2}}, {...clean, before: c(-1, 0)},
      {...clean, before: {...c(), allowed: 0.5}}],
    audit_regressed: [{...clean, before: c(0, 5), after: c(0, 2)}, {...clean, before: c(0, 0, 0, 5), after: c(0, 2, 0, 1)}],
    stale_evidence: [{...clean, before: c(0, 1), after: c(0, 3)}, {...clean, before: c(2, 0), after: c(2, 2)}], // rows for this unique port that predate the run
    attribution_ambiguous: [{...clean, after: c(0, 2, 0, 1)}, {...clean, after: c(0, 0, 0, 2)}], // port-less rows could be other traffic to the same address
    guest_output_invalid: {...clean, guest: null}, curl_missing: {...clean, guest: {tool: 'missing'}},
    no_block_recorded: {...clean, after: c()},
    unqualified_shape: [
      {...clean, guest: {direct: {rc: 7, http: '000'}, configured: {rc: 0, http: '403'}}}, // refused, not the calibrated drop
      {...clean, guest: {direct: {rc: 28, http: '000'}, configured: {rc: 0, http: '403'}}}, // timeout
      {...clean, guest: {direct: {rc: 52, http: '000'}, configured: {rc: 0, http: '200'}}}, // answered, yet the listener saw nothing
      {...clean, guest: {direct: {rc: 0, http: '200'}, configured: {rc: 0, http: '403'}}},
      {...clean, guest: {direct: {rc: 52, http: '000'}, configured: {rc: 52, http: '000'}}},
      {...clean, guest: {direct: {rc: 52, http: '000'}}},
    ],
  };
  for (const [reason, inputs] of Object.entries(cases)) for (const input of [inputs].flat()) {
    const verdict = judgeWitness(input);
    assert.equal(verdict.state, 'inconclusive', reason + JSON.stringify(input));
    assert.equal(verdict.reason, reason, JSON.stringify(input));
  }
  assert.equal(judgeWitness().state, 'inconclusive');
});

test('batch verdict: verified only when every canary is verified; a failure outranks an open canary; a partial batch is inconclusive', () => {
  const ok = {state: 'verified', reason: null, hits: 0, allowedDelta: 0, blockedDelta: 2};
  const canary = (family, verdict) => ({family, address: '10.0.0.1', verdict});
  const all = judgeBatch([canary('a', ok), canary('b', ok)]);
  assert.deepEqual([all.state, all.reason, all.blockedDelta, all.allowedDelta, all.hits], ['verified', null, 4, 0, 0]);
  assert.deepEqual(all.canaries.map(entry => entry.family), ['a', 'b']);
  const partial = judgeBatch([canary('a', ok), canary('b', {state: 'inconclusive', reason: 'guest_output_invalid'})]);
  assert.deepEqual([partial.state, partial.reason], ['inconclusive', 'guest_output_invalid']);
  const leak = judgeBatch([canary('a', {state: 'inconclusive', reason: 'guest_output_invalid'}), canary('b', {state: 'failed', reason: 'listener_reached', hits: 1})]);
  assert.deepEqual([leak.state, leak.reason, leak.hits], ['failed', 'listener_reached', 1], 'a leak outranks an earlier inconclusive canary');
  const peer = judgeBatch([canary('a', {state: 'inconclusive', reason: 'batch_not_started'}), canary('b', {state: 'inconclusive', reason: 'host_control_failed'})]);
  assert.deepEqual([peer.state, peer.reason], ['inconclusive', 'host_control_failed'], 'the reason names the canary that failed, not a peer that never started');
});

test('guest command shape: one sh script, no provider host; the owned URLs and nonce come only from the environment', () => {
  assert.equal(WITNESS_COMMAND.split('\n').length, 1);
  assert.match(WITNESS_COMMAND, /--noproxy "\*"/);
  assert.match(WITNESS_COMMAND, /\$WITNESS_URLS/);
  assert.doesNotMatch(WITNESS_COMMAND, /https?:\/\//);
  const output = (path, env) => execFileSync('/bin/sh', ['-c', WITNESS_COMMAND], {env: {PATH: path, ...env}, encoding: 'utf8'});
  assert.deepEqual(parseWitnessOutput(output('/nonexistent', {WITNESS_NONCE: NONCE, WITNESS_URLS: 'http://192.0.2.1:9/guest'}), NONCE, 2), {tool: 'missing'},
    'no curl on PATH: a tool report, not a guess');
});

test('guest command: the real script checks every canary through both transports and reports one line per canary', async t => {
  const {mkdtemp, writeFile, chmod, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'witness-curl-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  // Behaves like the calibrated guest: no proxy drops (52, no HTTP code); the configured proxy answers 403.
  await writeFile(join(dir, 'curl'), '#!/bin/sh\nfor a in "$@"; do [ "$a" = "--noproxy" ] && { printf 000; exit 52; }; done\nprintf 403\nexit 0\n');
  await chmod(join(dir, 'curl'), 0o755);
  const urls = ['http://10.20.30.40:40001/guest', 'http://172.20.0.5:40002/guest', 'http://192.168.7.9:40003/guest'].join(' ');
  const stdout = execFileSync('/bin/sh', ['-c', WITNESS_COMMAND], {env: {PATH: dir + ':/usr/bin:/bin', WITNESS_NONCE: NONCE, WITNESS_URLS: urls}, encoding: 'utf8'});
  assert.deepEqual(parseWitnessOutput(stdout, NONCE, 3), [SHAPE, SHAPE, SHAPE]);
});

test('witness budget: two bounded curls per family plus 4 s for the two policy-log reads', () => {
  assert.equal(WITNESS_BUDGET_MS, 16_000);
});

test('owned listener: only the exact witness request counts as a hit; close frees the port', async () => {
  const listener = await ownedListener('127.0.0.1', {nonce: 'abc'});
  try {
    assert.equal(await listener.control(), true);
    assert.equal(listener.hits(), 0, 'the host control is not a guest hit');
    const unrelated = await fetch(new URL('/unrelated', listener.url));
    await unrelated.text();
    assert.equal(listener.hits(), 0, 'unrelated traffic is not guest evidence');
    assert.equal(unrelated.status, 404);
    const guest = await fetch(listener.url);
    await guest.text();
    assert.equal(listener.hits(), 1);
  } finally {
    await listener.close();
  }
  assert.equal(await listener.control(), false, 'a closed listener does not answer');
});

const PORTS = {'10.20.30.40': 40001, '172.20.0.5': 40002, [ADDRESS]: 40003};
// Canary order follows WITNESS_FAMILIES: 10/8, 172.16/12, 192.168/16.
const CANARIES = ['10.20.30.40', '172.20.0.5', ADDRESS];
const FAMILY_NICS = {
  eth0: [{address: ADDRESS, family: 'IPv4', internal: false}],
  vpn0: [{address: '10.20.30.40', family: 'IPv4', internal: false}],
  docker0: [{address: '172.20.0.5', family: 'IPv4', internal: false}],
};
const url = address => `http://${address}:${PORTS[address]}/guest`;
// A host-owned listener stand-in. Control and hit counts are set per test; close is counted.
function fakeListener(address, {control = true, hits = 0} = {}) {
  const state = {closed: 0};
  return {state, address, port: PORTS[address], url: url(address), hits: () => hits,
    control: async () => control, close: async () => { state.closed += 1; }};
}
const blank = addresses => addresses.map(() => c());
const blockedTwice = addresses => addresses.map(() => c(0, 2));
const guestLines = count => Array.from({length: count}, (_, canary) => canaryLine(canary)).join('\n') + '\n';

// One run: a listener per owned address, a guest reply per command, and a queue of policy-log reads. A read is an array of
// counts per endpoint, a function of the read's addresses, null, or an error.
function witnessRun({interfaces = FAMILY_NICS, controls = {}, hits = {}, listenFails = [], reads = [blank, blockedTwice], exec} = {}) {
  const calls = {listen: [], exec: [], audit: []}, opened = new Map(), queue = [...reads];
  const args = {
    interfaces, nonce: NONCE,
    listen: async (address, {nonce}) => {
      calls.listen.push([address, nonce]);
      if (listenFails.includes(address)) throw new Error('EADDRNOTAVAIL');
      const listener = fakeListener(address, {control: controls[address] ?? true, hits: hits[address] ?? 0});
      opened.set(address, listener);
      return listener;
    },
    exec: async request => {
      calls.exec.push(request);
      return exec ? exec(request) : {code: 0, stdout: guestLines(request.env.WITNESS_URLS.split(' ').length)};
    },
    audit: async endpoints => {
      calls.audit.push(endpoints);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(endpoints.map(endpoint => endpoint.address)) : next ?? null;
    },
  };
  return {args, calls, opened};
}
const readAddresses = calls => calls.map(endpoints => endpoints.map(endpoint => endpoint.address));

test('run: every owned family gets a canary; one guest command and two fresh policy-log reads cover them all', async () => {
  const run = witnessRun();
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason, verdict.blockedDelta, verdict.uncovered], ['verified', null, 6, []]);
  assert.deepEqual(verdict.canaries.map(canary => [canary.family, canary.address, canary.state]),
    [['10.0.0.0/8', '10.20.30.40', 'verified'], ['172.16.0.0/12', '172.20.0.5', 'verified'], ['192.168.0.0/16', ADDRESS, 'verified']]);
  assert.equal(run.calls.exec.length, 1, 'one guest command for every canary');
  assert.equal(run.calls.exec[0].command, WITNESS_COMMAND);
  assert.deepEqual(run.calls.exec[0].env, {WITNESS_URLS: CANARIES.map(url).join(' '), WITNESS_NONCE: NONCE});
  assert.deepEqual(readAddresses(run.calls.audit), [CANARIES, CANARIES], 'a read before and after, both over every canary');
  assert.deepEqual([...run.opened.values()].map(listener => listener.state.closed), [1, 1, 1]);
});

test('run: a family this host owns no address in is reported uncovered, and the owned canaries still verify', async () => {
  const run = witnessRun({interfaces: {eth0: FAMILY_NICS.eth0}});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.uncovered], ['verified', ['10.0.0.0/8', '172.16.0.0/12']]);
  assert.deepEqual(verdict.canaries.map(canary => canary.family), ['192.168.0.0/16']);
  assert.deepEqual(readAddresses(run.calls.audit), [[ADDRESS], [ADDRESS]]);
});

test('run: a host that owns no declared private address starts nothing and reports every family uncovered', async () => {
  const run = witnessRun({interfaces: {}});
  assert.deepEqual(await runGuestEgressWitness(run.args), {state: 'inconclusive', reason: 'no_private_ipv4', canaries: [], uncovered: [...WITNESS_FAMILIES]});
  assert.equal(run.calls.listen.length + run.calls.exec.length + run.calls.audit.length, 0);
});

test('run: a listener that cannot open stops the batch before any guest traffic, and the opened listeners close', async () => {
  const run = witnessRun({listenFails: ['172.20.0.5']});
  assert.deepEqual(await runGuestEgressWitness(run.args), {state: 'inconclusive', reason: 'listener_unavailable', canaries: [], uncovered: []});
  assert.deepEqual([run.calls.exec.length, run.calls.audit.length], [0, 0]);
  assert.equal(run.opened.get('10.20.30.40').state.closed, 1);
});

test('run: one canary without a healthy host control starts no guest traffic; healthy canaries are not judged on the batch they lack', async () => {
  const run = witnessRun({controls: {'172.20.0.5': false}});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason], ['inconclusive', 'host_control_failed']);
  assert.deepEqual(verdict.canaries.map(canary => canary.reason), ['batch_not_started', 'host_control_failed', 'batch_not_started']);
  assert.deepEqual([run.calls.exec.length, run.calls.audit.length], [0, 0], 'no baseline read either');
  assert.deepEqual([...run.opened.values()].map(listener => listener.state.closed), [1, 1, 1]);
});

test('run: a leak to one canary fails the batch even when the guest output is unreadable', async () => {
  const run = witnessRun({hits: {'10.20.30.40': 1}, exec: () => ({code: 0, stdout: 'garbage'})});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason, verdict.hits], ['failed', 'listener_reached', 1]);
  assert.deepEqual(verdict.canaries.map(canary => canary.reason), ['listener_reached', 'guest_output_invalid', 'guest_output_invalid']);
});

test('run: a partial guest output is inconclusive for every canary, never a pass', async () => {
  const run = witnessRun({exec: () => ({code: 0, stdout: guestLines(2)})});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason], ['inconclusive', 'guest_output_invalid']);
  assert.deepEqual(verdict.canaries.map(canary => canary.reason), ['guest_output_invalid', 'guest_output_invalid', 'guest_output_invalid']);
});

test('run: one canary answering off the calibrated shape makes the batch inconclusive and names that canary', async () => {
  const run = witnessRun({exec: () => ({code: 0, stdout: [canaryLine(0), canaryLine(1, {direct: '28 000'}), canaryLine(2)].join('\n') + '\n'})});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason], ['inconclusive', 'unqualified_shape']);
  assert.deepEqual(verdict.canaries.map(canary => canary.state), ['verified', 'inconclusive', 'verified']);
  assert.deepEqual(verdict.canaries[1].direct, {rc: 28, http: '000'});
});

test('run: an allowed row for one canary fails the batch and names that canary', async () => {
  const run = witnessRun({reads: [blank, addresses => addresses.map((_, index) => index === 1 ? c(1, 2) : c(0, 2))]});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason, verdict.allowedDelta], ['failed', 'policy_allowed', 1]);
  assert.deepEqual(verdict.canaries.map(canary => canary.state), ['verified', 'failed', 'verified']);
});

test('run: a baseline read that fails or has the wrong length starts no guest traffic', async () => {
  for (const reads of [[new Error('policy log failed')], [addresses => [c()]], [null]]) {
    const run = witnessRun({reads});
    assert.equal((await runGuestEgressWitness(run.args)).reason, 'audit_unavailable', String(reads));
    assert.equal(run.calls.exec.length, 0, 'no baseline, no guest traffic');
  }
});

test('run: an unreadable final read leaves every canary inconclusive, after the guest command ran', async () => {
  const run = witnessRun({reads: [blank, null]});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason], ['inconclusive', 'audit_unavailable']);
  assert.equal(run.calls.exec.length, 1);
  assert.equal(run.calls.audit.length, 2);
});

test('run: a guest command that throws or exits non-zero is never trusted, and the final read still happens', async () => {
  for (const exec of [() => { throw new Error('exec aborted'); }, () => ({code: 1, stdout: guestLines(3)})]) {
    const run = witnessRun({exec});
    const verdict = await runGuestEgressWitness(run.args);
    assert.deepEqual([verdict.state, verdict.reason], ['inconclusive', 'guest_output_invalid']);
    assert.equal(run.calls.audit.length, 2, 'the final read still happens');
  }
});

test('run: a leak fails even when the guest command crashed', async () => {
  const run = witnessRun({hits: {[ADDRESS]: 1}, exec: () => { throw new Error('exec aborted'); }});
  const verdict = await runGuestEgressWitness(run.args);
  assert.deepEqual([verdict.state, verdict.reason], ['failed', 'listener_reached']);
});
