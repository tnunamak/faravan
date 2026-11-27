// A passing S5.2 probe report and the evidence record built from it. Test data only.
import { buildEvidenceRecord, currentProbeDigest, REQUIRED_CHECKS, PROBE_VERSION } from '../../lib/v1/credential-probe.mjs';

export const SBX_VERSION = 'sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d';
export const check = (id, found = false, evidence = 'ok', severity = found ? 'critical' : 'none') =>
  ({ id, found, evidence_redacted: evidence, severity });
export const passingChecks = () => [...REQUIRED_CHECKS.map((id) => check(id)), check('known-secret-match'), check('guest-privilege', true, 'sudo', 'info')];
export const passingReport = (overrides = {}) => ({
  probe_version: PROBE_VERSION, role: 'user', verdict: 'pass', inconclusive_reasons: [],
  provider: { service: 'openai', mode_variable: 'SBX_CRED_OPENAI_MODE', mode: 'oauth', sentinels: 6, empty_values: 0 },
  self_test: { canary_detected: true, sentinel_ignored: true }, known_hashes_checked: 3, node: 'v22.0.0',
  checks: passingChecks(), ...overrides,
});
export const passingRecord = (adapter, { faravanVersion = '0.1.0', sbxVersion = SBX_VERSION, testedAt = '2026-10-19T12:00:00Z', ...rest } = {}) =>
  ({ ...buildEvidenceRecord({ report: passingReport(), adapter, faravanVersion, sbxVersion, testedAt, probeDigest: currentProbeDigest() }), ...rest });
