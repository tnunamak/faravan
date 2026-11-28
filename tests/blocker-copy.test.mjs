import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {formatLendingProjection} from '../lib/v1/lending-summary.mjs';
import {lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {cessationCopyFixture} from './helpers/cessation-copy-fixture.mjs';

// What the app tells a lender about each blocked sandbox state, from the real readiness and status endpoints.
// One row names each cause, the text is true to what the app knows, and a button label is never a sentence.
const opts = {timeout:60000};
const ok = name => ({name, ok:true});
const BASE = [ok('sbx_install'), ok('sbx_daemon'), ok('docker_login')];
const swap = (name, over) => BASE.map(check => check.name === name ? {...check, ...over} : check);
const NEVER = [/fixes this by itself/i, /try again from (Lending|Setup)/i, /open Docker Sandboxes/i, /Check Docker\b/i, /\bStart Docker Sandboxes/i, /checks below/i];

async function blockersFor(t, checks) {
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => ({available:false, preflight:{ok:false, checks}});
  const {app} = await f.start('owner', {backend});
  const readiness = await api(app, '/api/readiness?refresh=true');
  const status = await api(app, '/api/status');
  const items = status.lending_blockers.items;
  const text = JSON.stringify({readiness:readiness.checks.map(({name, label, remedy}) => ({name, label, remedy})), items});
  for (const rule of NEVER) assert.doesNotMatch(text, rule, rule + ' in ' + text);
  for (const item of items) assert.ok(!item.action || !/\.$|\bby itself\b/.test(item.action), 'a button label is not a sentence: ' + item.action);
  return {readiness, items, dockerRows: items.filter(item => item.key === 'docker_running'), requirementRows: items.filter(item => item.key === 'readiness_requirement')};
}
const preflight = (name, over) => ({name, ok:false, detail:'x', fix:'', ...over});

test('a finished service check reports its failure and action when no repair runs', opts, async t => {
  const {readiness, dockerRows, requirementRows} = await blockersFor(t, [ok('sbx_install'), preflight('sbx_daemon', {detail:'The sandbox service is not running yet.', automatic:true}), ok('docker_login')]);
  assert.equal(readiness.checks.find(c => c.name === 'sbx_daemon').remedy, '');
  assert.equal(dockerRows.length, 1);
  // The bounded-check rule permits progress copy only while a check is in flight.
  assert.equal(dockerRows[0].detail, 'The sandbox service is not running yet.');
  assert.equal(dockerRows[0].status, 'blocked');
  assert.equal(dockerRows[0].action, 'Check again');
  assert.equal(requirementRows.filter(row => row.cause === 'sbx_daemon').length, 0, 'the same cause is not listed twice');
});

test('sandbox service that timed out or cannot be verified: says so and offers Check again', opts, async t => {
  for (const over of [{unknown:true, automatic:true, detail:'The sandbox service could not be verified.'}, {unknown:true, detail:'The sandbox service could not be verified.'}]) {
    const {dockerRows, requirementRows} = await blockersFor(t, [ok('sbx_install'), preflight('sbx_daemon', over), ok('docker_login')]);
    assert.equal(dockerRows.length, 1);
    assert.equal(dockerRows[0].detail, 'Faravan can’t confirm the sandbox service is running.');
    assert.equal(dockerRows[0].status, 'blocked');
    assert.equal(dockerRows[0].action, 'Check again');
    assert.equal(requirementRows.length, 0);
  }
});

test('sandbox service whose repair failed: names the support path with its real button', opts, async t => {
  const {dockerRows, requirementRows} = await blockersFor(t, [ok('sbx_install'), preflight('sbx_daemon', {repair:'support', automatic:false, fix:'Open Settings',
    detail:'Docker Sandboxes could not start the sandbox service. Open Settings to save a support report.'}), ok('docker_login')]);
  assert.equal(dockerRows.length, 1);
  assert.equal(dockerRows[0].action, 'Open Settings');
  assert.match(dockerRows[0].detail, /could not start the sandbox service/);
  assert.equal(requirementRows.length, 0);
});

test('sandbox service that needs a terminal command: the command appears once, on the one row', opts, async t => {
  const {dockerRows, requirementRows} = await blockersFor(t, [ok('sbx_install'), preflight('sbx_daemon', {repair:'owner_repair', automatic:false,
    detail:'The sandbox service belongs to another account.', fix:'faravan sandbox repair-owner --yes'}), ok('docker_login')]);
  assert.equal(dockerRows.length, 1);
  assert.equal((dockerRows[0].detail.match(/faravan sandbox repair-owner --yes/g) ?? []).length, 1);
  assert.equal(dockerRows[0].action, 'Check again');
  assert.equal(requirementRows.length, 0);
});

test('virtualization permission missing: the one row names KVM and its command, not "Not running"', opts, async t => {
  const {dockerRows, requirementRows} = await blockersFor(t, [ok('sbx_install'), ok('sbx_daemon'), ok('docker_login'),
    preflight('kvm_access', {detail:'sbx reported KVM error: Permission denied (os error 13).', fix:'sudo usermod -aG kvm $USER && newgrp kvm'})]);
  assert.equal(dockerRows.length, 1);
  assert.match(dockerRows[0].detail, /KVM error/);
  assert.match(dockerRows[0].detail, /usermod -aG kvm/);
  assert.doesNotMatch(dockerRows[0].detail, /Not running/);
  assert.equal(requirementRows.length, 0);
});

test('Docker Sandboxes not installed: one row and its one install action', opts, async t => {
  const {items} = await blockersFor(t, [preflight('sbx_install', {detail:'Not installed.', fix:'Install Docker Sandboxes.'}), ok('sbx_daemon'), ok('docker_login')]);
  const rows = items.filter(item => item.key === 'docker_installed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'Install Docker Sandboxes');
  assert.equal(items.filter(item => item.key === 'docker_running').length, 0);
});

test('network rules wait for the Docker sign-in: a waiting row, no action of its own', opts, async t => {
  const {requirementRows, items} = await blockersFor(t, [ok('sbx_install'), ok('sbx_daemon'), preflight('docker_login', {fix:'sbx login'}),
    preflight('network_policy', {detail:'Waits for the Docker sign-in.', fix:'Sign in to Docker. Faravan then sets the sandbox network policy by itself.', automatic:true, waitsFor:'docker_login'})]);
  const rule = requirementRows.find(row => row.cause === 'network_policy');
  assert.equal(rule.status, 'waits');
  assert.equal(rule.detail, 'Faravan sets up the network rules after Docker sign-in.');
  assert.ok(!rule.action);
  assert.equal(items.find(item => item.key === 'docker_signin').action, 'Sign in to Docker');
});

test('a readiness requirement with a sentence for a remedy lists the sentence once and offers Check again', opts, async t => {
  const {requirementRows} = await blockersFor(t, [...BASE, preflight('sbx_version', {detail:'Update Docker Sandboxes', fix:'Update Docker Sandboxes to 0.51.0 or newer.'})]);
  const row = requirementRows.find(item => item.cause === 'sbx_version');
  assert.equal(row.action, 'Check again');
  assert.equal((row.detail.match(/Update Docker Sandboxes to 0\.51\.0 or newer\./g) ?? []).length, 1);
});

test('disk low: one row, one explanation, Check again', opts, async t => {
  const {requirementRows} = await blockersFor(t, [...BASE, preflight('host_disk', {reason:'host_disk_low', detail:'This computer is low on disk space.', fix:'Free at least 8 GiB.'})]);
  const row = requirementRows.find(item => /host_disk/.test(item.cause));
  assert.ok(row, JSON.stringify(requirementRows));
  assert.equal(row.action, 'Check again');
});

test('a blocked lending state the app cannot name gives no direction it cannot back', () => {
  const projection = reason => ({schemaVersion:2, kind:'lending', intent:'on', admission:'blocked', admissionReason:reason, execution:'idle', executionJob:null,
    evidence:{intentState:'ready', dailyLimitReached:false, executionState:'idle'}, version:'fixture'});
  // Frozen copy change (R lane, lib/v1/lending-summary.mjs): a blocked lender says what is true for the borrower too, that
  // jobs can still go to another lender, instead of claiming that no job can start anywhere.
  assert.equal(formatLendingProjection(projection('some_new_reason')).reason, 'Lending on this computer waits for the blocked step. You can still send jobs to another lender.');
  for (const reason of ['sandbox_not_ready', 'docker_signed_out', 'agent_not_chosen', 'quota_reserve', 'cessation_unverified'])
    for (const rule of NEVER) assert.doesNotMatch(formatLendingProjection(projection(reason)).reason, rule, reason);
});

test('an unconfirmed job runner names the missing job controls; an unconfirmed stop bound names only the usage estimate', () => {
  // Frozen change (docs/foundation-1113/SPEC.md section 3): unknown funding, executor or stop-bound evidence adds no hard hold,
  // so these reasons no longer ask the owner to open Setup. A stop bound states the estimate the lender actually uses.
  // e735e21bb then named the missing job controls for an unconfirmed executor (the owner's next step is the sandbox setup,
  // not a usage estimate); a stop bound keeps the estimate line.
  const expected = {
    executor_unknown: 'Holding — job controls could not be confirmed. This needs you: check the sandbox setup and try again.',
    stop_bound_unknown: 'Usage estimate: lending uses available readings or the starting estimate; history improves it.',
  };
  for (const [reason, want] of Object.entries(expected)) {
    const {line} = lendingStatus({reason, detail:{}});
    assert.equal(line, want);
    assert.doesNotMatch(line, /installed|can start|Setup|support/, line);
    for (const rule of NEVER) assert.doesNotMatch(line, rule, reason);
  }
});
// Cessation copy component regressions: no host, provider or app server is started.
for(const resumeFailure of [false,true]) test('cessation copy enriches '+(resumeFailure?'an effectiveState blocker':'a generic admission blocker'),async()=>{
  const f=cessationCopyFixture({resumeFailure});
  const raw=(await f.raw()).blockers.find(b=>b.kind==='cessation_unverified');
  const listed=(await f.listed()).blockers.find(b=>b.kind==='cessation_unverified');
  assert.ok(raw.message,'every raw cessation blocker has a sentence');
  assert.equal(raw.message,listed.message);
  assert.deepEqual({...raw.fix},{...listed.fix});
  assert.notEqual(raw.fix,f.fix,'each response owns its fix object');
  assert.doesNotMatch(raw.message+' '+raw.fix.human,/—|\b(verdict|receipt|attempt|settled|lease)\b/i);
});

test('cessation enrichment preserves a supplied sentence without mutating shared blockers or fixes',async()=>{
  const existing=Object.freeze({kind:'cessation_unverified',message:'An earlier job still needs checking.'});
  const f=cessationCopyFixture({existing});
  const raw=(await f.raw()).blockers[0];
  assert.notEqual(raw,existing);
  assert.equal(raw.message,existing.message);
  assert.equal(existing.fix,undefined);
  assert.deepEqual({...raw.fix},{...f.fix});
  assert.notEqual(raw.fix,f.fix);
  raw.fix.human='changed only in this response';
  assert.notEqual(raw.fix.human,f.fix.human);
  assert.equal((await f.raw()).blockers[0].fix.human,f.fix.human);
});
