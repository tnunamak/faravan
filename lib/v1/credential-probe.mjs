// Host side of the credential-proxy test (BUILD-PLAN S5.2, decision T14).
//
// The probe (credential-probe-guest.mjs) runs inside a job sandbox and prints one JSON report. This
// module checks that report, turns it into an evidence record bound to the exact adapter, Faravan and
// sbx versions, and answers one question for the safety facts: is `credential_proxy_verified` true?
//
// It is true only when the newest record for this exact binding is a pass. Any change to the adapter,
// to Faravan or to sbx makes every older record stop matching, so the flag falls back to false until
// the test is run again. Unknown inputs give false, never true.
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
export { readFaravanVersion } from './installed-version.mjs';
import { REQUIRED_CHECKS, SEVERITIES, MARKER, PROBE_VERSION, decideVerdict, scanText, classifyValue, sha256, tokenCandidates } from './credential-probe-guest.mjs';

export { MARKER, REQUIRED_CHECKS, PROBE_VERSION };
export const EVIDENCE_SCHEMA = 1;
const PROBE_FILE = new URL('./credential-probe-guest.mjs', import.meta.url);

/** First 16 hex characters of the SHA-256 of the probe program as shipped. null when it cannot be read: unknown never matches. */
const probeDigests = new Map();
export function currentProbeDigest(file = PROBE_FILE) {
  let fd;
  const key = String(file);
  const generation = stat => [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  try {
    fd = openSync(file, 'r');
    const before = generation(fstatSync(fd,{bigint:true})), hit = probeDigests.get(key);
    if (hit?.generation === before) return hit.digest;
    const digest = createHash('sha256').update(readFileSync(fd, 'utf8')).digest('hex').slice(0,16);
    if (generation(fstatSync(fd,{bigint:true})) !== before) {probeDigests.delete(key);return null;}
    probeDigests.set(key,{generation:before,digest});
    return digest;
  } catch {probeDigests.delete(key);return null;}
  finally {if(fd !== undefined)closeSync(fd);}
}

export const EVIDENCE_LABELS = Object.freeze(['internal', 'independent']);
export const RESULTS = Object.freeze(['pass', 'fail', 'inconclusive']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isoTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value));

/** The probe's report is the last marked line of the sandbox's output. Anything else is noise. */
export function extractReport(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).reverse().find((entry) => entry.startsWith(MARKER));
  if (!line) return null;
  try { return JSON.parse(line.slice(MARKER.length)); } catch { return null; }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

/**
 * The adapter's version: a digest of its whole spec (entrypoint, image, auth strategy, provider hosts,
 * credential handling). Adapters carry no version number, and a number would be one more thing to forget
 * to bump. Any edit to the spec changes the digest and so invalidates the evidence.
 */
export function adapterVersion(adapter) {
  if (!isObject(adapter?.spec) || typeof adapter.spec.harness_id !== 'string') return null;
  return 'spec-' + createHash('sha256').update(canonicalJson(adapter.spec)).digest('hex').slice(0, 16);
}

/** "sbx version v0.48.0 5caf923e..." or "0.48.0" -> "0.48.0+5caf923e..." / "0.48.0". null when unreadable. */
export function normalizeSbxVersion(text) {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:[\s+]([0-9a-f]{7,40}))?(?:\s|$)/.exec(String(text ?? '').replace(/^sbx version:?\s*/i, ''));
  return match ? match[1] + (match[2] ? '+' + match[2] : '') : null;
}


/**
 * Check a probe report. Returns {ok:true, report} or {ok:false, reason}. A report is refused when it is
 * malformed, when its verdict is not what its own checks imply, when a pass lacks a required check, or
 * when any evidence string contains something that looks like a real secret (so a leak cannot be
 * stored by accident).
 */
export function validateProbeReport(report, {ownerGeneration} = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!isObject(report)) return no('report_not_object');
  if (report.probe_version !== PROBE_VERSION) return no('probe_version_unsupported');
  if (!RESULTS.includes(report.verdict)) return no('verdict_invalid');
  if (!Array.isArray(report.checks) || report.checks.length === 0 || report.checks.length > 64) return no('checks_invalid');
  const seen = new Set();
  for (const check of report.checks) {
    if (!isObject(check) || typeof check.id !== 'string' || !/^[a-z][a-z0-9-]{1,48}$/.test(check.id)) return no('check_id_invalid');
    if (seen.has(check.id)) return no('check_id_duplicate');
    seen.add(check.id);
    if (typeof check.found !== 'boolean' && check.found !== null) return no('check_found_invalid');
    if (!SEVERITIES.includes(check.severity)) return no('check_severity_invalid');
    if (typeof check.evidence_redacted !== 'string' || check.evidence_redacted.length > 2000) return no('check_evidence_invalid');
    if (check.found !== true && check.severity !== 'none' && check.found !== null) return no('check_severity_without_finding');
    const leaked = scanText(check.evidence_redacted, { config: false }).some((item) => item.kind === 'real') ||
      scanText(check.evidence_redacted).some((item) => item.kind === 'real');
    if (leaked) return no('evidence_contains_secret');
  }
  if (!isObject(report.provider) || typeof report.provider.mode !== 'string') return no('provider_invalid');
  if (!isObject(report.self_test)) return no('self_test_invalid');
  const ownerGenerationBound = report.provider.owner_generation_bound === true &&
    ownerGeneration?.service === report.provider.service && ['anthropic','openai'].includes(ownerGeneration?.service) &&
    typeof ownerGeneration.directory === 'string' && ownerGeneration.directory.startsWith('/');
  if (report.provider.owner_generation_bound === true && !ownerGenerationBound) return no('owner_generation_unauthorized');
  // Recompute the verdict. The probe is untrusted input here: it ran next to the job.
  const expected = decideVerdict({ checks: report.checks, provider: report.provider, selfTest: report.self_test, ownerGenerationBound });
  if (expected.verdict !== report.verdict) return no('verdict_inconsistent');
  return { ok: true, report };
}

/** The S5.2 evidence record: what was tested, against which exact versions, by whom (internal or independent). */
export function buildEvidenceRecord({ report, adapter, faravanVersion, sbxVersion, testedAt, label = 'internal', probeDigest = null }) {
  const checked = validateProbeReport(report);
  if (!checked.ok) throw Object.assign(new Error('probe report refused: ' + checked.reason), { code: 'probe_report_invalid', reason: checked.reason });
  const version = adapterVersion(adapter);
  const sbx = normalizeSbxVersion(sbxVersion);
  if (!version) throw Object.assign(new Error('adapter has no readable spec'), { code: 'adapter_unknown' });
  if (typeof faravanVersion !== 'string' || !faravanVersion) throw Object.assign(new Error('Faravan version is unknown'), { code: 'faravan_version_unknown' });
  if (!sbx) throw Object.assign(new Error('sbx version is unreadable'), { code: 'sbx_version_unknown' });
  if (!isoTime(testedAt)) throw Object.assign(new Error('tested_at must be an ISO UTC time'), { code: 'tested_at_invalid' });
  if (!EVIDENCE_LABELS.includes(label)) throw Object.assign(new Error('label must be internal or independent'), { code: 'label_invalid' });
  return {
    schema: EVIDENCE_SCHEMA, kind: 'credential_proxy', label, result: report.verdict,
    adapter_id: adapter.spec.harness_id, adapter_version: version, faravan_version: faravanVersion, sbx_version: sbx, tested_at: testedAt,
    probe_version: report.probe_version, probe_digest: probeDigest,
    provider: { service: report.provider.service ?? null, mode: report.provider.mode },
    known_hashes_checked: Number.isSafeInteger(report.known_hashes_checked) ? report.known_hashes_checked : 0,
    inconclusive_reasons: Array.isArray(report.inconclusive_reasons) ? report.inconclusive_reasons.filter((item) => typeof item === 'string').slice(0, 16) : [],
    checks: report.checks.map(({ id, found, severity }) => ({ id, found, severity })),
  };
}

function recordShapeOk(record) {
  return isObject(record) && record.schema === EVIDENCE_SCHEMA && record.kind === 'credential_proxy' &&
    EVIDENCE_LABELS.includes(record.label) && RESULTS.includes(record.result) && isoTime(record.tested_at);
}

/**
 * True only if the newest record for this exact adapter version, Faravan version and sbx version is a
 * pass. The probe's own version and digest are part of the binding. A later fail or inconclusive record for the same binding takes the flag back. Every unknown
 * input (no adapter, no Faravan version, an sbx version that does not parse, a future date) gives false.
 */
export function credentialProxyVerified(records, { adapter, faravanVersion, sbxVersion, now = Date.now(), probeDigest = currentProbeDigest() } = {}) {
  const version = adapterVersion(adapter), sbx = normalizeSbxVersion(sbxVersion);
  if (!version || !sbx || typeof faravanVersion !== 'string' || !faravanVersion || !Array.isArray(records) || !Number.isFinite(now) ||
      typeof probeDigest !== 'string' || !probeDigest) return false;
  // A record made by another probe program (a different version or file) says nothing about this one.
  const matching = records.filter((record) => recordShapeOk(record) && record.adapter_id === adapter.spec.harness_id &&
    record.adapter_version === version && record.faravan_version === faravanVersion && record.sbx_version === sbx &&
    record.probe_version === PROBE_VERSION && record.probe_digest === probeDigest &&
    Date.parse(record.tested_at) <= now);
  if (!matching.length) return false;
  const newest = matching.reduce((best, record) => Date.parse(record.tested_at) >= Date.parse(best.tested_at) ? record : best);
  // A pass also needs every required check present and none found: the stored checks must still say so.
  return newest.result === 'pass' && Array.isArray(newest.checks) &&
    REQUIRED_CHECKS.every((id) => newest.checks.some((check) => check.id === id && check.found === false));
}

export async function loadEvidenceRecords(file = new URL('../../docs/security/credential-proxy-evidence.json', import.meta.url)) {
  try {
    const records = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(records) ? records : [];
  } catch { return []; }
}

/**
 * SHA-256 of every token-shaped string in the lender's real credential files. The hashes go into the
 * sandbox so the probe can tell whether any real value is readable there. Values never leave this function.
 */
export async function hostCredentialHashes(files) {
  const hashes = new Set();
  for (const file of files) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    for (const candidate of tokenCandidates(text)) hashes.add(sha256(candidate));
    const leaves = [];
    try { (function walk(value) { if (typeof value === 'string') leaves.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk); })(JSON.parse(text)); } catch { /* not JSON */ }
    for (const leaf of leaves) if (leaf.length >= 16 && classifyValue(leaf) === 'real') hashes.add(sha256(leaf));
  }
  return [...hashes];
}
