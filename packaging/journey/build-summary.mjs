// Data-only acceptance reducer. It never launches a product, browser or backend.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REQUIRED_CASE_IDS = Object.freeze(["install","sign-in","pick-agent","host-circle","invite-join","send","approve","watch","read-result","apply","P1-ui","P1-mcp","P1-cli","P2","P3","P4","P5"]);
const PLATFORMS = ['linux', 'macos'];
const FIDELITIES = ['unit', 'mounted UI', 'headless browser two homes', 'installed one host', 'installed two hosts'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idString = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const coverage = {
  "install": "packaging/journey/smoke.mjs#checks.ownerProfile+friendProfile",
  "pick-agent": "packaging/journey/smoke.mjs#checks.lendingSettingsThroughUi",
  "host-circle": "packaging/journey/smoke.mjs#checks.circleInviteJoinApprovalUi",
  "invite-join": "packaging/journey/smoke.mjs#checks.circleInviteJoinApprovalUi",
  "send": "packaging/journey/smoke.mjs#checks.friendSentJobFromUi",
  "approve": "packaging/journey/smoke.mjs#checks.job1HandApprovedOnce",
  "read-result": "packaging/journey/smoke.mjs#checks.job1CompletedAndResultReachedFriend+friendCanReopenResultAfterRestart"
};

// This reusable contract reducer trusts the caller's test inventory. Its ready
// value is for that inventory only. Release callers MUST use summarizeBuild.
export function reduceEvidenceContract(catalog, requiredIds, build, evidence) {
  const problems = [];
  const ids = Array.isArray(requiredIds) ? requiredIds.filter(idString) : [];
  if (!Array.isArray(requiredIds) || ids.length === 0 || ids.length !== requiredIds.length ||
      new Set(ids).size !== ids.length) problems.push('nonempty unique required case IDs required');
  const required = [...new Set(ids)];
  const platforms = Object.fromEntries(PLATFORMS.map(platform => [platform, {
    collected: [], executed: [], firstTryFailures: [], retriedPasses: [], retried: [],
    failed: [], NOT_RUN: [], NOT_BUILT: [], reasons: {},
  }]));
  const buildValid = exactKeys(build, ['buildId', 'artifacts']) && idString(build.buildId) &&
    exactKeys(build.artifacts, PLATFORMS) && PLATFORMS.every(platform => digest(build.artifacts[platform]));
  if (!buildValid) problems.push('exact build ID and linux/macos artifact digests required');
  const entries = new Map(), repeatedCases = new Set();
  if (!Array.isArray(catalog)) problems.push('catalog array required');
  for (const row of Array.isArray(catalog) ? catalog : []) {
    if (!object(row) || !required.includes(row.id)) { problems.push('unknown catalog case'); continue; }
    if (entries.has(row.id)) { repeatedCases.add(row.id); problems.push(row.id + ': duplicate catalog case'); }
    entries.set(row.id, row);
  }
  const rows = new Map(), repeatedRows = new Set();
  if (!Array.isArray(evidence)) problems.push('evidence array required');
  for (const row of Array.isArray(evidence) ? evidence : []) {
    if (!object(row) || !required.includes(row.id) || !PLATFORMS.includes(row.platform)) {
      problems.push('unknown evidence case or platform'); continue;
    }
    const key = row.platform + ':' + row.id;
    if (rows.has(key)) { repeatedRows.add(key); problems.push(key + ': duplicate evidence'); }
    rows.set(key, row);
  }
  for (const platform of PLATFORMS) for (const id of required) {
    const out = platforms[platform], key = platform + ':' + id;
    const entry = entries.get(id), spec = entry?.platforms?.[platform];
    const unavailable = !entry || repeatedCases.has(id) || !object(spec) ||
      spec.status !== 'BUILT';
    if (unavailable) {
      out.NOT_BUILT.push(id);
      // Never echo raw input values or links in output.
      out.reasons[id] = !entry ? 'required catalog entry missing' :
        repeatedCases.has(id) ? 'duplicate catalog entry' : 'scenario implementation unavailable';
      if (!object(spec) || !['BUILT', 'NOT_BUILT'].includes(spec.status) ||
          spec.status === 'NOT_BUILT' && (typeof spec.reason !== 'string' || !spec.reason.trim()))
        problems.push(key + ': valid coverage and reason required');
      if (rows.has(key)) problems.push(key + ': evidence cannot promote an unavailable implementation');
      continue;
    }
    const row = rows.get(key);
    const runs = Array.isArray(row?.runs) ? row.runs : null;
    const specValid = typeof spec.testId === 'string' && spec.testId.trim().length > 0 && FIDELITIES.includes(spec.fidelity);
    const rowValid = buildValid && specValid && !repeatedRows.has(key) &&
      exactKeys(row, ['id', 'platform', 'buildId', 'artifactDigest', 'testId', 'fidelity', 'collected', 'runs']) &&
      row.buildId === build.buildId && row.artifactDigest === build.artifacts[platform] &&
      row.testId === spec.testId && row.fidelity === spec.fidelity && row.collected === true &&
      runs !== null && runs.every((run, index) => exactKeys(run, ['ordinal', 'status']) &&
        run.ordinal === index + 1 && ['pass', 'fail'].includes(run.status));
    if (!rowValid) {
      out.NOT_RUN.push(id);
      out.reasons[id] = row ? 'invalid, duplicate or foreign evidence' : 'no evidence for this build and artifact';
      if (row || !specValid) problems.push(key + ': invalid evidence or test mapping');
      continue;
    }
    out.collected.push(id);
    if (!runs.length) {
      out.NOT_RUN.push(id); out.reasons[id] = 'collected but not executed'; continue;
    }
    out.executed.push(id);
    if (runs[0].status === 'fail') out.firstTryFailures.push(id);
    if (runs.length > 1) {
      out.retried.push(id);
      if (runs.at(-1).status === 'pass') out.retriedPasses.push(id);
    }
    if (runs.at(-1).status === 'fail') out.failed.push(id);
  }
  for (const out of Object.values(platforms)) out.counts = Object.fromEntries(
    ['collected', 'executed', 'firstTryFailures', 'retriedPasses', 'retried', 'failed', 'NOT_RUN', 'NOT_BUILT']
      .map(key => [key, out[key].length]));
  const ready = required.length > 0 && problems.length === 0 && Object.values(platforms).every(out =>
    out.executed.length === required.length && !out.failed.length && !out.retried.length &&
    !out.NOT_RUN.length && !out.NOT_BUILT.length);
  return {ready, target: buildValid ? {buildId: build.buildId, artifacts: {...build.artifacts}} : null, platforms, problems};
}

// Production entry: requirements and verified source mappings are independent of
// evidence and cannot be replaced by fields supplied in a run or build manifest.
export function summarizeBuild(build, evidence) {
  let catalog;
  try { catalog = JSON.parse(readFileSync(new URL('./journey-catalog.json', import.meta.url), 'utf8')); }
  catch { catalog = null; }
  const cases = Array.isArray(catalog?.cases) ? catalog.cases : [];
  const result = reduceEvidenceContract(cases, REQUIRED_CASE_IDS, build, evidence);
  if (catalog?.schemaVersion !== 1) result.problems.push('supported catalog version required');
  for (const id of REQUIRED_CASE_IDS) for (const platform of PLATFORMS) {
    const spec = cases.find(row => row?.id === id)?.platforms?.[platform];
    const knownTest = platform === 'linux' && Object.hasOwn(coverage, id) ? coverage[id] : null;
    if (knownTest ? spec?.status !== 'BUILT' || spec.testId !== knownTest || spec.fidelity !== 'installed one host'
      : spec?.status !== 'NOT_BUILT') result.problems.push(platform + ':' + id + ': unreviewed coverage change');
  }
  if (result.problems.length) result.ready = false;
  return result;
}

// Only parsed, allow-listed summaries reach stdout. Never print source JSON.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('arguments');
    const build = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const evidence = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const result = summarizeBuild(build, evidence);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ready: false, problems: ['Provide readable build and evidence JSON files.']}));
    process.exitCode = 2;
  }
}
