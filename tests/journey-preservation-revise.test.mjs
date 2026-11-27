import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_CODES,
  REDACTION_MARKER,
  checkPreservation,
  findSecretsInEvidence,
  isUnderRoot,
  redactEvidence,
} from '../packaging/journey/preservation.mjs';

// Paired regression tests for docs/reviews/pr84-review.md (three P1s, three
// P2s). Every test below fails on the pre-fix module and passes on the fixed
// one, except the two marked guards, which pin the intended boundary in both
// directions. All secrets are obviously fake fixture values (example.invalid
// hosts, FAKE-... tokens). Never real credentials.

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

function assertBlockedWithCode(result, code) {
  assert.equal(result.status, 'blocked');
  assert.ok(codesOf(result).includes(code));
}

function assertFailedMissingInput(result) {
  assert.equal(result.status, 'failed');
  assert.ok(codesOf(result).includes(BLOCKED_CODES.MISSING_INPUT));
}

// --- P1: encoded / serialized secret text ----------------------------------

test('P1 encoded: a URL-encoded short invitation link is detected and its whole encoded value is redacted', () => {
  const text = 'opened https%3A%2F%2Fhost.example.invalid%2Fi%2FFAKECODE1234%23FAKESEED5678 in the friend browser';
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_INVITATION));
  const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_INVITATION);
  const redacted = redactEvidence(text);
  assert.ok(!redacted.includes('FAKECODE1234') && !redacted.includes('FAKESEED5678'), redacted);
  assert.ok(!redacted.includes('%2F') && !redacted.includes('%3A'), redacted);
  assert.deepEqual(findSecretsInEvidence(redacted), []);
});

test('P1 encoded: a URL-encoded long invitation link is detected and its whole encoded value is redacted', () => {
  const text = 'pasted https%3A%2F%2Fhost.example.invalid%2Fjoin%23invite%3DFAKEBLOB123456';
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_INVITATION));
  const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_INVITATION);
  const redacted = redactEvidence(text);
  assert.ok(!redacted.includes('FAKEBLOB123456'), redacted);
  assert.deepEqual(findSecretsInEvidence(redacted), []);
});

test('P1 encoded: a URL-encoded faravan:// wrapper is detected and its whole encoded value is redacted', () => {
  const text = 'handler faravan%3A%2F%2Fjoin%3Flink%3Dhttps%253A%252F%252Fhost.example.invalid%252Fjoin%2523invite%253DFAKEBLOB123456';
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_INVITATION));
  const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_INVITATION);
  const redacted = redactEvidence(text);
  assert.ok(!redacted.includes('FAKEBLOB123456'), redacted);
  assert.deepEqual(findSecretsInEvidence(redacted), []);
});

test('P1 encoded: a JSON-escaped short invitation link is detected and its whole escaped value is redacted', () => {
  const text = 'logged {"url":"https:\\/\\/host.example.invalid\\/i\\/FAKECODE1234#FAKESEED5678"}';
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_INVITATION));
  const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_INVITATION);
  const redacted = redactEvidence(text);
  assert.ok(!redacted.includes('FAKECODE1234') && !redacted.includes('FAKESEED5678'), redacted);
  assert.deepEqual(findSecretsInEvidence(redacted), []);
});

test('P1 encoded: a serialized Authorization header in JSON is detected and redacted', () => {
  const text = '{"Authorization":"Basic FAKE-AUTH-1234"}';
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_AUTH_HEADER));
  const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_AUTH_HEADER);
  const redacted = redactEvidence(text);
  assert.equal(redacted, `{"Authorization":"${REDACTION_MARKER}"}`);
  assert.deepEqual(findSecretsInEvidence(redacted), []);
});

test('P1 encoded: a serialized Authorization header with escaped quotes is detected and redacted', () => {
  const text = '{\\"Authorization\\":\\"Basic FAKE-AUTH-1234\\"}';
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_AUTH_HEADER));
  const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_AUTH_HEADER);
  const redacted = redactEvidence(text);
  assert.equal(redacted, `{\\"Authorization\\":\\"${REDACTION_MARKER}\\"}`);
  assert.deepEqual(findSecretsInEvidence(redacted), []);
});

test('P1 encoded: a doubly percent-encoded short invitation link is detected', () => {
  const text = 'opened https%253A%252F%252Fhost.example.invalid%252Fi%252FFAKECODE1234%2523FAKESEED5678';
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_INVITATION));
  const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_INVITATION);
  assert.ok(!redactEvidence(text).includes('FAKECODE1234'));
});

// --- P1: diagnostic issue items echo secrets from input metadata -----------

test('P1 items: a secret-shaped evidence artifact name is never echoed in an issue item', () => {
  const input = cleanInput({evidence: [
    {name: 'https://example.invalid/?token=FAKE-TOKEN-1234', text: 'Bearer FAKE-BEARER-TOKEN-1234'},
  ]});
  const result = checkPreservation(input);
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_BEARER_TOKEN);
  assert.ok(result.issues.some(issue => issue.item === 'evidence[0]'));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-TOKEN-1234'));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-BEARER-TOKEN-1234'));
});

test('P1 items: a secret-shaped outside write path is never echoed in an issue item', () => {
  const input = cleanInput();
  input.writes.push({path: '/outside/?token=FAKE-TOKEN-1234'});
  const result = checkPreservation(input);
  assertBlockedWithCode(result, BLOCKED_CODES.WRITE_OUTSIDE_RUN_ROOTS);
  assert.ok(result.issues.some(issue => issue.item === 'writes[3].path'));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-TOKEN-1234'));
});

test('P1 items: a secret-shaped unowned install destination is never echoed in an issue item', () => {
  const input = cleanInput({install: {label: 'fresh-install', destination: '/outside/?token=FAKE-TOKEN-1234', runOwned: false, priorRunReceipt: null}});
  const result = checkPreservation(input);
  assertBlockedWithCode(result, BLOCKED_CODES.INSTALL_DESTINATION_NOT_RUN_OWNED);
  assert.ok(result.issues.some(issue => issue.item === 'install.destination'));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-TOKEN-1234'));
});

test('P1 items: a secret-shaped unowned forward receipt id is never echoed in an issue item', () => {
  const input = cleanInput();
  input.closeReceipts.push({kind: 'forward', id: '?token=FAKE-TOKEN-1234', owned: false, closed: true});
  const result = checkPreservation(input);
  assertBlockedWithCode(result, BLOCKED_CODES.CLEANUP_UNOWNED_PROCESS);
  assert.ok(result.issues.some(issue => issue.item === 'closeReceipts[2]'));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-TOKEN-1234'));
});

test('P1 items: a secret-shaped missing expected forward id is never echoed in an issue item', () => {
  const input = cleanInput({
    expectedCloses: [
      {kind: 'process', id: 4242},
      {kind: 'forward', id: '?token=FAKE-TOKEN-1234'},
    ],
    closeReceipts: [{kind: 'process', id: 4242, owned: true, closed: true}],
  });
  const result = checkPreservation(input);
  assertBlockedWithCode(result, BLOCKED_CODES.MISSING_CLEANUP_RECEIPT);
  assert.ok(result.issues.some(issue => issue.item === 'expectedCloses[1]'));
  assert.ok(!JSON.stringify(result.issues).includes('FAKE-TOKEN-1234'));
});

// --- P1: malformed or partial required snapshots / receipts -----------------

test('P1 schema: a null channel identity fails instead of passing', () => {
  const result = checkPreservation(cleanInput({channel: {before: null, after: null}}));
  assertFailedMissingInput(result);
});

test('P1 schema: an empty or non-string channel identity fails instead of passing', () => {
  for (const channel of [
    {before: '', after: ''},
    {before: {id: 1}, after: {id: 1}},
    {before: 7, after: 7},
    {before: true, after: true},
  ]) {
    assertFailedMissingInput(checkPreservation(cleanInput({channel})));
  }
});

test('P1 schema: empty tray snapshots fail instead of passing', () => {
  const empty = {trayModels: [], traySelections: {}};
  const result = checkPreservation(cleanInput({preferences: {before: {...empty}, after: {...empty}}}));
  assertFailedMissingInput(result);
});

test('P1 schema: tray snapshots without any selections fail instead of passing', () => {
  const input = cleanInput();
  input.preferences.before.traySelections = {};
  input.preferences.after.traySelections = {};
  assertFailedMissingInput(checkPreservation(input));
});

test('P1 schema: malformed tray model identities fail instead of passing', () => {
  for (const trayModels of [[null], [7], ['fake-model-a', 'fake-model-a']]) {
    const input = cleanInput();
    input.preferences.before.trayModels = [...trayModels];
    input.preferences.after.trayModels = [...trayModels];
    assertFailedMissingInput(checkPreservation(input));
  }
});

test('P1 schema: an unsupported close kind fails instead of passing', () => {
  const input = cleanInput({
    expectedCloses: [{kind: 'bogus', id: null}],
    closeReceipts: [{kind: 'bogus', id: null, owned: true, closed: true}],
  });
  assertFailedMissingInput(checkPreservation(input));
});

test('P1 schema: non-scalar close ids fail instead of passing', () => {
  const input = cleanInput({
    expectedCloses: [{kind: 'forward', id: {a: 1}}],
    closeReceipts: [{kind: 'forward', id: {a: 2}, owned: true, closed: true}],
  });
  assertFailedMissingInput(checkPreservation(input));
});

test('P1 schema: a receipt without an explicit closed field fails instead of passing', () => {
  const input = cleanInput();
  input.closeReceipts.push({kind: 'forward', id: 'fake-forward-FAKE-2', owned: true});
  assertFailedMissingInput(checkPreservation(input));
});

test('P1 schema: a receipt without an explicit owned field fails instead of passing', () => {
  const input = cleanInput();
  input.closeReceipts.push({kind: 'forward', id: 'fake-forward-FAKE-2', closed: true});
  assertFailedMissingInput(checkPreservation(input));
});

test('P1 schema: a string process id does not satisfy a numeric expected pid, and a numeric forward id does not satisfy a string one', () => {
  const stringPid = cleanInput({
    expectedCloses: [{kind: 'process', id: 4242}],
    closeReceipts: [{kind: 'process', id: '4242', owned: true, closed: true}],
  });
  assertFailedMissingInput(checkPreservation(stringPid));
  const numericForward = cleanInput({
    expectedCloses: [{kind: 'forward', id: '4242'}],
    closeReceipts: [{kind: 'forward', id: 4242, owned: true, closed: true}],
  });
  assertFailedMissingInput(checkPreservation(numericForward));
});

// --- P2: a marker substring must not suppress a still-unredacted secret ----

test('P2 marker: a marker glued to a session token is still a secret', () => {
  for (const text of [
    'GET https://example.invalid/join?token=[REDACTED]FAKE-TOKEN-1234 200',
    'GET https://example.invalid/join?token=FAKE-TOKEN-1234[REDACTED] 200',
  ]) {
    const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
    assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_SESSION_TOKEN_URL);
  }
});

test('P2 marker: a marker next to another credential in an auth header is still a secret', () => {
  const input = cleanInput({evidence: [
    {name: 'trace.log', text: 'request headers:\nAuthorization: Basic [REDACTED] FAKE-AUTH-1234\n'},
  ]});
  const result = checkPreservation(input);
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_AUTH_HEADER);
});

test('P2 marker: a marker glued to an invitation value is still a secret', () => {
  const input = cleanInput({evidence: [
    {name: 'step-2.json', text: '{"invitation_token": "[REDACTED]FAKE-INVITE-1234"}'},
  ]});
  const result = checkPreservation(input);
  assertBlockedWithCode(result, BLOCKED_CODES.EVIDENCE_INVITATION);
});

test('P2 marker guard: a value that is exactly the marker passes', () => {
  for (const text of [
    'GET https://example.invalid/join?token=[REDACTED] 200',
    'Authorization: Basic [REDACTED]',
    'Authorization: [REDACTED]',
    'invite=[REDACTED]',
  ]) {
    const result = checkPreservation(cleanInput({evidence: [{name: 'trace.log', text}]}));
    assert.equal(result.status, 'pass', text);
    assert.deepEqual(result.issues, []);
  }
});

// --- P2: replacement must redact the value, not the field name or scheme ---

test('P2 replacement: redaction replaces the value, not the key, when the value repeats the key', () => {
  assert.equal(redactEvidence('invitation=invitation'), `invitation=${REDACTION_MARKER}`);
});

test('P2 replacement: redaction replaces the value, not the key, when the key contains the value', () => {
  assert.equal(redactEvidence('invitation_token=token'), `invitation_token=${REDACTION_MARKER}`);
});

test('P2 replacement: redaction replaces the bearer value, not the scheme', () => {
  assert.equal(redactEvidence('Bearer Bearer'), `Bearer ${REDACTION_MARKER}`);
});

test('P2 replacement guard: redacted key-collision outputs pass the check', () => {
  for (const text of ['invitation=invitation', 'invitation_token=token', 'Bearer Bearer']) {
    assert.deepEqual(findSecretsInEvidence(redactEvidence(text)), [], text);
  }
});

// --- P2: relative paths are rejected, not treated as absolute ---------------

test('P2 paths: a relative path is never under an absolute root', () => {
  assert.equal(isUnderRoot('/run-a', 'run-a/file'), false);
  assert.equal(isUnderRoot('/tmp/fake-run-FAKE/app-state', 'tmp/fake-run-FAKE/app-state/settings.json'), false);
});

test('P2 paths: a relative write is failed input, not a pass', () => {
  const input = cleanInput();
  input.writes[0] = {path: 'tmp/FAKE-run/state/settings.json'};
  assertFailedMissingInput(checkPreservation(input));
});

test('P2 paths: a relative run root is failed input', () => {
  const input = cleanInput({runRoots: {...RUN_ROOTS, appState: 'tmp/fake-run-FAKE/app-state'}});
  assertFailedMissingInput(checkPreservation(input));
});

test('P2 paths: a relative install destination is failed input', () => {
  const input = cleanInput({install: {label: 'fresh-install', destination: 'tmp/fake-run-FAKE/install', runOwned: true, priorRunReceipt: null}});
  assertFailedMissingInput(checkPreservation(input));
});

test('P2 paths: an absolute path that normalizes inside its root still passes', () => {
  const input = cleanInput({runRoots: {...RUN_ROOTS, appState: '/tmp/fake-run-FAKE/app-state/../app-state'}});
  const result = checkPreservation(input);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.issues, []);
});
