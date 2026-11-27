import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_CODES, REDACTION_MARKER, checkPreservation, findSecretsInEvidence, redactEvidence } from '../packaging/journey/preservation.mjs';

// One desired-behavior regression per exact input in pr84-rereview2.md.
// All values and paths are synthetic. No accounts, network or app state.
const SHORT_INVITE = 'https://host.example.invalid/i/FAKECODE1234#FAKESEED5678';
const AUTH_BODY = '{"Authorization":"Basic FAKE-AUTH-1234"}';
const MODELS = ['fake-model-a', 'fake-model-b', 'fake-model-c', 'fake-model-d', 'fake-model-e', 'fake-model-f', 'fake-model-g'];

function cleanInput(text = 'step pass, no secrets here') {
  const snapshot = () => ({
    trayModels: [...MODELS],
    traySelections: Object.fromEntries(MODELS.map((model, i) => [model, i ? 'unselected' : 'selected'])),
  });
  return {
    install: { label: 'fresh-install', destination: '/tmp/FAKE-run/install', runOwned: true, priorRunReceipt: null },
    runRoots: { appState: '/tmp/FAKE-run/state', install: '/tmp/FAKE-run/install', evidence: '/tmp/FAKE-run/evidence' },
    writes: [{ path: '/tmp/FAKE-run/state/settings.json' }],
    preferences: { before: snapshot(), after: snapshot() },
    channel: { before: 'FAKE-channel', after: 'FAKE-channel' },
    expectedCloses: [{ kind: 'process', id: 4242 }],
    closeReceipts: [{ kind: 'process', id: 4242, owned: true, closed: true }],
    evidence: [{ name: 'FAKE-case.log', text }],
  };
}

function assertSecretRemoved(text, code, forbidden) {
  assert.ok(findSecretsInEvidence(text).some(finding => finding.code === code), 'detect the original input');
  const result = checkPreservation(cleanInput(text));
  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.some(issue => issue.code === code && issue.item === 'evidence[0]'));
  const redacted = redactEvidence(text);
  assert.notEqual(redacted, text);
  assert.ok(redacted.includes(REDACTION_MARKER));
  for (const value of forbidden) {
    assert.ok(!redacted.includes(value), 'remove the actual raw/encoded value, not only its context');
    assert.ok(!JSON.stringify(result).includes(value), 'diagnostics do not echo evidence');
  }
  assert.deepEqual(findSecretsInEvidence(redacted), []);
  assert.equal(checkPreservation(cleanInput(redacted)).status, 'pass');
}

const encodedInvite = Buffer.from(SHORT_INVITE).toString('base64');
const encodedAuth = Buffer.from(AUTH_BODY).toString('base64');
const reportCases = [
  ['R1 bare base64 invitation', encodedInvite, BLOCKED_CODES.EVIDENCE_INVITATION, [encodedInvite, 'FAKECODE1234', 'FAKESEED5678']],
  ['R1 labelled base64 auth body', JSON.stringify({ body: encodedAuth, encoding: 'base64' }), BLOCKED_CODES.EVIDENCE_AUTH_HEADER, [encodedAuth, 'FAKE-AUTH-1234']],
  ['R2 multiline JSON Authorization', '{"Authorization":\n "Basic FAKE-AUTH-1234"}', BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']],
  ['R2 multiline JSON invitation_token', '{"invitation_token":\n "FAKE-INVITE-1234"}', BLOCKED_CODES.EVIDENCE_INVITATION, ['FAKE-INVITE-1234']],
  ['R2 escaped JSON Authorization key', '{"Authoriz\\u0061tion":"Basic FAKE-AUTH-1234"}', BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']],
  ['R2 escaped JSON invite key', '{"invit\\u0065":"FAKE-INVITE-1234"}', BLOCKED_CODES.EVIDENCE_INVITATION, ['FAKE-INVITE-1234']],
  ['R2 auth header in object key', '{"Authorization: Basic FAKE-AUTH-1234":"seen"}', BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']],
  ['R2 credential after marker on continuation line', 'Authorization: Basic [REDACTED]\r\n FAKE-AUTH-1234', BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']],
  ['R2 header value starts on next line', 'Authorization:\n Basic FAKE-AUTH-1234', BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']],
  ['R3 encoded invitation plus malformed adjacent escape', encodeURIComponent(SHORT_INVITE) + '%', BLOCKED_CODES.EVIDENCE_INVITATION, ['FAKECODE1234', 'FAKESEED5678']],
  ['R3 encoded Authorization with literal space', 'Authorization%3A Basic%20FAKE-AUTH-1234', BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']],
];

for (const [name, text, code, forbidden] of reportCases) {
  test(name, () => assertSecretRemoved(text, code, forbidden));
}

for (const count of [6, 1]) {
  test(`R4 equal ${count}-model snapshots fail despite internally consistent selections`, () => {
    const input = cleanInput();
    for (const snapshot of Object.values(input.preferences)) {
      snapshot.trayModels.splice(count);
      for (const model of MODELS.slice(count)) delete snapshot.traySelections[model];
    }
    const result = checkPreservation(input);
    assert.equal(result.status, 'failed');
    for (const side of ['before', 'after']) {
      assert.ok(result.issues.some(issue => issue.code === BLOCKED_CODES.MISSING_INPUT && issue.item === `preferences.${side}.trayModels`));
    }
  });
}

test('control: a complete unchanged seven-model run with no secrets passes', () => {
  assert.deepEqual(checkPreservation(cleanInput()), { status: 'pass', label: 'fresh-install', issues: [] });
});

test('control: innocent base64 and base64url remain unchanged and pass', () => {
  for (const encoding of ['base64', 'base64url']) {
    for (const raw of ['ordinary clean evidence', '{"status":"ready"}']) {
      for (const text of [Buffer.from(raw).toString(encoding), JSON.stringify({ body: Buffer.from(raw).toString(encoding), encoding })]) {
        assert.deepEqual(findSecretsInEvidence(text), []);
        assert.equal(redactEvidence(text), text);
        assert.equal(checkPreservation(cleanInput(text)).status, 'pass');
      }
    }
  }
});

test('control: a clean percent-encoded invitation is still detected and removed', () => {
  assertSecretRemoved(encodeURIComponent(SHORT_INVITE), BLOCKED_CODES.EVIDENCE_INVITATION, ['FAKECODE1234', 'FAKESEED5678']);
});

test('boundary: base64url, unpadded base64 and nested supported encodings remove whole values', () => {
  for (const text of [
    Buffer.from(SHORT_INVITE + '\uffff').toString('base64url'),
    encodedInvite.replace(/=+$/, ''),
    Buffer.from(encodeURIComponent(SHORT_INVITE)).toString('base64'),
    encodeURIComponent(Buffer.from(SHORT_INVITE).toString('base64')),
  ]) {
    assertSecretRemoved(text, BLOCKED_CODES.EVIDENCE_INVITATION, [text, 'FAKECODE1234', 'FAKESEED5678']);
  }
});

test('boundary: malformed percent neighbors do not mask supported ASCII escapes', () => {
  for (const suffix of ['%GG', '%FF', '%E0%A4%A', '%25']) {
    assertSecretRemoved(encodeURIComponent(SHORT_INVITE) + suffix, BLOCKED_CODES.EVIDENCE_INVITATION, ['FAKECODE1234', 'FAKESEED5678']);
  }
});

test('boundary: malformed, opaque or unsupported labelled encodings fail closed', () => {
  for (const [body, encoding] of [
    ['FAKE-not-base64!!', 'base64'], ['Zm9v=', 'base64'], ['/w==', 'base64'],
    [encodedAuth, 'gzip'], [42, 'base64'], ['Zm9v', null],
  ]) {
    const text = JSON.stringify({ body, encoding });
    assertSecretRemoved(text, BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, [JSON.stringify(body)]);
  }
});

test('boundary: duplicate decoded JSON keys cannot discard an earlier secret', () => {
  for (const text of [
    '{"Authorization":"Basic FAKE-AUTH-1234","Authorization":"[REDACTED]"}',
    '{"invit\\u0065":"FAKE-INVITE-1234","invite":"[REDACTED]"}',
  ]) {
    assertSecretRemoved(text, BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, ['FAKE-AUTH-1234', 'FAKE-INVITE-1234']);
  }
});

test('boundary: incomplete structured JSON cannot drop the context on a prior line', () => {
  assertSecretRemoved('{"Authoriz\\u0061tion":\n "Basic FAKE-AUTH-1234"', BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, ['FAKE-AUTH-1234']);
});

test('boundary: evidence exceeding size, nesting or node limits fails closed', () => {
  for (const text of ['x'.repeat(1024 * 1024 + 1), '['.repeat(20) + '0' + ']'.repeat(20), JSON.stringify(Array(10001).fill(0))]) {
    assert.ok(findSecretsInEvidence(text).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_UNINSPECTABLE));
    assert.equal(checkPreservation(cleanInput(text)).status, 'blocked');
    assert.equal(redactEvidence(text), REDACTION_MARKER);
  }
});

test('boundary: every snapshot count other than seven is refused, on either or both sides', () => {
  for (const count of [0, 1, 6, 8]) {
    for (const sides of [['before'], ['after'], ['before', 'after']]) {
      const input = cleanInput();
      for (const side of sides) {
        const models = [...MODELS, 'fake-model-h'].slice(0, count);
        input.preferences[side] = { trayModels: models, traySelections: Object.fromEntries(models.map(model => [model, 'selected'])) };
      }
      assert.notEqual(checkPreservation(input).status, 'pass');
    }
  }
});

test('control: independent JSON objects may reuse keys and clean headers retain nonsecret lines', () => {
  for (const text of ['[{"status":"ready"},{"status":"ready"}]', '[INFO] step ready', '{"Authorization":"Basic [REDACTED]"}']) {
    assert.deepEqual(findSecretsInEvidence(text), []);
    assert.equal(redactEvidence(text), text);
  }
  const text = 'Authorization: Basic FAKE-AUTH-1234\r\n FAKE-CONTINUATION\r\nStatus: ready';
  assertSecretRemoved(text, BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234', 'FAKE-CONTINUATION']);
  assert.ok(redactEvidence(text).includes('Status: ready'));
});

// N1–N4 regressions from pr84-rereview3.md (issue #104). All secrets synthetic.
// N1_COMPLETE is the review's complete array: an escaped Authorization key
// followed by a newline (JSON whitespace) before the credential value.
const N1_COMPLETE = '[{"Authoriz\u0061tion":\n"Basic FAKE-AUTH-1234"}]';

test('N1: truncated JSON-shaped array fails closed instead of certifying clean', () => {
  assertSecretRemoved(N1_COMPLETE.slice(0, -1), BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, ['FAKE-AUTH-1234']);
});

test('N1: truncated string envelope fails closed', () => {
  assertSecretRemoved('["Authorization: Basic FAKE-AUTH-1234"', BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, ['FAKE-AUTH-1234']);
});

test('N1: prefixed complete JSON object keeps key/value context', () => {
  assertSecretRemoved(`INFO ${N1_COMPLETE.slice(1, -1)}`, BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']);
});

test('N1: prefixed truncated array fails closed', () => {
  assertSecretRemoved(`INFO ${N1_COMPLETE.slice(0, -1)}`, BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, ['FAKE-AUTH-1234']);
});

test('N1 control: complete array blocks and bracket labels still pass', () => {
  assertSecretRemoved(N1_COMPLETE, BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']);
  assert.deepEqual(findSecretsInEvidence('[INFO] step ready'), []);
  assert.equal(redactEvidence('[INFO] step ready'), '[INFO] step ready');
});

const N2_BODY = JSON.stringify({ Authorization: 'Digest username="FAKE-USER", response="FAKE-AUTH-1234"' });

test('N2: prefixed serialized header redacts the whole response value', () => {
  assertSecretRemoved(`INFO ${N2_BODY}`, BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234', 'FAKE-USER']);
});

test('N2: nested prefixed serialized header redacts the whole response value', () => {
  assertSecretRemoved(JSON.stringify({ log: `INFO ${N2_BODY}` }), BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234', 'FAKE-USER']);
});

test('N2: serialized header with escaped quotes redacts past the escaped quote', () => {
  assertSecretRemoved(`>> ${N2_BODY}`, BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234', 'FAKE-USER']);
});

test('N3: non-UTF-8 bytes next to canonical base64 do not switch inspection off', () => {
  const withSuffixByte = Buffer.concat([Buffer.from(SHORT_INVITE), Buffer.from([0xff])]).toString('base64');
  const withPrefixByte = Buffer.concat([Buffer.from([0xff]), Buffer.from(SHORT_INVITE)]).toString('base64');
  for (const token of [withSuffixByte, withPrefixByte]) {
    assertSecretRemoved(token, BLOCKED_CODES.EVIDENCE_INVITATION, [token, 'FAKECODE1234', 'FAKESEED5678']);
  }
});

test('N3: base64 split across a line break and base64 as a URL segment are inspected', () => {
  const token = Buffer.from(SHORT_INVITE).toString('base64');
  const split = `${token.slice(0, 40)}\n${token.slice(40)}`;
  assertSecretRemoved(split, BLOCKED_CODES.EVIDENCE_INVITATION, [token.slice(0, 40), token.slice(40), 'FAKECODE1234', 'FAKESEED5678']);
  assertSecretRemoved(`https://host.example.invalid/${token}`, BLOCKED_CODES.EVIDENCE_INVITATION, [token, 'FAKECODE1234', 'FAKESEED5678']);
});

function nestedWrappers(depth) {
  let value = 'ordinary clean evidence';
  for (let i = 0; i < depth; i++) value = { x: value };
  return JSON.stringify(value);
}

test('N4: redaction of 11/12-wrapper evidence rescans clean', () => {
  for (const depth of [11, 12]) {
    assertSecretRemoved(nestedWrappers(depth), BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, ['ordinary clean evidence']);
  }
});

test('N4 control: 10 wrappers pass unchanged', () => {
  const text = nestedWrappers(10);
  assert.deepEqual(findSecretsInEvidence(text), []);
  assert.equal(redactEvidence(text), text);
  assert.equal(checkPreservation(cleanInput(text)).status, 'pass');
});

test('N1 review: a secret in the log prefix before a JSON body is still found', () => {
  assertSecretRemoved('Authorization: Bearer FAKE-AUTH-1234\n\n{"a":1}', BLOCKED_CODES.EVIDENCE_AUTH_HEADER, ['FAKE-AUTH-1234']);
  assertSecretRemoved('Bearer FAKE-AUTH-1234 {"a":1}', BLOCKED_CODES.EVIDENCE_BEARER_TOKEN, ['FAKE-AUTH-1234']);
  assertSecretRemoved('invitation: FAKECODE1234 {"a":1}', BLOCKED_CODES.EVIDENCE_INVITATION, ['FAKECODE1234']);
  const both = 'Bearer FAKE-AUTH-1234 {"Authorization":"Basic FAKE-USER"}';
  assertSecretRemoved(both, BLOCKED_CODES.EVIDENCE_BEARER_TOKEN, ['FAKE-AUTH-1234', 'FAKE-USER']);
  assert.ok(findSecretsInEvidence(both).some(finding => finding.code === BLOCKED_CODES.EVIDENCE_AUTH_HEADER));
});
