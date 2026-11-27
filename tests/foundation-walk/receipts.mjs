// Receipt infrastructure only; this does not execute or certify a product walk.
export const CHECKS = Object.freeze([
  'W01_CLEAN_NONOWNER', 'W02_INSTALL_NO_TERMINAL', 'W03_INVITE_JOIN',
  'W04_ACCOUNT_OPTIONS', 'W05_SEND_SELECTED', 'W06_RESULT_RETURN',
  'W07_FIRST_JOB_AGED_NONE', 'W08_STOP_AND_RECLAIM', 'W09_KEEP_REGRESSIONS',
  'W10_CLEANUP', 'W11_DOCKER_ENROLLMENT', 'W12_QUIET_TELEMETRY',
]);
const fixtureChecks = new Set(CHECKS.slice(6, 9));
const fields = new Set(['mode', 'os', 'arch', 'backendVersion', 'code',
  'accountId', 'jobId', 'attemptId', 'readingAgeMs', 'fixtureIntervention']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (typeof secret === 'string' && secret.length) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/(?:Bearer|token|password|invite)\s*[:= ]\s*\S+/gi, '[REDACTED]');
}
function safeText(value, secrets) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\r\n]/.test(value)) return null;
  return redact(value, secrets);
}
export function receipt(input, secrets = []) {
  if (input.schemaVersion !== 1 || !CHECKS.includes(input.check) ||
      !['linux', 'mac'].includes(input.platform) ||
      !/^[a-f0-9]{40}$/.test(input.head) || !/^[a-f0-9]{64}$/.test(input.artifactSha256) ||
      !['pass', 'fail', 'blocked'].includes(input.outcome) || !integer(input.elapsedMs)) {
    throw new Error('invalid_walk_receipt');
  }
  const observed = {};
  for (const [key, value] of Object.entries(input.observed ?? {})) {
    if (!fields.has(key)) continue;
    if (key === 'readingAgeMs') {
      if (value === null || integer(value)) observed[key] = value;
    } else if (key === 'fixtureIntervention') {
      observed[key] = value === true;
    } else {
      const text = safeText(value, secrets);
      if (text !== null) observed[key] = text;
    }
  }
  let outcome = input.outcome;
  if (outcome === 'pass' && (observed.fixtureIntervention ||
      (!fixtureChecks.has(input.check) && observed.mode !== 'live') ||
      !['live', 'fixture'].includes(observed.mode) ||
      !observed.os || !observed.arch || !observed.backendVersion)) outcome = 'blocked';
  const evidencePaths = [];
  for (const path of input.evidencePaths ?? []) {
    // Only local relative artifact names, never credentials, URLs or raw logs.
    if (typeof path !== 'string' || path.length > 512 ||
        !/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('/') ||
        path.split('/').some(p => !p || p === '.' || p === '..') ||
        /auth|invite|credential|secret|token/i.test(path) ||
        secrets.some(secret => secret && path.includes(secret))) continue;
    evidencePaths.push(path);
  }
  if (outcome === 'pass' && evidencePaths.length === 0) outcome = 'blocked';
  return { schemaVersion: 1, check: input.check, platform: input.platform,
    head: input.head, artifactSha256: input.artifactSha256, outcome, observed,
    elapsedMs: input.elapsedMs, evidencePaths };
}
export function aggregate(records, binding) {
  const checked = records.map(record => receipt(record));
  if (checked.some(r => r.platform !== binding.platform || r.head !== binding.head ||
      r.artifactSha256 !== binding.artifactSha256)) throw new Error('walk_binding_mismatch');
  const firstFailure = checked.find(r => r.outcome === 'fail')?.check ?? null;
  const checks = CHECKS.map(check => {
    const all = checked.filter(r => r.check === check);
    const outcome = all.some(r => r.outcome === 'fail') ? 'fail' : all.at(-1)?.outcome ?? 'blocked';
    return { check, outcome };
  });
  const outcome = firstFailure ? 'fail' : checks.every(r => r.outcome === 'pass') ? 'pass' : 'blocked';
  return { schemaVersion: 1, platform: binding.platform, head: binding.head,
    artifactSha256: binding.artifactSha256, outcome, firstFailure, checks,
    exitCode: outcome === 'pass' ? 0 : outcome === 'fail' ? 1 : 2 };
}
export function jsonl(records) { return records.map(r => JSON.stringify(receipt(r))).join('\n') + (records.length ? '\n' : ''); }
