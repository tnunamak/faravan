import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_CODES,
  REDACTION_MARKER,
  checkPreservation,
  findSecretsInEvidence,
  redactEvidence,
} from '../packaging/journey/preservation.mjs';

// All secrets below are obviously fake fixture values (example.invalid hosts,
// FAKE-... tokens). Never real credentials.

const RUN_ROOTS = {
  appState: '/tmp/fake-run-FAKE/app-state',
  install: '/tmp/fake-run-FAKE/install',
  evidence: '/tmp/fake-run-FAKE/evidence',
};

const TRAY_MODELS = ['fake-model-a', 'fake-model-b', 'fake-model-c', 'fake-model-d', 'fake-model-e', 'fake-model-f', 'fake-model-g'];
const TRAY_SELECTIONS = {
  'fake-model-a': 'selected',
  'fake-model-b': 'unselected',
  'fake-model-c': 'unselected',
  'fake-model-d': 'unselected',
  'fake-model-e': 'unselected',
  'fake-model-f': 'unselected',
  'fake-model-g': 'unselected',
};

function cleanInput(overrides = {}) {
  return {
    install: {label: 'fresh-install', destination: '/tmp/fake-run-FAKE/install', runOwned: true, priorRunReceipt: null},
    runRoots: {...RUN_ROOTS},
    writes: [
      {path: '/tmp/fake-run-FAKE/app-state/settings.json'},
      {path: '/tmp/fake-run-FAKE/install/app.bin'},
      {path: '/tmp/fake-run-FAKE/evidence/step-1.json'},
    ],
    preferences: {
      before: {trayModels: [...TRAY_MODELS], traySelections: {...TRAY_SELECTIONS}},
      after: {trayModels: [...TRAY_MODELS], traySelections: {...TRAY_SELECTIONS}},
    },
    channel: {before: 'fake-channel-FAKE-1', after: 'fake-channel-FAKE-1'},
    expectedCloses: [
      {kind: 'process', id: 4242},
      {kind: 'forward', id: 'fake-forward-FAKE-1'},
    ],
    closeReceipts: [
      {kind: 'process', id: 4242, owned: true, closed: true},
      {kind: 'forward', id: 'fake-forward-FAKE-1', owned: true, closed: true},
    ],
    evidence: [
      {name: 'step-1.json', text: 'step pass, no secrets here'},
      {name: 'trace.log', text: 'GET https://example.invalid/health 200'},
    ],
    ...overrides,
  };
}

function codesOf(result) {
  return result.issues.map(issue => issue.code);
}

test('clean fresh-install run passes', () => {
  const result = checkPreservation(cleanInput());
  assert.equal(result.status, 'pass');
  assert.equal(result.label, 'fresh-install');
  assert.deepEqual(result.issues, []);
});

test('clean reused-install run passes with an explicit prior run receipt', () => {
  const input = cleanInput({install: {label: 'reused-install', destination: '/tmp/fake-run-FAKE/install', runOwned: true, priorRunReceipt: 'fake-prior-run-receipt-FAKE-1'}});
  const result = checkPreservation(input);
  assert.equal(result.status, 'pass');
  assert.equal(result.label, 'reused-install');
  assert.deepEqual(result.issues, []);
});

test('reused-install label without an explicit prior run receipt is refused', () => {
  const input = cleanInput({install: {label: 'reused-install', destination: '/tmp/fake-run-FAKE/install', runOwned: true, priorRunReceipt: null}});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.label, 'reused-install');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.REUSED_INSTALL_WITHOUT_PRIOR_RECEIPT));
});

test('a write outside run-owned roots blocks', () => {
  const input = cleanInput();
  input.writes.push({path: '/home/fake-user-FAKE/.config/faravan/settings.json'});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.WRITE_OUTSIDE_RUN_ROOTS));
  assert.ok(result.issues.some(issue => issue.item === 'writes[3].path'));
});

test('a write that escapes a run root with .. blocks', () => {
  const input = cleanInput();
  input.writes.push({path: '/tmp/fake-run-FAKE/app-state/../outside-FAKE.txt'});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.WRITE_OUTSIDE_RUN_ROOTS));
});

test('any change to the tray model list blocks', () => {
  const input = cleanInput();
  input.preferences.after.trayModels = [...TRAY_MODELS, 'fake-model-h'];
  input.preferences.after.traySelections['fake-model-h'] = 'unselected';
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.TRAY_MODEL_LIST_CHANGED));
});

test('any change to the tray model selections blocks', () => {
  const input = cleanInput();
  input.preferences.after.traySelections['fake-model-b'] = 'selected';
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.TRAY_MODEL_SELECTION_CHANGED));
});

test('a changed channel identity blocks', () => {
  const input = cleanInput({channel: {before: 'fake-channel-FAKE-1', after: 'fake-channel-FAKE-2'}});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.CHANNEL_IDENTITY_CHANGED));
});

test('a raw session-token URL in evidence blocks', () => {
  const input = cleanInput({evidence: [
    {name: 'trace.log', text: 'GET https://example.invalid/join?token=FAKE-TOKEN-1234 200'},
  ]});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.EVIDENCE_SESSION_TOKEN_URL));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-TOKEN-1234'));
});

test('a fragment session-token URL in evidence blocks', () => {
  const input = cleanInput({evidence: [
    {name: 'trace.log', text: 'opened https://example.invalid/app#token=FAKE-TOKEN-5678'},
  ]});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.EVIDENCE_SESSION_TOKEN_URL));
});

test('a bearer token in evidence blocks', () => {
  const input = cleanInput({evidence: [
    {name: 'trace.log', text: 'forwarded Bearer FAKE-BEARER-TOKEN-1234 to the backend'},
  ]});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.EVIDENCE_BEARER_TOKEN));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-BEARER-TOKEN-1234'));
});

test('an invitation payload in evidence blocks', () => {
  const input = cleanInput({evidence: [
    {name: 'step-2.json', text: '{"invitation_token": "FAKE-INVITE-TOKEN-1234"}'},
  ]});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.EVIDENCE_INVITATION));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-INVITE-TOKEN-1234'));
});

test('Faravan invitation links in evidence block, in short, long and faravan:// form', () => {
  for (const text of [
    'opened https://host.example.invalid/i/FAKECODE1234#FAKESEED5678 in the friend browser',
    'pasted https://host.example.invalid/join#invite=FAKEBLOBFAKEBLOBFAKEBLOB',
    'handler faravan://join?link=https%3A%2F%2Fhost.example.invalid%2Fjoin%23invite%3DFAKEBLOB',
  ]) {
    const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
    assert.equal(result.status, 'blocked', text);
    assert.ok(codesOf(result).includes(BLOCKED_CODES.EVIDENCE_INVITATION), text);
    const redacted = redactEvidence(text);
    assert.deepEqual(findSecretsInEvidence(redacted), [], redacted);
    assert.ok(!/FAKECODE1234|FAKESEED5678|FAKEBLOBFAKEBLOB/.test(redacted), redacted);
  }
});

test('an auth header in evidence blocks', () => {
  const input = cleanInput({evidence: [
    {name: 'trace.log', text: 'request headers:\nAuthorization: Basic FAKE-AUTH-HEADER-1234\n'},
  ]});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.EVIDENCE_AUTH_HEADER));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-AUTH-HEADER-1234'));
});

test('cleanup of a process the run does not own blocks', () => {
  const input = cleanInput();
  input.closeReceipts.push({kind: 'process', id: 9999, owned: false, closed: true});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.CLEANUP_UNOWNED_PROCESS));
  assert.ok(result.issues.some(issue => issue.item === 'closeReceipts[2]'));
});

test('an install destination not owned by this run blocks', () => {
  const input = cleanInput({install: {label: 'fresh-install', destination: '/opt/fake-other-FAKE/app', runOwned: false, priorRunReceipt: null}});
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.INSTALL_DESTINATION_NOT_RUN_OWNED));
});

test('a missing cleanup receipt blocks', () => {
  const input = cleanInput();
  input.closeReceipts = input.closeReceipts.filter(receipt => receipt.kind !== 'forward');
  const result = checkPreservation(input);
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.MISSING_CLEANUP_RECEIPT));
  assert.ok(result.issues.some(issue => issue.item === 'expectedCloses[1]'));
});

test('missing required input fails instead of passing', () => {
  const result = checkPreservation({install: {label: 'fresh-install', destination: '/tmp/fake-run-FAKE/install', runOwned: true}});
  assert.equal(result.status, 'failed');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.MISSING_INPUT));
});

test('redaction replaces every secret with the fixed marker and the check passes on its output', () => {
  const dirty = [
    'GET https://example.invalid/join?token=FAKE-TOKEN-1234 200',
    'opened https://example.invalid/app#token=FAKE-TOKEN-5678',
    'forwarded Bearer FAKE-BEARER-TOKEN-1234 to the backend',
    '{"invitation_token": "FAKE-INVITE-TOKEN-1234"}',
    'Authorization: Basic FAKE-AUTH-HEADER-1234',
  ].join('\n');
  const redacted = redactEvidence(dirty);
  assert.ok(!dirty.includes(REDACTION_MARKER));
  assert.ok(redacted.includes(REDACTION_MARKER));
  for (const fake of ['FAKE-TOKEN-1234', 'FAKE-TOKEN-5678', 'FAKE-BEARER-TOKEN-1234', 'FAKE-INVITE-TOKEN-1234', 'FAKE-AUTH-HEADER-1234']) {
    assert.ok(!redacted.includes(fake), `redacted text still contains ${fake}`);
  }
  assert.deepEqual(findSecretsInEvidence(redacted), []);
  const input = cleanInput({evidence: [{name: 'trace.log', text: redacted}]});
  const result = checkPreservation(input);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.issues, []);
});

test('redaction leaves clean evidence unchanged', () => {
  const clean = 'step pass, GET https://example.invalid/health 200, invitation created in host UI';
  assert.equal(redactEvidence(clean), clean);
});
