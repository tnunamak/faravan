import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHarnessAdapter, HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';
import {
  adapterVersion, buildEvidenceRecord, credentialProxyVerified, extractReport, hostCredentialHashes, loadEvidenceRecords,
  normalizeSbxVersion, readFaravanVersion, currentProbeDigest, validateProbeReport, REQUIRED_CHECKS, MARKER, PROBE_VERSION,
} from '../lib/v1/credential-probe.mjs';
import {
  classifyEnv, classifyValue, decideVerdict, isSentinel, runProbe, scanText, selfTest, sha256,
  SUDO_CANDIDATES,
} from '../lib/v1/credential-probe-guest.mjs';

import { SBX_VERSION as SBX, check, passingChecks, passingReport } from './helpers/credential-probe-fixture.mjs';
import { SYNTHETIC_CERTIFICATE, syntheticHeader, syntheticJws, syntheticPayload, syntheticSignatureFile, writeSignatureFile } from './helpers/policy-signature-fixture.mjs';

const MVP = ['claude-code-subscription', 'codex'];
const NOW = Date.parse('2026-10-20T12:00:00Z');
// Made-up values with the shapes of real tokens. None of them is a credential.
const FAKE_ANTHROPIC = 'sk-ant-oat01-' + 'Zq7Tn4Xw1Lp8Vb3Rk9Ys2Hd6Mc5Fj0GaQw3Er5Ty7Ui9Op1As3Df5';
const FAKE_JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2lnbmF0dXJlLXRlc3Qtb25seQ'].join('.');
const FAKE_GITHUB = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

const adapter = (id) => getHarnessAdapter(id);
const record = (id = 'codex', overrides = {}) => ({
  ...buildEvidenceRecord({ report: passingReport(), adapter: adapter(id), faravanVersion: '0.1.0', sbxVersion: SBX, testedAt: '2026-10-19T12:00:00Z', probeDigest: currentProbeDigest() }),
  ...overrides,
});
const context = (id = 'codex', overrides = {}) => ({ adapter: adapter(id), faravanVersion: '0.1.0', sbxVersion: SBX, now: NOW, ...overrides });

// ---- the report and the verdict -----------------------------------------------------------

test('a pass needs every required check clear, a bound provider and a working self test', () => {
  assert.equal(decideVerdict({ checks: passingChecks(), provider: passingReport().provider, selfTest: passingReport().self_test }).verdict, 'pass');
  assert.equal(validateProbeReport(passingReport()).ok, true);
});

test('a real secret or a usable lender authority fails; lower findings do not', () => {
  const provider = passingReport().provider, test_ = passingReport().self_test;
  for (const severity of ['critical', 'high']) {
    const checks = passingChecks().map((entry) => entry.id === 'mcp-gateway' ? check('mcp-gateway', true, 'tools', severity) : entry);
    assert.equal(decideVerdict({ checks, provider, selfTest: test_ }).verdict, 'fail', severity);
  }
  for (const severity of ['medium', 'low', 'info']) {
    const checks = passingChecks().map((entry) => entry.id === 'mcp-gateway' ? check('mcp-gateway', true, 'management tools only', severity) : entry);
    assert.equal(decideVerdict({ checks, provider, selfTest: test_ }).verdict, 'pass', severity);
  }
});

test('a failure beats every inconclusive reason', () => {
  const checks = passingChecks().map((entry) => entry.id === 'credential-files' ? check('credential-files', true, '1 real-looking', 'critical') : entry.id === 'ssh-agent' ? check('ssh-agent', null) : entry);
  assert.equal(decideVerdict({ checks, provider: { mode: 'none' }, selfTest: { canary_detected: false } }).verdict, 'fail');
});

test('inconclusive: not signed in, no sentinel seen, a check that could not run, a self test that failed, a missing check', () => {
  const good = passingReport();
  const verdict = (overrides) => decideVerdict({ checks: good.checks, provider: good.provider, selfTest: good.self_test, ...overrides });
  assert.deepEqual(verdict({ provider: { ...good.provider, mode: 'none' } }), { verdict: 'inconclusive', reasons: ['provider_not_signed_in'] });
  assert.deepEqual(verdict({ provider: { ...good.provider, mode: 'unknown' } }).reasons, ['provider_not_signed_in']);
  assert.deepEqual(verdict({ provider: { ...good.provider, sentinels: 0 } }).reasons, ['no_sentinel_observed']);
  assert.deepEqual(verdict({ selfTest: { canary_detected: true, sentinel_ignored: false } }).reasons, ['self_test_failed']);
  assert.deepEqual(verdict({ checks: good.checks.map((entry) => entry.id === 'host-mounts' ? check('host-mounts', null) : entry) }).reasons, ['check_unavailable:host-mounts']);
  assert.deepEqual(verdict({ checks: good.checks.filter((entry) => entry.id !== 'ssh-agent') }).reasons, ['missing_check:ssh-agent']);
});

test('the host refuses a report whose verdict, shape or evidence cannot be trusted', () => {
  const refuse = (report, reason) => assert.deepEqual(validateProbeReport(report), { ok: false, reason });
  refuse(null, 'report_not_object');
  refuse({ ...passingReport(), probe_version: PROBE_VERSION + 1 }, 'probe_version_unsupported');
  refuse({ ...passingReport(), verdict: 'maybe' }, 'verdict_invalid');
  refuse({ ...passingReport(), checks: [] }, 'checks_invalid');
  // The probe ran beside the job, so its verdict is only believed when its own checks imply it.
  refuse({ ...passingReport(), checks: passingChecks().map((entry) => entry.id === 'env-secrets' ? check('env-secrets', true, 'x', 'critical') : entry) }, 'verdict_inconsistent');
  refuse({ ...passingReport(), checks: passingChecks().filter((entry) => entry.id !== 'ssh-agent') }, 'verdict_inconsistent');
  refuse({ ...passingReport(), checks: [...passingChecks(), check('ssh-agent')] }, 'check_id_duplicate');
  refuse({ ...passingReport(), checks: passingChecks().map((entry) => ({ ...entry, severity: 'catastrophic' })) }, 'check_severity_invalid');
  refuse({ ...passingReport(), checks: passingChecks().map((entry) => entry.id === 'env-secrets' ? { ...entry, found: 'no' } : entry) }, 'check_found_invalid');
  refuse({ ...passingReport(), self_test: null }, 'self_test_invalid');
  refuse({ ...passingReport(), checks: passingChecks().map((entry) => entry.id === 'env-secrets' ? check('env-secrets', false, 'a'.repeat(2001)) : entry) }, 'check_evidence_invalid');
});

test('a report that carries something shaped like a real secret is refused, never stored', () => {
  for (const leak of [FAKE_ANTHROPIC, FAKE_JWT, FAKE_GITHUB, 'accessToken: "Qx9Lm4Zp7Rk2Vc5Bn8Ty3Wd6"']) {
    const report = passingReport({ checks: passingChecks().map((entry) => entry.id === 'env-secrets' ? check('env-secrets', false, 'seen ' + leak) : entry) });
    assert.deepEqual(validateProbeReport(report), { ok: false, reason: 'evidence_contains_secret' }, leak);
    assert.throws(() => buildEvidenceRecord({ report, adapter: adapter('codex'), faravanVersion: '0.1.0', sbxVersion: SBX, testedAt: '2026-10-19T12:00:00Z' }), { code: 'probe_report_invalid' });
  }
});

test('sandbox output yields the last marked report and ignores shell noise', () => {
  const report = passingReport();
  assert.deepEqual(extractReport(`warning\n${MARKER}${JSON.stringify({ stale: true })}\nmore\n${MARKER}${JSON.stringify(report)}\n`), report);
  assert.equal(extractReport('no marker here'), null);
  assert.equal(extractReport(`${MARKER}{not json`), null);
  assert.equal(extractReport(undefined), null);
});

// ---- the evidence record and the flag -----------------------------------------------------

test('the evidence record names the adapter, its version, Faravan, sbx, the date and the label', () => {
  const made = record('codex');
  assert.equal(made.kind, 'credential_proxy');
  assert.equal(made.schema, 1);
  assert.equal(made.label, 'internal');
  assert.equal(made.result, 'pass');
  assert.equal(made.adapter_id, 'codex');
  assert.match(made.adapter_version, /^spec-[0-9a-f]{16}$/);
  assert.equal(made.faravan_version, '0.1.0');
  assert.equal(made.sbx_version, '0.48.0+5caf923e0587d376848f6f388eca3e0f5ca00e2d');
  assert.equal(made.tested_at, '2026-10-19T12:00:00Z');
  assert.deepEqual(made.checks.map((entry) => entry.id), passingChecks().map((entry) => entry.id));
  assert.ok(made.checks.every((entry) => Object.keys(entry).sort().join() === 'found,id,severity'), 'only ids and results are stored');
  assert.equal(buildEvidenceRecord({ report: passingReport(), adapter: adapter('codex'), faravanVersion: '0.1.0', sbxVersion: SBX, testedAt: '2026-10-19T12:00:00Z', label: 'independent' }).label, 'independent');
});

test('the evidence record is refused without exact inputs', () => {
  const base = { report: passingReport(), adapter: adapter('codex'), faravanVersion: '0.1.0', sbxVersion: SBX, testedAt: '2026-10-19T12:00:00Z' };
  for (const [change, code] of [[{ faravanVersion: null }, 'faravan_version_unknown'], [{ faravanVersion: '' }, 'faravan_version_unknown'],
    [{ sbxVersion: 'unknown' }, 'sbx_version_unknown'], [{ adapter: null }, 'adapter_unknown'], [{ testedAt: 'yesterday' }, 'tested_at_invalid'],
    [{ label: 'self-certified' }, 'label_invalid']])
    assert.throws(() => buildEvidenceRecord({ ...base, ...change }), { code });
});

for (const id of MVP) test(`${id}: a passing record for the exact versions turns the flag on`, () => {
  assert.equal(credentialProxyVerified([record(id)], context(id)), true);
  assert.equal(credentialProxyVerified([record('codex'), record('claude-code-subscription')], context(id)), true);
});

for (const id of MVP) test(`${id}: any change to the binding turns the flag off (stale evidence)`, () => {
  const rows = [record(id)];
  assert.equal(credentialProxyVerified(rows, context(id, { faravanVersion: '0.1.1' })), false, 'new Faravan version');
  assert.equal(credentialProxyVerified(rows, context(id, { faravanVersion: null })), false, 'unknown Faravan version (a source checkout)');
  assert.equal(credentialProxyVerified(rows, context(id, { sbxVersion: 'sbx version v0.48.1 5caf923e0587d376848f6f388eca3e0f5ca00e2d' })), false, 'new sbx patch');
  assert.equal(credentialProxyVerified(rows, context(id, { sbxVersion: 'sbx version v0.48.0 0000000e0587d376848f6f388eca3e0f5ca00e2d' })), false, 'rebuilt sbx');
  assert.equal(credentialProxyVerified(rows, context(id, { sbxVersion: 'sbx version v0.48.0' })), false, 'sbx build unknown but the record names one');
  assert.equal(credentialProxyVerified(rows, context(id, { sbxVersion: 'unreadable' })), false);
  assert.equal(credentialProxyVerified(rows, context(id, { sbxVersion: null })), false);
  const edited = { ...adapter(id), spec: { ...adapter(id).spec, entrypoint: adapter(id).spec.entrypoint + ' --extra' } };
  assert.notEqual(adapterVersion(edited), adapterVersion(adapter(id)));
  assert.equal(credentialProxyVerified(rows, context(id, { adapter: edited })), false, 'adapter spec edited');
  const other = MVP.find((candidate) => candidate !== id);
  assert.equal(credentialProxyVerified([record(other)], context(id)), false, 'record belongs to another adapter');
});

test('a record made by another probe version or probe file does not turn the flag on', () => {
  const ok = record();
  assert.equal(credentialProxyVerified([ok], context()), true);
  assert.equal(credentialProxyVerified([{ ...ok, probe_version: PROBE_VERSION - 1 }], context()), false, 'older probe version');
  assert.equal(credentialProxyVerified([{ ...ok, probe_version: undefined }], context()), false, 'no probe version');
  assert.equal(credentialProxyVerified([{ ...ok, probe_digest: '0000000000000000' }], context()), false, 'edited probe file');
  assert.equal(credentialProxyVerified([{ ...ok, probe_digest: null }], context()), false, 'no digest');
  assert.equal(credentialProxyVerified([ok], { ...context(), probeDigest: '0000000000000000' }), false, 'the probe on disk changed');
  assert.equal(credentialProxyVerified([ok], { ...context(), probeDigest: null }), false, 'unreadable probe');
  assert.match(currentProbeDigest(), /^[0-9a-f]{16}$/);
  // The pass of the old probe stays out of the way: only the current probe's records decide.
  const stale = { ...ok, tested_at: '2026-10-19T13:00:00Z', result: 'fail', probe_version: PROBE_VERSION - 1 };
  assert.equal(credentialProxyVerified([stale, ok], context()), true, 'a failure from another probe does not decide this one');
});

test('the flag needs a dated, well-formed, passing record, and unknown input is false', () => {
  const ok = record();
  for (const rows of [undefined, null, {}, [], [null], [{}], [{ ...ok, result: 'fail' }], [{ ...ok, result: 'inconclusive' }], [{ ...ok, result: 'passed' }],
    [{ ...ok, tested_at: '2026-10-21T00:00:00Z' }], [{ ...ok, tested_at: 'tomorrow' }], [{ ...ok, kind: 'boundary' }], [{ ...ok, schema: 2 }],
    [{ ...ok, label: 'trust-me' }], [{ ...ok, checks: ok.checks.filter((entry) => entry.id !== 'ssh-agent') }],
    [{ ...ok, checks: ok.checks.map((entry) => entry.id === 'mcp-gateway' ? { ...entry, found: true } : entry) }],
    [{ ...ok, checks: ok.checks.map((entry) => entry.id === 'env-secrets' ? { ...entry, found: null } : entry) }]])
    assert.equal(credentialProxyVerified(rows, context()), false, JSON.stringify(rows)?.slice(0, 80));
  for (const bad of [{ adapter: null }, { adapter: {} }, { adapter: { spec: {} } }, { now: NaN }, { faravanVersion: 7 }])
    assert.equal(credentialProxyVerified([ok], context('codex', bad)), false, JSON.stringify(Object.keys(bad)));
  assert.equal(credentialProxyVerified([ok], undefined), false);
});

test('the newest record for the same binding decides: a later failure takes the flag back', () => {
  const pass = record('codex', { tested_at: '2026-10-18T12:00:00Z' });
  const fail = record('codex', { tested_at: '2026-10-19T12:00:00Z', result: 'fail' });
  const inconclusive = record('codex', { tested_at: '2026-10-19T13:00:00Z', result: 'inconclusive' });
  const later = record('codex', { tested_at: '2026-10-19T14:00:00Z' });
  assert.equal(credentialProxyVerified([pass, fail], context()), false);
  assert.equal(credentialProxyVerified([fail, pass], context()), false, 'order in the file does not matter');
  assert.equal(credentialProxyVerified([pass, inconclusive], context()), false);
  assert.equal(credentialProxyVerified([pass, fail, later], context()), true, 'a newer pass restores it');
  assert.equal(credentialProxyVerified([pass, record('codex', { faravan_version: '9.9.9', result: 'fail', tested_at: '2026-10-20T00:00:00Z' })], context()), true,
    'a failure for another binding does not decide this one');
});

test('adapter version is a digest of the whole spec and ignores key order', () => {
  const codex = adapter('codex');
  const shuffled = { ...codex, spec: Object.fromEntries(Object.entries(codex.spec).reverse()) };
  assert.equal(adapterVersion(shuffled), adapterVersion(codex));
  assert.equal(new Set(HARNESS_ADAPTERS.map(adapterVersion)).size, HARNESS_ADAPTERS.length);
  for (const bad of [null, {}, { spec: null }, { spec: {} }]) assert.equal(adapterVersion(bad), null);
});

test('sbx and Faravan versions normalize strictly', () => {
  for (const [input, expected] of [[SBX, '0.48.0+5caf923e0587d376848f6f388eca3e0f5ca00e2d'], ['sbx version: v0.47.1', '0.47.1'], ['0.48.0', '0.48.0'],
    ['0.48.0+abcdef1234', '0.48.0+abcdef1234'], ['v1.2.3 deadbeef', '1.2.3+deadbeef'], ['0.48', null], ['', null], [undefined, null], ['0.48.0-rc1', null], ['unknown', null]])
    assert.equal(normalizeSbxVersion(input), expected, String(input));
});

test('Faravan version is the installed VERSION file; a source checkout has none', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'VERSION'), '0.3.1\n');
  assert.equal(readFaravanVersion(new URL('file://' + join(dir, 'VERSION'))), '0.3.1');
  await writeFile(join(dir, 'VERSION'), 'latest\n');
  assert.equal(readFaravanVersion(new URL('file://' + join(dir, 'VERSION'))), null);
  assert.equal(readFaravanVersion(new URL('file://' + join(dir, 'missing'))), null);
  assert.equal(readFaravanVersion(), null, 'this checkout has no VERSION file');
});

test('evidence records load from the shipped file and a missing or broken file means no evidence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'records.json');
  await writeFile(file, JSON.stringify([record()]));
  assert.equal((await loadEvidenceRecords(new URL('file://' + file))).length, 1);
  await writeFile(file, '{broken');
  assert.deepEqual(await loadEvidenceRecords(new URL('file://' + file)), []);
  await writeFile(file, '{}');
  assert.deepEqual(await loadEvidenceRecords(new URL('file://' + file)), []);
  assert.deepEqual(await loadEvidenceRecords(new URL('file://' + join(dir, 'absent.json'))), []);
  assert.ok(Array.isArray(await loadEvidenceRecords()), 'the shipped evidence file parses');
});

// ---- what counts as a secret --------------------------------------------------------------

test('the sandbox proxy placeholders are sentinels and look-alike words are not', () => {
  for (const value of ['proxy-managed', 'sk-ant-oat01-proxy-managed', 'sk-ant-ort01-proxy-managed', 'oai-oat01-proxy-managed', 'Bearer proxy-managed', 'gho_proxymanaged0000000000000000000000'])
    assert.equal(isSentinel(value), true, value);
  for (const value of [FAKE_ANTHROPIC, FAKE_JWT, FAKE_GITHUB, 'managed', 'proxy', 'abc123'])
    assert.equal(isSentinel(value), false, value);
});

test('real-token shapes are found and sentinels, empties and settings are not', () => {
  const kinds = (text) => scanText(text).map((item) => item.kind);
  assert.ok(kinds(`{"accessToken":"${FAKE_ANTHROPIC}"}`).includes('real'));
  assert.ok(kinds(`{"tokens":{"id_token":"${FAKE_JWT}"}}`).includes('real'));
  assert.ok(kinds(`token: ${FAKE_GITHUB}`).includes('real'));
  assert.ok(kinds('machine example.com login me password Hunter2Hunter2xyz').includes('real'), 'netrc');
  assert.ok(kinds('{"auths":{"https://index.docker.io/v1/":{"auth":"dXNlcjpBYmNkMTIzNDU2Nzg5MDEyMw=="}}}').includes('real'), 'docker config');
  assert.ok(kinds('-----BEGIN OPENSSH PRIVATE KEY-----').includes('real'));
  assert.deepEqual([...new Set(kinds('{"accessToken":"sk-ant-oat01-proxy-managed","refreshToken":"sk-ant-ort01-proxy-managed"}'))], ['sentinel']);
  assert.deepEqual([...new Set(kinds('{"OPENAI_API_KEY": "proxy-managed"}'))], ['sentinel']);
  assert.deepEqual([...new Set(kinds('{"accessToken":"","refreshToken":""}'))], ['empty']);
  // Settings and prose that only mention auth words.
  for (const text of ['requires_openai_auth = false', 'mcp_oauth_credentials_store = "file"', 'forced_login_method = "api"', 'the token expired, please sign in again',
    'jdk.http.auth.proxying.disabledSchemes=', 'jdk.security.krb5.default.initiate.credential=always-if-forwardable', 'password = self._password', 'token = get_token(request)',
    'SSH_AUTH_SOCK_GATEWAY=gateway.docker.internal:3129', 'authorization = ${TOKEN}', 'secret: none'])
    assert.deepEqual(kinds(text).filter((kind) => kind === 'real'), [], text);
});

test('source files only count for the unmistakable token formats', () => {
  assert.deepEqual(scanText('const password = "Correct7Horse9Battery";', { config: false }), []);
  assert.ok(scanText(`const key = "${FAKE_ANTHROPIC}";`, { config: false }).some((item) => item.kind === 'real'));
});

test('environment variables: secrets by shape or name are found; certificates, ids and ordinary settings are not', () => {
  const certificate = Buffer.from('-----BEGIN CERTIFICATE-----\n' + 'MIIBkTCB+wIJAKHBfpegPjMCMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnRlc3Rz'.repeat(4) + '\n-----END CERTIFICATE-----\n').toString('base64');
  const privateKey = Buffer.from('-----BEGIN PRIVATE KEY-----\n' + 'MIIBkTCB+wIJAKHBfpegPjMCMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnRlc3Rz'.repeat(4) + '\n-----END PRIVATE KEY-----\n').toString('base64');
  assert.equal(classifyEnv('ANTHROPIC_API_KEY', FAKE_ANTHROPIC)?.kind, 'real');
  assert.equal(classifyEnv('SOME_VAR', FAKE_JWT)?.kind, 'real');
  assert.equal(classifyEnv('DB_PASSWORD', 'Tr0ub4dor&3xyzzy99')?.kind, 'real');
  assert.equal(classifyEnv('BLOB', 'Kd82hs72Jd92kd82QpZm41XbVn03LsWe9RtYu5')?.kind, 'real', 'long and random');
  assert.equal(classifyEnv('CA', privateKey)?.kind, 'real');
  assert.equal(classifyEnv('PROXY_CA_CERT_B64', certificate), null, 'a public certificate');
  assert.equal(classifyEnv('GH_TOKEN', 'gho_proxymanaged0000000000000000000000')?.kind, 'sentinel');
  assert.equal(classifyEnv('MCP_SENTINEL_TOKEN_NAME', 'proxy-managed')?.kind, 'sentinel');
  for (const [name, value] of [['SANDBOX_ID', '0a1b2c3d-4e5f-6789-abcd-ef0123456789'], ['SSH_AUTH_SOCK', '/run/ssh-agent.sock'], ['SSH_AUTH_SOCK_GATEWAY', 'gateway.docker.internal:3129'],
    ['HTTPS_PROXY', 'http://gateway.docker.internal:3128'], ['SBX_CRED_OPENAI_MODE', 'oauth'], ['PATH', '/usr/local/bin:/usr/bin:/bin'], ['GIT_TERMINAL_PROMPT', '0'],
    ['JAVA_TOOL_OPTIONS', '-Dhttp.proxyHost=gateway.docker.internal -Dhttp.proxyPort=3128 -Dhttps.proxyHost=gateway.docker.internal'], ['HOME', '/home/agent']])
    assert.equal(classifyEnv(name, value), null, name);
  assert.equal(classifyValue(''), 'empty');
  assert.equal(classifyValue('proxy-managed'), 'sentinel');
});

test('the self test passes in this runtime and would fail if the classifier went blind', () => {
  assert.deepEqual(selfTest(), { canary_detected: true, sentinel_ignored: true });
});

test('known-secret hashes come from the lender files and never leave as values', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-host-creds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json');
  await writeFile(file, JSON.stringify({ tokens: { access_token: FAKE_JWT, refresh_token: 'Rq8Xw2Lp5Vb9Nk3Ys7Hd1Mc4Fj6Ga0Tz', plain: 'short' } }));
  const hashes = await hostCredentialHashes([file, join(dir, 'absent.json')]);
  assert.ok(hashes.includes(sha256(FAKE_JWT)));
  assert.ok(hashes.includes(sha256('Rq8Xw2Lp5Vb9Nk3Ys7Hd1Mc4Fj6Ga0Tz')));
  assert.ok(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  assert.ok(!JSON.stringify(hashes).includes(FAKE_JWT));
});

// ---- the probe against a planted sandbox ---------------------------------------------------

async function plantedSandbox(t, { files = {}, env = {}, mounts } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'faravan-probe-home-'));
  const proc = await mkdtemp(join(tmpdir(), 'faravan-probe-proc-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(proc, { recursive: true, force: true })]));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(home, name, '..'), { recursive: true });
    await writeFile(join(home, name), text);
  }
  const sandboxEnv = { HOME: home, WORKSPACE_DIR: join(home, 'workspace'), SBX_CRED_OPENAI_MODE: 'oauth', GH_TOKEN: 'gho_proxymanaged0000000000000000000000',
    HTTPS_PROXY: 'http://gateway.docker.internal:3128', ...env };
  const quietNetwork = [check('ssh-agent', false, 'no agent'), check('mcp-gateway', false, 'none'), check('link-local-metadata', false, 'refused')];
  return { home, env: sandboxEnv, run: (extra = {}) => runProbe({ env: sandboxEnv, home, provider: 'openai', roots: [[home, 4]], proc, escalate: false,
    networkChecks: quietNetwork, mountsText: mounts ?? `host ${join(home, 'workspace')} virtiofs rw 0 0\nbind-1 /etc/resolv.conf virtiofs rw 0 0\noverlay / overlay rw 0 0\n`, ...extra }) };
}
const SENTINEL_FILES = {
  '.codex/auth.json': '{"OPENAI_API_KEY": "proxy-managed"}',
  '.codex/config.toml': 'experimental_bearer_token = "oai-oat01-proxy-managed"\n[mcp_servers.x.http_headers]\nAuthorization = "Bearer proxy-managed"\n',
};
const byId = (report, id) => report.checks.find((entry) => entry.id === id);

test('probe: a sandbox holding only sentinels passes, and the report validates', async (t) => {
  const sandbox = await plantedSandbox(t, { files: SENTINEL_FILES });
  const report = await sandbox.run();
  assert.equal(report.verdict, 'pass', JSON.stringify(report.inconclusive_reasons));
  assert.equal(report.provider.mode, 'oauth');
  assert.ok(report.provider.sentinels >= 2);
  assert.equal(validateProbeReport(report).ok, true);
  for (const id of REQUIRED_CHECKS) assert.equal(byId(report, id)?.found, false, id);
  // The GitHub placeholder is spendable at GitHub hosts. It is reported, but it is not a readable secret.
  assert.equal(byId(report, 'foreign-credential-reach').found, true);
  assert.equal(byId(report, 'foreign-credential-reach').severity, 'medium');
  assert.match(byId(report, 'foreign-credential-reach').evidence_redacted, /GH_TOKEN\(github\)/);
});

test('probe: a real token in a credential file fails, in either agent\'s file, and is never printed', async (t) => {
  for (const [file, body] of [
    ['.claude/.credentials.json', `{"claudeAiOauth":{"accessToken":"${FAKE_ANTHROPIC}","refreshToken":"sk-ant-ort01-${'Lk4Mn8Pq2Rs6Tv0Wx'.repeat(3)}","expiresAt":4102444800000}}`],
    ['.codex/auth.json', `{"tokens":{"access_token":"${FAKE_JWT}","refresh_token":"rt-${'Xc3Vb7Nm1Lk5Jh9Gf'.repeat(3)}"}}`],
    ['.config/gh/hosts.yml', `github.com:\n  oauth_token: ${FAKE_GITHUB}\n`],
    ['.docker/config.json', '{"auths":{"https://index.docker.io/v1/":{"auth":"dXNlcjpBYmNkMTIzNDU2Nzg5MDEyMw=="}}}'],
    ['.netrc', 'machine github.com login me password Hunter2Hunter2xyz\n']]) {
    const sandbox = await plantedSandbox(t, { files: { ...SENTINEL_FILES, [file]: body } });
    const report = await sandbox.run();
    assert.equal(report.verdict, 'fail', file);
    assert.equal(byId(report, 'credential-files').found, true, file);
    assert.equal(byId(report, 'credential-files').severity, 'critical');
    const printed = JSON.stringify(report);
    for (const secret of [FAKE_ANTHROPIC, FAKE_JWT, FAKE_GITHUB, 'Hunter2Hunter2xyz', 'dXNlcjpBYmNkMTIzNDU2Nzg5MDEyMw'])
      assert.ok(!printed.includes(secret.slice(0, 12)), `evidence for ${file} leaked the start of a value`);
    assert.equal(validateProbeReport(report).ok, true, 'the redacted report is storable');
  }
});

test('probe: a real token in the environment, or a token the filesystem scan finds elsewhere, fails', async (t) => {
  const inEnv = await plantedSandbox(t, { files: SENTINEL_FILES, env: { ANTHROPIC_API_KEY: FAKE_ANTHROPIC } });
  const envReport = await inEnv.run();
  assert.equal(envReport.verdict, 'fail');
  assert.equal(byId(envReport, 'env-secrets').found, true);
  assert.match(byId(envReport, 'env-secrets').evidence_redacted, /ANTHROPIC_API_KEY\(\d+,[0-9a-f]{4}\)/);
  assert.ok(!JSON.stringify(envReport).includes(FAKE_ANTHROPIC.slice(0, 16)));
  const hidden = await plantedSandbox(t, { files: { ...SENTINEL_FILES, 'project/deploy.env': `API_TOKEN=${FAKE_GITHUB}\n`, 'project/notes.md': `see ${FAKE_JWT}` } });
  const fsReport = await hidden.run();
  assert.equal(fsReport.verdict, 'fail');
  assert.equal(byId(fsReport, 'filesystem-token-scan').found, true);
  assert.equal(byId(fsReport, 'sentinel-status').found, true);
});

test('probe: a token on another process\'s environment or command line fails', async (t) => {
  const sandbox = await plantedSandbox(t, { files: SENTINEL_FILES });
  const proc = await mkdtemp(join(tmpdir(), 'faravan-probe-fakeproc-'));
  t.after(() => rm(proc, { recursive: true, force: true }));
  await mkdir(join(proc, '4242'));
  await writeFile(join(proc, '4242', 'environ'), `PATH=/bin\0DEPLOY_TOKEN=${FAKE_GITHUB}\0`);
  await writeFile(join(proc, '4242', 'cmdline'), 'tool\0--auth\0' + FAKE_JWT + '\0');
  const report = await sandbox.run({ proc });
  assert.equal(report.verdict, 'fail');
  assert.equal(byId(report, 'process-environ').found, true);
  assert.match(byId(report, 'process-environ').evidence_redacted, /pid4242/);
  assert.ok(!JSON.stringify(report).includes(FAKE_GITHUB.slice(0, 10)));
});

test('probe: a hash of the lender\'s real credential found anywhere in the sandbox fails, even under another name', async (t) => {
  const hostSecret = 'Rq8Xw2Lp5Vb9Nk3Ys7Hd1Mc4Fj6Ga0TzUe2Io';
  const sandbox = await plantedSandbox(t, { files: { ...SENTINEL_FILES, 'project/blob.txt': `data ${hostSecret} data` } });
  const report = await sandbox.run({ knownHashes: [sha256(hostSecret)] });
  assert.equal(report.verdict, 'fail');
  assert.equal(byId(report, 'known-secret-match').found, true);
  assert.equal(report.known_hashes_checked, 1);
  assert.ok(!JSON.stringify(report).includes(hostSecret.slice(0, 10)));
  const clean = await plantedSandbox(t, { files: SENTINEL_FILES });
  assert.equal(byId(await clean.run({ knownHashes: [sha256(hostSecret)] }), 'known-secret-match').found, false);
});

test('probe: a host directory mounted into the sandbox fails', async (t) => {
  const sandbox = await plantedSandbox(t, { files: SENTINEL_FILES });
  const workspace = join(sandbox.home, 'workspace');
  const report = await sandbox.run({ mountsText: `host ${workspace} virtiofs rw 0 0\nhost /home/lender virtiofs rw 0 0\nhost /mnt/keys 9p rw 0 0\n` });
  assert.equal(report.verdict, 'fail');
  assert.match(byId(report, 'host-mounts').evidence_redacted, /virtiofs:\/home\/lender/);
  assert.match(byId(report, 'host-mounts').evidence_redacted, /9p:\/mnt\/keys/);
  assert.equal(byId(await sandbox.run({ mountsText: null }), 'host-mounts').found, null);
});

test('probe: the lender runtime mount passes only when it is named and read-only', async (t) => {
  const sandbox = await plantedSandbox(t, { files: SENTINEL_FILES });
  const workspace = join(sandbox.home, 'workspace');
  const runtime = '/lender/.fsbx/home/guest-runtime/abc123';
  const mounts = (options) => `host ${workspace} virtiofs rw 0 0\nhost ${runtime} virtiofs ${options} 0 0\n`;
  const named = await sandbox.run({ mountsText: mounts('ro,relatime'), readOnlyMount: runtime });
  assert.equal(byId(named, 'host-mounts').found, false);
  assert.match(byId(named, 'host-mounts').evidence_redacted, /read-only runtime/);
  // The same mount without the lender naming it is still a host directory in the job.
  assert.equal(byId(await sandbox.run({ mountsText: mounts('ro,relatime') }), 'host-mounts').found, true);
  // A writable mount at the runtime path is not the runtime the lender installed.
  const writable = await sandbox.run({ mountsText: mounts('rw,relatime'), readOnlyMount: runtime });
  assert.equal(byId(writable, 'host-mounts').found, true);
  assert.equal(writable.verdict, 'fail');
  // Naming the runtime never excuses a different host directory.
  const other = await sandbox.run({ mountsText: mounts('ro') + 'host /home/lender virtiofs ro 0 0\n', readOnlyMount: runtime });
  assert.match(byId(other, 'host-mounts').evidence_redacted, /virtiofs:\/home\/lender/);
  assert.doesNotMatch(byId(other, 'host-mounts').evidence_redacted, /abc123/);
});

test('probe: not signed in gives inconclusive, not a pass; a sandbox that cannot show a sentinel is inconclusive too', async (t) => {
  const unsigned = await plantedSandbox(t, { files: SENTINEL_FILES, env: { SBX_CRED_OPENAI_MODE: 'none' } });
  const report = await unsigned.run();
  assert.equal(report.verdict, 'inconclusive');
  assert.deepEqual(report.inconclusive_reasons, ['provider_not_signed_in']);
  const modeMissing = await plantedSandbox(t, { files: SENTINEL_FILES });
  delete modeMissing.env.SBX_CRED_OPENAI_MODE;
  assert.deepEqual((await modeMissing.run()).inconclusive_reasons, ['provider_not_signed_in']);
  const empty = await plantedSandbox(t, { env: { GH_TOKEN: '' } });
  assert.deepEqual((await empty.run()).inconclusive_reasons, ['no_sentinel_observed']);
});

test('probe: a real token beats "not signed in"', async (t) => {
  const sandbox = await plantedSandbox(t, { files: { '.claude/.credentials.json': `{"claudeAiOauth":{"accessToken":"${FAKE_ANTHROPIC}"}}` }, env: { SBX_CRED_OPENAI_MODE: 'none' } });
  assert.equal((await sandbox.run()).verdict, 'fail');
});

test('probe: skipped network checks are inconclusive, never a pass', async (t) => {
  const sandbox = await plantedSandbox(t, { files: SENTINEL_FILES });
  const report = await sandbox.run({ networkChecks: undefined, network: false });
  assert.equal(report.verdict, 'inconclusive');
  assert.deepEqual(report.inconclusive_reasons.sort(), ['check_unavailable:link-local-metadata', 'check_unavailable:mcp-gateway', 'check_unavailable:ssh-agent']);
});

const claudeFile = (expiresAt, access = 'sk-ant-oat01-proxy-managed', refresh = 'sk-ant-ort01-proxy-managed') =>
  ({ '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt } }) });

test('probe: Claude reports mode "none" even when signed in, so its credentials file decides: placeholders with a live expiry pass', async (t) => {
  const bound = await plantedSandbox(t, { files: claudeFile(4102444800000), env: { SBX_CRED_ANTHROPIC_MODE: 'none' } });
  const report = await bound.run({ provider: 'anthropic' });
  assert.equal(report.provider.mode, 'none');
  assert.equal(report.provider.credential_expiry, 'future');
  assert.equal(report.provider.credential_file_bound, true);
  assert.equal(report.verdict, 'pass', JSON.stringify(report.inconclusive_reasons));
  assert.equal(validateProbeReport(report).ok, true);
});

test('probe: Claude with no live sign-in is inconclusive, never a pass', async (t) => {
  for (const [label, files] of [['expiry 0', claudeFile(0)], ['expired', claudeFile(1000)], ['empty tokens', claudeFile(4102444800000, '', '')],
    ['one token empty', claudeFile(4102444800000, 'sk-ant-oat01-proxy-managed', '')], ['no file', {}]]) {
    const sandbox = await plantedSandbox(t, { files, env: { SBX_CRED_ANTHROPIC_MODE: 'none' } });
    const report = await sandbox.run({ provider: 'anthropic' });
    assert.equal(report.verdict, 'inconclusive', label);
    assert.deepEqual(report.inconclusive_reasons.filter((reason) => reason === 'provider_not_signed_in'), ['provider_not_signed_in'], label);
  }
  const forged = await plantedSandbox(t, { files: claudeFile(4102444800000, FAKE_ANTHROPIC, 'sk-ant-ort01-proxy-managed'), env: { SBX_CRED_ANTHROPIC_MODE: 'none' } });
  assert.equal((await forged.run({ provider: 'anthropic' })).verdict, 'fail', 'a real access token beats a live expiry');
});

// ---- the probe's own rules ----------------------------------------------------------------

test('the probe source never names a provider host and has no outbound client beyond the sandbox gateway', async () => {
  const source = await readFile(new URL('../lib/v1/credential-probe-guest.mjs', import.meta.url), 'utf8');
  for (const host of ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com', 'api.openai.com', 'auth.openai.com', 'chatgpt.com', 'generativelanguage.googleapis.com', 'github.com'])
    assert.ok(!source.includes(host), 'probe must not contact ' + host);
  assert.ok(!/\bfetch\s*\(/.test(source) && !/node:https|node:dns|node:tls/.test(source));
  assert.ok(!/console\.(log|error)\s*\(/.test(source), 'the only output is the marked report');
  const imports = [...source.matchAll(/from '(node:[a-z_:/]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['node:child_process', 'node:crypto', 'node:fs', 'node:http', 'node:net', 'node:os', 'node:path', 'node:url'], 'built-ins only');
});

test('the shipped evidence file never claims a verified adapter for a source checkout', async () => {
  const records = await loadEvidenceRecords();
  for (const id of MVP) assert.equal(credentialProxyVerified(records, { adapter: adapter(id), faravanVersion: readFaravanVersion(), sbxVersion: SBX, now: NOW }), false);
  for (const entry of records) {
    assert.equal(entry.kind, 'credential_proxy');
    assert.ok(['internal', 'independent'].includes(entry.label));
    assert.ok(!JSON.stringify(entry).match(/sk-ant|eyJ|ghp_|gho_/));
  }
});

// ---- the one known signed artifact the Claude CLI writes in the guest ------------------------------------

const scanChecks = async (home, extra = {}) => {
  const report = await runProbe({ home, roots: [[home, 5]], network: false, escalate: false, mountsText: '', proc: '/nonexistent', env: {}, ...extra });
  const byId = Object.fromEntries(report.checks.map((entry) => [entry.id, entry]));
  return { report, scan: byId['filesystem-token-scan'], status: byId['sentinel-status'], known: byId['known-secret-match'] };
};
const withHome = async (t) => { const home = await mkdtemp(join(tmpdir(), 'spk-sig-')); t.after(() => rm(home, { recursive: true, force: true })); return home; };
const b64u = (text) => Buffer.from(text).toString('base64url');
const syntheticHeaderText = (tail) => JSON.stringify(syntheticHeader()).replace(/\}$/, tail + '}');
const REAL_LOOKING = 'sk-ant-oat01-' + 'Zq7Tn4Xw1Lp8Vb3Rk9Ys2Hd6Mc5Fj0Ga'.repeat(2);

test('the exact policy-limits signature file the CLI writes is not a finding', async (t) => {
  const home = await withHome(t);
  await writeSignatureFile(home);
  assert.equal(scanText(syntheticSignatureFile()).some((item) => item.kind === 'real'), true, 'the scanner alone would flag it: that is the false positive');
  const { scan, status } = await scanChecks(home);
  assert.equal(scan.found, false, scan.evidence_redacted);
  assert.equal(status.found, false, status.evidence_redacted);
  assert.match(scan.evidence_redacted, /signed policy artifact recognized: 1/);
  assert.ok(!scan.evidence_redacted.includes(syntheticJws()), 'the evidence never carries the value');
});

test('the policy-limits signature file is allowed only in its exact shape and place', async (t) => {
  const home = await withHome(t);
  const ok = syntheticSignatureFile();
  const jws = syntheticJws();
  const cases = {
    'a token in an extra field of that file': ok.replace('}', `,"note":"${REAL_LOOKING}"}`),
    'a token in a field with another name': `{"jws":"${jws}","receivedAt":1790000000123,"accessToken":"${REAL_LOOKING}"}`,
    'the signature under another field name': ok.replace('"jws"', '"signature"'),
    'a duplicate key that hides a token behind the valid value': `{"jws":"${REAL_LOOKING}","jws":"${jws}","receivedAt":1790000000123}`,
    'a duplicate key with the token last': `{"jws":"${jws}","receivedAt":1790000000123,"jws":"${REAL_LOOKING}"}`,
    'a token as the receivedAt value': `{"jws":"${jws}","receivedAt":"${REAL_LOOKING}"}`,
    'a token in the header kid': syntheticSignatureFile({ jws: syntheticJws({ header: syntheticHeader({ kid: REAL_LOOKING }) }) }),
    'a token in the payload': syntheticSignatureFile({ jws: syntheticJws({ payload: syntheticPayload({ sub: REAL_LOOKING }) }) }),
    'an extra header key': syntheticSignatureFile({ jws: syntheticJws({ header: syntheticHeader({ extra: 'x' }) }) }),
    'an extra payload key': syntheticSignatureFile({ jws: syntheticJws({ payload: syntheticPayload({ extra: 'x' }) }) }),
    'a payload key of the wrong type': syntheticSignatureFile({ jws: syntheticJws({ payload: syntheticPayload({ exp: 'soon' }) }) }),
    'a header without a certificate chain': syntheticSignatureFile({ jws: syntheticJws({ header: { alg: 'ES256', typ: 'JWT', kid: 'k', x5c: [] } }) }),
    'a certificate chain that is not certificates': syntheticSignatureFile({ jws: syntheticJws({ header: syntheticHeader({ x5c: ['QUJD'.repeat(100)] }) }) }),
    'a certificate chain that is not an array': syntheticSignatureFile({ jws: syntheticJws({ header: syntheticHeader({ x5c: SYNTHETIC_CERTIFICATE }) }) }),
    'a duplicate header key hiding a token': syntheticSignatureFile({ jws: [b64u(syntheticHeaderText(`,"kid":"${REAL_LOOKING}"`)), jws.split('.')[1], 'A'.repeat(86)].join('.') }),
    'a duplicate payload key hiding a token': syntheticSignatureFile({ jws: [jws.split('.')[0], b64u(JSON.stringify(syntheticPayload()).replace('}', `,"sub":"${REAL_LOOKING}"}`)), 'A'.repeat(86)].join('.') }),
    'a header with a private key in the chain': syntheticSignatureFile({ jws: syntheticJws({ header: syntheticHeader({ x5c: [Buffer.from('-----BEGIN PRIVATE KEY-----' + 'A'.repeat(300)).toString('base64')] }) }) }),
    'a signature of another length': syntheticSignatureFile({ jws: syntheticJws({ signature: 'A'.repeat(200) }) }),
    'two segments only': syntheticSignatureFile({ jws: jws.split('.').slice(0, 2).join('.') }),
    'four segments': syntheticSignatureFile({ jws: jws + '.' + 'A'.repeat(20) }),
    'a payload that is not JSON': syntheticSignatureFile({ jws: [jws.split('.')[0], Buffer.from('not json at all').toString('base64url'), 'A'.repeat(86)].join('.') }),
    'pretty-printed JSON': JSON.stringify(JSON.parse(ok), null, 2),
    'text after the object': ok + '\n' + REAL_LOOKING,
    'not JSON': jws,
    'a non-numeric timestamp': ok.replace(/\d{13}\}$/, 'x}'),
  };
  for (const [name, text] of Object.entries(cases)) {
    await rm(join(home, '.claude'), { recursive: true, force: true });
    await writeSignatureFile(home, text);
    const { scan, status } = await scanChecks(home);
    assert.equal(scan.found, true, `${name}: filesystem-token-scan must fail`);
    assert.equal(status.found, true, `${name}: sentinel-status must fail`);
    assert.doesNotMatch(scan.evidence_redacted, /recognized: [1-9]/, name);
  }
  // Right content, wrong place or name: never allowed.
  for (const [name, dir, file] of [['another file name', '.claude', 'policy-limits.json'], ['another directory', '.config', 'policy-limits.json.signature.json'],
    ['a nested directory', '.claude/cache', 'policy-limits.json.signature.json'], ['a workspace copy', 'workspace', 'policy-limits.json.signature.json'],
    ['a look-alike name', '.claude', 'policy-limits.json.signature.json.bak']]) {
    await rm(join(home, '.claude'), { recursive: true, force: true });
    await rm(join(home, dir), { recursive: true, force: true });
    await writeSignatureFile(home, ok, file, dir);
    const { scan } = await scanChecks(home);
    assert.equal(scan.found, true, name);
  }
});

test('a valid signature file does not excuse a token anywhere else, and the same value elsewhere is still a finding', async (t) => {
  const home = await withHome(t);
  await writeSignatureFile(home);
  await mkdir(join(home, 'notes'), { recursive: true });
  await writeFile(join(home, 'notes', 'a.json'), `{"accessToken":"${REAL_LOOKING}"}`);
  assert.equal((await scanChecks(home)).scan.found, true, 'a token in another file');
  await rm(join(home, 'notes'), { recursive: true });
  await writeFile(join(home, 'copy.json'), syntheticSignatureFile());
  assert.equal((await scanChecks(home)).scan.found, true, 'the same JWS in a file with another name');
  await rm(join(home, 'copy.json'));
  assert.equal((await scanChecks(home)).scan.found, false, 'back to only the exact file');
});

test('the known-secret comparison still sees the original text of the allowed file', async (t) => {
  const home = await withHome(t);
  await writeSignatureFile(home);
  const { known } = await scanChecks(home, { knownHashes: [sha256(syntheticJws())] });
  assert.equal(known.found, true, 'a host credential equal to the allowed value is still caught');
  const other = await scanChecks(home, { knownHashes: [sha256('some-other-host-value-0123456789')] });
  assert.equal(other.known.found, false);
});

test('the allowed file may sit in another user\'s home or root\'s, as the root run of the probe sees it', async (t) => {
  const { classifySignatureFile } = await import('../lib/v1/credential-probe-guest.mjs');
  const text = syntheticSignatureFile();
  for (const file of ['/home/agent/.claude/policy-limits.json.signature.json', '/root/.claude/policy-limits.json.signature.json'])
    assert.equal(classifySignatureFile(file, text, '/somewhere/else').ok, true, file);
  for (const file of ['/home/agent/x/.claude/policy-limits.json.signature.json', '/workspace/.claude/policy-limits.json.signature.json', '/tmp/.claude/policy-limits.json.signature.json'])
    assert.equal(classifySignatureFile(file, text, '/home/agent').ok, false, file);
  assert.equal(classifySignatureFile('/home/agent/.claude/policy-limits.json.signature.json', text + ' ', '/home/agent').ok, false);
  assert.match(classifySignatureFile('/home/agent/.claude/policy-limits.json.signature.json', 'x', '/home/agent').reason, /^[a-z_]+$/, 'a rejection is a fixed code');
});

test('a token-shaped signature is never hidden by the policy artifact exception', async (t) => {
  const home = await withHome(t);
  const signature = ('sk-ant-oat01-' + 'Zq7Tn4Xw1Lp8Vb3Rk9Ys2Hd6Mc5Fj0Ga'.repeat(3)).slice(0, 86);
  assert.equal(scanText(signature).some(item => item.kind === 'real'), true);
  await writeSignatureFile(home, syntheticSignatureFile({ jws: syntheticJws({ signature }) }));
  const { scan, status } = await scanChecks(home);
  assert.equal(scan.found, true, 'the outer JWS exemption must preserve the inner token finding');
  assert.equal(status.found, true);
});

test('known-secret comparison includes each segment of an allowed policy artifact', async (t) => {
  const home = await withHome(t);
  await writeSignatureFile(home);
  for (const segment of syntheticJws().split('.')) {
    const { known } = await scanChecks(home, { knownHashes: [sha256(segment)] });
    assert.equal(known.found, true, 'known bytes in any JWS segment stay visible');
  }
});

for (const [field, makeBase, index] of [['kid', syntheticHeader, 0], ['sub', syntheticPayload, 1]]) {
  test('raw ' + field + ' token matches cannot hide behind decoded JSON', async (t) => {
    const home = await withHome(t);
    // Made-up bytes whose base64url spelling includes a token prefix. Invalid UTF-8
    // becomes replacement characters when decoded, which still form valid JSON strings.
    const bytes = Buffer.from('b24f9a9edf8e237d44f1d1b9fe745bcfaead2b2640', 'hex');
    const [before, after] = JSON.stringify({ ...makeBase(), [field]: '@@' }).split('@@');
    const padding = 'x'.repeat((3 - Buffer.byteLength(before) % 3) % 3);
    const segment = Buffer.concat([Buffer.from(before + padding), bytes, Buffer.from(after)]).toString('base64url');
    assert.doesNotThrow(() => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')));
    assert.equal(scanText(segment).some(item => item.kind === 'real'), true, 'raw fixture must match an existing heuristic');
    const parts = syntheticJws().split('.'); parts[index] = segment;
    await writeSignatureFile(home, syntheticSignatureFile({ jws: parts.join('.') }));
    const { scan, status } = await scanChecks(home);
    assert.equal(scan.found, true, field + ' raw match must remain a finding');
    assert.equal(status.found, true);
  });
}

test('per-job scan excludes the submitted workspace without excluding a sibling secret',async t=>{
  const sandbox=await plantedSandbox(t,{files:{...SENTINEL_FILES,'workspace/README.md':'GITHUB_TOKEN='+FAKE_GITHUB}});
  const options={workspace:join(sandbox.home,'workspace')};
  const clean=await sandbox.run(options);
  assert.equal(clean.verdict,'pass');
  await writeFile(join(sandbox.home,'outside.md'),'GITHUB_TOKEN='+FAKE_GITHUB);
  const exposed=await sandbox.run(options);
  assert.equal(byId(exposed,'filesystem-token-scan').found,true);
  assert.equal(exposed.verdict,'fail');
});

test('an exhausted filesystem root is inconclusive and cannot starve a later root',async t=>{
  const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
  const first=join(sandbox.home,'large'),last=join(sandbox.home,'later');
  await mkdir(first);await mkdir(last);
  for(let i=0;i<6001;i++)await writeFile(join(first,String(i)+'.md'),'ordinary project text');
  const options={roots:[[first,0],[last,0]]};
  let began=performance.now();
  const exhausted=await sandbox.run(options);
  t.diagnostic('credential scan, 6001 files: '+(performance.now()-began).toFixed(1)+' ms');
  assert.equal(byId(exhausted,'filesystem-token-scan').found,null);
  assert.equal(exhausted.verdict,'inconclusive');
  began=performance.now();
  assert.equal((await sandbox.run({roots:[[sandbox.home,4]],workspace:first})).verdict,'pass');
  t.diagnostic('credential scan, 6001 excluded workspace files: '+(performance.now()-began).toFixed(1)+' ms');
  await writeFile(join(last,'sign-in.txt'),'GITHUB_TOKEN='+FAKE_GITHUB);
  const exposed=await sandbox.run(options);
  assert.equal(byId(exposed,'filesystem-token-scan').found,true);
  assert.equal(exposed.verdict,'fail');
});

test('without owner hashes, the known-secret check says it is unavailable',async t=>{
  const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
  const report=await sandbox.run();
  assert.equal(report.known_hashes_checked,0);
  assert.equal(byId(report,'known-secret-match').found,null);
});

test('workspace aliases are excluded, and the privileged subprocess receives the same exclusion',async t=>{
 const sandbox=await plantedSandbox(t,{files:{...SENTINEL_FILES,'workspace/README.md':'GITHUB_TOKEN='+FAKE_GITHUB}});
 const workspace=join(sandbox.home,'workspace'),alias=join(sandbox.home,'alias');
 await symlink(workspace,alias);
 assert.equal((await sandbox.run({roots:[[alias,1]],workspace})).verdict,'inconclusive');
 const rootReport=await sandbox.run({workspace});
 const bin=join(sandbox.home,'bin'),capture=join(sandbox.home,'sudo-args.json');await mkdir(bin);
 // This executable replaces sudo; no privileged process or real root scan runs.
 const fake=join(bin,'sudo');
 await writeFile(fake,'#!'+process.execPath+'\nconst fs=require("node:fs");const args=process.argv.slice(2);if(args[1]==="true")process.exit(0);fs.writeFileSync('+JSON.stringify(capture)+',JSON.stringify(args));process.stdout.write('+JSON.stringify(MARKER+JSON.stringify(rootReport)+'\n')+');\n');
 await chmod(fake,0o755);
 const report=await sandbox.run({workspace,escalate:true,sudoCandidates:[fake]});
 assert.equal(report.verdict,'pass');
 const args=JSON.parse(await readFile(capture,'utf8')),at=args.indexOf('--exclude-workspace');
 assert.ok(at>=0);assert.equal(args[at+1],workspace);
});

import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
for(const role of ['user','root'])for(const operation of ['readdirSync','lstatSync','openSync','readSync'])test('filesystem '+operation+' I/O failure is unavailable as '+role,async t=>{
 const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
 const scanRoot=join(sandbox.home,'scan'),file=join(scanRoot,'sign-in.md');await mkdir(scanRoot);await writeFile(file,'ordinary text');
 const original=fs[operation],open=fs.openSync;let scanFd;
 if(operation==='readSync')t.mock.method(fs,'openSync',(...args)=>{const fd=open(...args);if(args[0]===file)scanFd=fd;return fd;});
 t.mock.method(fs,operation,(...args)=>{
  if(operation==='readdirSync'?args[0]===scanRoot:operation==='readSync'?args[0]===scanFd:args[0]===file)throw Object.assign(new Error('synthetic I/O failure'),{code:'EIO'});
  return original(...args);
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const report=await sandbox.run({role,roots:[[scanRoot,1]]});
 assert.equal(byId(report,'filesystem-token-scan').found,null);
 assert.equal(report.verdict,'inconclusive');
});

// The user run cannot read some sandbox paths; the root run can. Fake sudo replays a root report; no privileged process runs.
async function escalatedRun(t, sandbox, rootReport) {
 const bin=join(sandbox.home,'bin'),capture=join(sandbox.home,'sudo-args.json');await mkdir(bin);
 const fake=join(bin,'sudo');
 await writeFile(fake,'#!'+process.execPath+'\nconst fs=require("node:fs");const args=process.argv.slice(2);if(args[1]==="true")process.exit(0);fs.writeFileSync('+JSON.stringify(capture)+',JSON.stringify(args));process.stdout.write('+JSON.stringify(MARKER+JSON.stringify(rootReport)+'\n')+');\n');
 await chmod(fake,0o755);
 const locked=join(sandbox.home,'locked');await mkdir(locked);
 const original=fs.readdirSync;
 t.mock.method(fs,'readdirSync',(...args)=>{if(args[0]===locked)throw Object.assign(new Error('synthetic permission denial'),{code:'EACCES'});return original(...args);});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const report=await sandbox.run({escalate:true,sudoCandidates:[fake]});
 return {report,fake,args:JSON.parse(await readFile(capture,'utf8'))};
}
const withScan=(report,found)=>({...report,checks:report.checks.map(entry=>entry.id==='filesystem-token-scan'?{...entry,found}:entry)});

test('a clean root scan settles a user scan stopped by unreadable paths, and root receives the user roots',async t=>{
 const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
 const {report,args}=await escalatedRun(t,sandbox,await sandbox.run());
 assert.equal(byId(report,'filesystem-token-scan').found,false);
 assert.match(byId(report,'filesystem-token-scan').evidence_redacted,/user: .*filesystem observation failed \| root: /);
 assert.equal(report.verdict,'pass',JSON.stringify(report.inconclusive_reasons));
 const at=args.indexOf('--user-roots');
 assert.ok(at>=0);
 assert.deepEqual(JSON.parse(Buffer.from(args[at+1],'base64').toString()),[[sandbox.home,4]]);
 // Relative or repeated roots reach root resolved and once, so the root run accepts them.
 await sandbox.run({escalate:true,roots:[['.',1],['.',1]],sudoCandidates:[join(sandbox.home,'bin','sudo')]});
 const again=JSON.parse(await readFile(join(sandbox.home,'sudo-args.json'),'utf8'));
 assert.deepEqual(JSON.parse(Buffer.from(again[again.indexOf('--user-roots')+1],'base64').toString()),[[process.cwd(),1]]);
});

test('a credential the job user can read still fails when part of its folder is unreadable and root reports clean',async t=>{
 // The locked folder and the readable sign-in share one parent, so the user scan is incomplete and also finds the token.
 const sandbox=await plantedSandbox(t,{files:{...SENTINEL_FILES,'locked/../notes/sign-in.txt':'GITHUB_TOKEN='+FAKE_GITHUB}});
 const clean=await plantedSandbox(t,{files:SENTINEL_FILES});
 const {report}=await escalatedRun(t,sandbox,await clean.run());
 const scan=byId(report,'filesystem-token-scan');
 assert.equal(scan.found,true);
 assert.match(scan.evidence_redacted,/filesystem observation failed/);
 assert.equal(report.verdict,'fail');
});

test('the root run scans the user roots it receives',async t=>{
 const sandbox=await plantedSandbox(t,{files:{...SENTINEL_FILES,'user-only/sign-in.txt':'GITHUB_TOKEN='+FAKE_GITHUB}});
 const empty=join(sandbox.home,'empty');await mkdir(empty);
 const own={role:'root',roots:[[empty,1]]};
 assert.equal(byId(await sandbox.run(own),'filesystem-token-scan').found,false);
 const covered=await sandbox.run({...own,userRoots:[[join(sandbox.home,'user-only'),3]]});
 assert.equal(byId(covered,'filesystem-token-scan').found,true);
 assert.equal(covered.verdict,'fail');
});

test('a sudo earlier on PATH is never run, so it cannot report a clean root scan',async t=>{
 const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
 const bin=join(sandbox.home,'bin'),capture=join(sandbox.home,'sudo-args.json');await mkdir(bin);
 // A clean root report would settle the user scan below, if this program were run.
 await writeFile(join(bin,'sudo'),'#!'+process.execPath+'\nrequire("node:fs").writeFileSync('+JSON.stringify(capture)+',"ran");process.stdout.write('+JSON.stringify(MARKER+JSON.stringify(await sandbox.run())+'\n')+');\n');
 await chmod(join(bin,'sudo'),0o755);
 const previous=process.env.PATH;t.after(()=>{process.env.PATH=previous;});process.env.PATH=bin+':'+previous;
 const locked=join(sandbox.home,'locked');await mkdir(locked);
 const original=fs.readdirSync;
 t.mock.method(fs,'readdirSync',(...args)=>{if(args[0]===locked)throw Object.assign(new Error('synthetic permission denial'),{code:'EACCES'});return original(...args);});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 // The system location is missing here, so no privileged run happens at all.
 const report=await sandbox.run({escalate:true,sudoCandidates:[join(sandbox.home,'system','sudo')]});
 await assert.rejects(readFile(capture,'utf8'),{code:'ENOENT'});
 assert.match(byId(report,'guest-privilege').evidence_redacted,/passwordless sudo not available/);
 assert.equal(byId(report,'filesystem-token-scan').found,null);
 assert.equal(report.verdict,'inconclusive');
 assert.ok(SUDO_CANDIDATES.every(candidate=>candidate.startsWith('/')&&!candidate.startsWith(bin)));
});

test('an incomplete root scan leaves an incomplete user scan unavailable',async t=>{
 const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
 const {report}=await escalatedRun(t,sandbox,withScan(await sandbox.run(),null));
 assert.equal(byId(report,'filesystem-token-scan').found,null);
 assert.equal(report.verdict,'inconclusive');
});

test('a token only the root scan reads still fails the probe',async t=>{
 const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
 const root=withScan(await sandbox.run(),true);
 const {report}=await escalatedRun(t,sandbox,{...root,checks:root.checks.map(entry=>entry.id==='filesystem-token-scan'?{...entry,severity:'critical'}:entry)});
 assert.equal(byId(report,'filesystem-token-scan').found,true);
 assert.equal(report.verdict,'fail');
});

import {spawnSync} from 'node:child_process';
test('the root run refuses a malformed user root list without a report',()=>{
 const guest=new URL('../lib/v1/credential-probe-guest.mjs',import.meta.url).pathname;
 for(const roots of ['not base64 json',Buffer.from('[["relative",1]]').toString('base64'),Buffer.from('[["/tmp",-1]]').toString('base64'),Buffer.from('{"a":1}').toString('base64')]){
  const run=spawnSync(process.execPath,[guest,'--role','root','--home','/nonexistent-probe-home','--no-network','--user-roots',roots],{encoding:'utf8',timeout:30000});
  assert.equal(run.status,2,roots);
  assert.equal(run.stdout.includes(MARKER),false,roots);
 }
});

test('a genuinely absent scan root stays clear',async t=>{
 const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
 assert.equal(byId(await sandbox.run({roots:[[join(sandbox.home,'absent'),1]]}),'filesystem-token-scan').found,false);
});

test('workspace cannot contain scan roots or protected sign-in paths',async t=>{
 const sandbox=await plantedSandbox(t,{files:SENTINEL_FILES});
 const protectedDir=join(sandbox.home,'.codex'),alias=join(sandbox.home,'home-alias');await symlink(sandbox.home,alias);
 for(const workspace of ['/',sandbox.home,alias,protectedDir,'/root','/etc']){
  const report=await sandbox.run({workspace});
  assert.equal(report.verdict,'inconclusive',workspace);
  assert.equal(byId(report,'filesystem-token-scan').found,null,workspace);
 }
});
