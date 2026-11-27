#!/usr/bin/env node
// `npm run protocol:check`: model-checks the protocols in spec/tla with TLC at fixed bounds.
// Each check states its expected outcome: 'pass', or the one property TLC must find violated
// (a known open bug, a variant that drops an assumption, or a reachability witness).
// Exits 1 when any outcome differs, so a protocol change that breaks a model fails here.
//
// TLC runs outside the test sandbox: Java needs no network once the jar is in ~/.tmp/tla.
// The jar is never stored in the repo. See spec/tla/README.md.
//
// Flags: --only=<check>[,<check>...]   Env: TLA2TOOLS_JAR (a jar path; still checksum-verified).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'spec', 'tla');
export const TLA2TOOLS = {
  url: 'https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar',
  sha256: '7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f',
};
const TIME_LIMIT_MS = 5 * 60 * 1000;
// Keep Hosting_h4's full bounds while allowing for contention on shared machines.
const MODEL_TIME_LIMIT_MS = {Hosting_h4: 15 * 60 * 1000};
// Heap plus off-heap fingerprint set stay under 2 GB resident.
const JAVA = ['-XX:+UseParallelGC', '-Xmx1200m', '-XX:MaxDirectMemorySize=400m'];

export const CHECKS = [
  ...['decline','stop','output','ack','cooldown','save'].map(kind=>['LenderRecovery_'+kind,'pass']),

  ['HealthRecovery', 'pass'],
  ['BorrowerWatch', 'pass'],
  ['NativeGuardStop', 'pass'],
  ['NativeGuard_faithful', 'pass'],
  ['NativeGuard_wait', 'StaleOnTime'],
  ['NativeGuard_late', 'NoLateRearm'],
  ['NativeGuard_inband', 'InbandUntrusted'],
  ['NativeGuard_ack', 'AckNotCessation'],
  ['NativeGuard_margin', 'CertificationHonest'],
  ['NativeGuard_uncertified', 'ResidualBound'],
  ['NativeGuard_reach', 'W_NoStopAfterHang'],
  // ProbeOwnership: shipped coupling, publication mutant, repair and boundary witnesses.
  ['ProbeOwnership', 'pass'],
  ['ProbeOwnership_isolation', 'NoCollateralAbort'],
  ['ProbeOwnership_guard', 'GuardNotLost'],
  ['ProbeOwnership_stale', 'CacheFence'],
  ['ProbeOwnership_repair', 'pass'],
  ['ProbeOwnership_reach_cancel', 'W_NoCancelBoundary'],
  ['ProbeOwnership_reach_stale', 'W_NoInvalidatedCompletion'],
  ['ProbeOwnership_reach_guard', 'W_NoGuardSurvival'],
  // AdmissionFeedback: faithful run, deliberate mutations, non-vacuity witnesses.
  ['AdmissionFeedback', 'pass'],
  ['AdmissionFeedback_lost', 'TriggersDrained'],
  ['AdmissionFeedback_renew', 'BlindBudget'],
  ['AdmissionFeedback_coverage', 'CoverageSound'],
  ['AdmissionFeedback_overtake', 'FenceOrder'],
  ['AdmissionFeedback_double', 'SettledStable'],
  ['AdmissionFeedback_admission', 'FenceOrder'],
  ['AdmissionFeedback_reachAdmission', 'W_Admission'],
  ['AdmissionFeedback_reachTrigger', 'W_Trigger'],
  ['AdmissionFeedback_reachBlind', 'W_Blind'],
  ['AdmissionFeedback_reachCoverage', 'W_Coverage'],
  ['AdmissionFeedback_reachFence', 'W_Fence'],
  ['AdmissionFeedback_reachReprice', 'W_Reprice'],
  // AdmissionExposure: sound certificates, mutations and boundary witnesses.
  ['AdmissionExposure_faithful', 'pass'],
  ['AdmissionExposure_estimate', 'RoomSound'],
  ['AdmissionExposure_refresh', 'ExposureBudget'],
  ['AdmissionExposure_omit', 'RoomSound'],
  ['AdmissionExposure_reach_burst', 'W_NoOwnerBurst'],
  ['AdmissionExposure_reach_unknown', 'W_NoUnknownBoundary'],
  ['AdmissionExposure_reach_sequential', 'W_NoSequential'],
  ['AdmissionExposure_reach_own', 'W_NoOwnRecheck'],
  ['AdmissionExposure_reach_coverage', 'W_NoCoverage'],
  // AdmissionEpoch: faithful contract, intentional mutants and boundary witnesses.
  ['AdmissionEpoch', 'pass'],
  ['AdmissionEpoch_bug_scope', 'ScopeExact'],
  ['AdmissionEpoch_reach_scope', 'W_Boundary'],
  ['AdmissionEpoch_bug_account', 'ScopeExact'],
  ['AdmissionEpoch_reach_account', 'W_Boundary'],
  ['AdmissionEpoch_bug_deadline', 'DeadlineNeverLater'],
  ['AdmissionEpoch_reach_deadline', 'W_Boundary'],
  ['AdmissionEpoch_bug_weekly', 'WeeklyRetained'],
  ['AdmissionEpoch_reach_weekly', 'W_Boundary'],
  ['AdmissionEpoch_bug_carry', 'CarryBeforeSlack'],
  ['AdmissionEpoch_reach_carry', 'W_Boundary'],
  ['AdmissionEpoch_bug_proof', 'ProofGeneration'],
  ['AdmissionEpoch_reach_proof', 'W_Boundary'],
  // AdmissionRecovery: enabled retries, transient failures and reachability.
  ['AdmissionRecovery_read', 'pass'],
  ['AdmissionRecovery_backend', 'pass'],
  ['AdmissionRecovery_save', 'RecoveryLiveness'],
  ['AdmissionRecovery_repair', 'pass'],
  ['AdmissionRecovery_pending', 'RecoveryLiveness'],
  ['AdmissionRecovery_no-force', 'pass'],
  ['AdmissionRecovery_lost-owner', 'RecoveryLiveness'],
  ['AdmissionRecovery_poison', 'RecoveryLiveness'],
  ['AdmissionRecovery_timer', 'RecoveryLiveness'],
  ['AdmissionRecovery_partial', 'RecoveryLiveness'],
  ['AdmissionRecovery_reach-read', 'W_NoFailedRead'],
  ['AdmissionRecovery_reach-poison', 'W_NoPoison'],
  ['AdmissionRecovery_reach-owner', 'W_NoCrashOwner'],
  ['AdmissionRecovery_reach-reset', 'W_NoPartialReset'],
  ['AdmissionRecovery_reach-next', 'W_NoNext'],
  ['AdmissionRecovery_permanent', 'pass'],
  // AdmissionAccounting: conservation, mutation sensitivity and boundary witnesses.
  ['AdmissionAccounting_duplicate_bug', 'Conservation'],
  ['AdmissionAccounting_proof_bug', 'AdmissionContract'],
  ['AdmissionAccounting_race', 'pass'],
  ['AdmissionAccounting_race_bug', 'Checked'],
  ['AdmissionAccounting_race_reach', 'Checked'],
  ['AdmissionAccounting_replace', 'pass'],
  ['AdmissionAccounting_replace_bug', 'Checked'],
  ['AdmissionAccounting_replace_reach', 'Checked'],
  ['AdmissionAccounting_aggregate', 'pass'],
  ['AdmissionAccounting_aggregate_bug', 'Checked'],
  ['AdmissionAccounting_aggregate_reach', 'Checked'],
  ['AdmissionAccounting_cleanup', 'pass'],
  ['AdmissionAccounting_cleanup_bug', 'Checked'],
  ['AdmissionAccounting_cleanup_reach', 'Checked'],
  ['AdmissionAccounting_cleanup_consumed', 'NoPrematureAdmission'],
  ['AdmissionAccounting_native', 'pass'],
  ['AdmissionAccounting_native_bug', 'Checked'],
  ['AdmissionAccounting_native_reach', 'Checked'],
  ['LendingLease', 'pass'],
  ['LendingLease_isolation', 'pass'],
  ['LendingLease_isolation_skip', 'I5_IsolationBeforeRun'],
  ['LendingLease_isolation_reach', 'W_NoIsolationRun'],
  ['LendingLease_tries2', 'pass'],
  ['LendingLease_escape', 'pass'],
  ['LendingLease_live', 'pass'],
  ['LendingLease_counter', 'I2c_CounterWithinMax'],
  ['LendingLease_noack', 'I2b_RunsCounted'],
  ['LendingLease_noack_i1', 'pass'],
  ['LendingLease_noack_escape', 'I1_OneExecuting'],
  ['LendingLease_reach_fence', 'W_NoSuccessorAfterUnknownLaunch'],
  ['LendingLease_reach_late', 'W_NoLateObservation'],
  ['LendingLease_reach_delayed', 'W_NoDelayedResult'],
  ['Admission_headroom', 'pass'],
  ['Admission_coverage', 'pass'],
  ['Hosting', 'H5_UniqueLiveCoordinator'],
  ['Hosting_h1', 'H1_StopSticks'],
  ['Hosting_h4', 'pass'],
  ['Hosting_gencheck', 'pass'],
  ['Hosting_unreadable', 'H2_OneCommittedHome'],
].map(([config, expect]) => ({ config, module: config.split('_')[0], expect }));

// A scenario sweep shares its module's .cfg; each row only overrides CONSTANTS lines.
const sweep = (module, rows) => rows.map(([name, expect, constants]) => ({ config: `${module}_${name}`, module, expect, constants }));
CHECKS.push(
  ...sweep('Admission', [
    ...['probe', 'cap', 'legacy', 'known', 'multiple', 'partial', 'native'].map(s => [s, 'pass', { Scenario: s }]),
    ['native-blind-release', 'NativeBlindRetained', {Fixed:false, Scenario:'native'}],
    ['native-uncertainty', 'pass', {Scenario:'native-uncertainty'}],
    ['native-uncertainty-release', 'NativeUncertaintyRetained', {Fixed:false, Scenario:'native-uncertainty'}],
    ['native-clear-without-cover', 'pass', {Scenario:'native-clear-without-cover'}],
    ['native-clear-without-cover-bug', 'NativeClosedHasCoverage', {Fixed:false, Scenario:'native-clear-without-cover'}],
    ['native-tight-headroom', 'pass', {Scenario:'native', NativeHeadroom:1}],
    // The old cancelled-cache refusal and the shared evidence rule, independent of Fixed.
    ...['cancel-first', 'cancel-start'].flatMap(s => [
      [s, 'CancelledCacheContinuity', { Scenario: s, CancelSafe: false }],
      [`${s}-safe`, 'pass', { Scenario: s, CancelSafe: true }],
    ]),
    ...['new-read', 'revision', 'infrastructure'].flatMap(s => [
      [`${s}-round2`, s === 'infrastructure' ? 'TransientKeepsEvidence' : 'UsableChangeStillAdmits',
        {Scenario:s, CancelSafe:true, RecheckSafe:false}],
      [`${s}-round3`, 'pass', {Scenario:s, CancelSafe:true, RecheckSafe:true}],
    ]),
    // The rule before 73cab697: the model still finds each bug it was built to show.
    ['old-cap', 'DefaultCoversCall', { Fixed: false, Scenario: 'cap' }],
    ['old-probe', 'CacheContinuity', { Fixed: false, Scenario: 'probe' }],
    ['old-multiple', 'CoveredSweepCloses', { Fixed: false, Scenario: 'multiple' }],
  ]),
  ...sweep('Stop', [
    ...[['cancel', 'none', 'none'], ['cancel', 'none', 'borrower'], ['cancel', 'none', 'lender'], ['cancel', 'reply', 'borrower'],
      ['cancel', 'request', 'borrower'], ['finish-stop', 'none', 'none'], ['finish-stop', 'reply', 'lender'],
      ...['lender', 'owner'].flatMap(k => [[k, 'none', 'none'], [k, 'none', 'borrower'], [k, 'none', 'lender'],
        [k, 'reply', 'lender'], [k, 'request', 'lender']])]
      .map(([Kind, Fault, RestartPeer]) => [`${Kind}-${Fault}-${RestartPeer}`, 'pass', { Kind, Fault, RestartPeer }]),
    // Regressions: delivery ambiguity, cancellation and measurement failure (spec/tla/README.md, Stop).
    ['cancel-race-none-none', 'pass', { Kind: 'cancel-race', Fault: 'none', RestartPeer: 'none' }],
    ['malformed-malformed-none', 'pass', { Kind: 'malformed', Fault: 'malformed', RestartPeer: 'none' }],
    ['malformed-malformed-lender', 'pass', { Kind: 'malformed', Fault: 'malformed', RestartPeer: 'lender' }],
    ['measurement-none-none', 'pass', { Kind: 'measurement', Fault: 'none', RestartPeer: 'none' }],
  ]),
);

// LaunchComposition: faithful contracts, intentional mutations, boundary witnesses.
CHECKS.push(
  {config: 'LaunchComposition', module: 'LaunchComposition', expect: 'pass'},
  {config: 'LaunchComposition_early', module: 'LaunchComposition', expect: 'DurableBeforeDispatch'},
  {config: 'LaunchComposition_replay', module: 'LaunchComposition', expect: 'NoLaunchReplay'},
  {config: 'LaunchComposition_refund', module: 'LaunchComposition', expect: 'UnknownRetainsHold'},
  {config: 'LaunchComposition_late', module: 'LaunchComposition', expect: 'NoLateEffect'},
  {config: 'LaunchComposition_discard', module: 'LaunchComposition', expect: 'JournalOwnership'},
  {config: 'LaunchComposition_noack', module: 'LaunchComposition', expect: 'AckHasObservation'},
  {config: 'LaunchComposition_reach_hold', module: 'LaunchComposition', expect: 'W_Hold'},
  {config: 'LaunchComposition_reach_dispatch', module: 'LaunchComposition', expect: 'W_Dispatch'},
  {config: 'LaunchComposition_reach_recovery', module: 'LaunchComposition', expect: 'W_Recovery'},
  {config: 'LaunchComposition_reach_unknown', module: 'LaunchComposition', expect: 'W_Unknown'},
  {config: 'LaunchComposition_reach_late', module: 'LaunchComposition', expect: 'W_Late'},
  {config: 'LaunchComposition_reach_journal', module: 'LaunchComposition', expect: 'W_Journal'},
  {config: 'LaunchComposition_reach_ack', module: 'LaunchComposition', expect: 'W_Ack'},
);

// Writes the .cfg a check runs: its own file, or its module's file with the sweep row's constants.
function configFile(check, dir) {
  if (!check.constants) return check.config + '.cfg';
  let text = readFileSync(join(SPEC, check.module + '.cfg'), 'utf8');
  for (const [name, value] of Object.entries(check.constants)) {
    const line = new RegExp(`^(\\s*${name}\\s*=).*$`, 'm');
    if (!line.test(text)) throw new Error(`${check.module}.cfg has no constant ${name}`);
    text = text.replace(line, `$1 ${typeof value === 'boolean' ? String(value).toUpperCase() : JSON.stringify(value)}`);
  }
  const path = join(dir, check.config + '.cfg');
  writeFileSync(path, text);
  return path;
}

function jarPath() {
  const path = process.env.TLA2TOOLS_JAR || join(homedir(), '.tmp', 'tla', 'tla2tools.jar');
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    console.log(`downloading ${TLA2TOOLS.url} -> ${path}`);
    const got = spawnSync('curl', ['-fsSL', '-o', path, TLA2TOOLS.url], { stdio: 'inherit' });
    if (got.status !== 0) throw new Error('could not download tla2tools.jar');
  }
  const sum = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (sum !== TLA2TOOLS.sha256) throw new Error(`${path}: sha256 ${sum}, expected ${TLA2TOOLS.sha256}`);
  return path;
}

// Reads TLC's outcome: 'pass', a violated property name, or an error.
export function outcome(output) {
  const inv = output.match(/(?:Invariant|Action property) (\w+) is violated/);
  if (inv) return inv[1];
  const temporal = output.match(/Temporal property (\w+) was violated/);
  if (temporal) return temporal[1];
  if (/Temporal properties were violated/.test(output)) return 'temporal';
  if (/Model checking completed\. No error has been found\./.test(output)) return 'pass';
  return 'error';
}

function run(check, jar) {
  const meta = mkdtempSync(join(homedir(), '.tmp', 'tla', 'states-'));
  const started = Date.now();
  const res = spawnSync('java', [...JAVA, '-cp', jar, 'tlc2.TLC', '-workers', '2', '-noGenerateSpecTE',
    // The hosting model bounds its actors, so its runs end; an end state is not a deadlock there.
    ...(check.module === 'Hosting' ? ['-deadlock'] : []),
    '-metadir', meta, '-config', configFile(check, meta), check.module + '.tla'],
  { cwd: SPEC, encoding: 'utf8', timeout: MODEL_TIME_LIMIT_MS[check.config] ?? TIME_LIMIT_MS, maxBuffer: 256 * 2 ** 20 });
  rmSync(meta, { recursive: true, force: true });
  const output = (res.stdout ?? '') + (res.stderr ?? '');
  const states = output.match(/([\d,]+) distinct states found/g)?.at(-1)?.match(/[\d,]+/)?.[0] ?? '?';
  return { got: res.error?.code === 'ETIMEDOUT' ? 'timeout' : outcome(output), states,
    seconds: Math.round((Date.now() - started) / 1000), output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
  const jar = jarPath();
  let failed = 0;
  for (const check of CHECKS.filter(c => !only || only.includes(c.config))) {
    const r = run(check, jar);
    const ok = r.got === check.expect;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${check.config.padEnd(34)} expect ${check.expect.padEnd(32)} got ${r.got.padEnd(32)} ${r.states} states ${r.seconds}s`);
    if (!ok) {
      const log = join(homedir(), '.tmp', 'tla', check.config + '.out');
      writeFileSync(log, r.output);
      console.log(`     TLC output: ${log}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
