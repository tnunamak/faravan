import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// A shared dependency depot avoids installing a tree for every landing worktree.
const dependencyRoot = process.argv[2];
if (dependencyRoot) {
  for (const relative of ['node_modules', 'ui/node_modules']) {
    if (!fs.existsSync(relative)) {
      const source = path.join(dependencyRoot, relative);
      if (!fs.existsSync(source)) throw new Error(`Dependency depot missing ${relative}`);
      fs.symlinkSync(source, relative, 'dir');
    }
  }
}
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'fixtures') collect(file);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(file);
  }
}
for (const entry of fs.readdirSync('tests', {withFileTypes: true})) {
  if (entry.isDirectory() && entry.name.startsWith('foundation-')) collect(path.join('tests', entry.name));
}
for (const entry of fs.readdirSync('ui/v1/src', {withFileTypes: true})) {
  if (entry.isFile() && /^foundation-.*\.test\.mjs$/.test(entry.name)) files.push(path.join('ui/v1/src', entry.name));
}
files.push('tests/v1-lending-continuous-model.test.mjs', 'tests/v1-lending-gamma-quantile.test.mjs', 'tests/v1-lending-risk-ledger.test.mjs');
files.push('ui/v1/src/updates-view.test.mjs');
if (!files.includes('ui/v1/src/mounted-job.test.mjs')) files.push('ui/v1/src/mounted-job.test.mjs');
files.push('tests/v1-keep-awake.test.mjs', 'ui/v1/src/host.test.mjs');
if (!files.includes('tests/coordinator.test.mjs')) files.push('tests/coordinator.test.mjs');
if (!files.includes('ui/v1/src/job-thread.test.mjs')) files.push('ui/v1/src/job-thread.test.mjs');
if (!files.includes('ui/v1/src/focus.test.mjs')) files.push('ui/v1/src/focus.test.mjs');
files.push('ui/v1/src/announcements.test.mjs');
// Includes real owned-subprocess standby acquisition regressions; retain adapter/build-recovery controls.
if (!files.includes('tests/sandbox-deadline-supervisor.test.mjs')) files.push('tests/sandbox-deadline-supervisor.test.mjs');
for (const root of ['tests/sandbox-deadline-adapter.test.mjs', 'tests/sandbox-deadline-build-recovery.test.mjs']) {
  if (!files.includes(root)) files.push(root);
}
if (!files.includes('tests/v1-lending-runtime-refresh.test.mjs')) files.push('tests/v1-lending-runtime-refresh.test.mjs');
if (!files.includes('tests/v1-lender-pace50.test.mjs')) files.push('tests/v1-lender-pace50.test.mjs');
if (!files.includes('tests/v1-lender-auto-run.test.mjs')) files.push('tests/v1-lender-auto-run.test.mjs');
files.push('tests/v1-lender.test.mjs');
// Keep the actual app integration root exactly once alongside all inherited selections.
const appRoot = 'tests/v1-app.test.mjs';
if (!files.includes(appRoot)) files.push(appRoot);
const savedCopyRoot = 'tests/journey-invariants-saved-copy.test.mjs';
if (!files.includes(savedCopyRoot)) files.push(savedCopyRoot);
const savedReleaseRoot = 'tests/v1-app-resume-saved-release.test.mjs';
if (!files.includes(savedReleaseRoot)) files.push(savedReleaseRoot);
if (!files.includes('tests/gate-false-green-installed.test.mjs')) files.push('tests/gate-false-green-installed.test.mjs');
if (!files.includes('ui/v1/src/telemetry-preview.test.mjs')) files.push('ui/v1/src/telemetry-preview.test.mjs');
if (!files.includes('ui/v1/src/setup.test.mjs')) files.push('ui/v1/src/setup.test.mjs');
files.push('tests/journey-evidence-stop.test.mjs');
files.push('ui/v1/src/circles.test.mjs');
files.push('ui/v1/src/activity-view.test.mjs');
files.push('ui/v1/src/member-host.test.mjs');
files.push('tests/macos-bundle.test.mjs');
if (!files.includes('ui/v1/src/view-models.test.mjs')) files.push('ui/v1/src/view-models.test.mjs');
files.sort();
console.log(`Offline foundation landing check: ${files.length} test files; synthetic checks only.`);
// Each test file runs in its own process. Keep the complete gate within the landing timeout.
const result = spawnSync(process.execPath, ['--import', './ui/v1/src/jsx-register.mjs', '--test', '--test-concurrency=4', '--test-timeout=120000', ...files], {
  stdio: 'inherit', timeout: 1100000,
  env: {...process.env, TZ: 'America/Chicago'},
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
