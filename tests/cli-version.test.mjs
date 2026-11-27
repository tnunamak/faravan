import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const versionFile = new URL('../VERSION', import.meta.url);
const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '0.1.0-dev';
for (const flag of ['--version', '-v']) {
  test('S2 faravan ' + flag, () => {
    const run = spawnSync(process.execPath, [process.env.CLI_VERSION_TEST_BINARY || 'bin/faravan', flag], {encoding:'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), version);
  });
}

test('S2 packaged CLI reads its resource version before loading the app', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-version-'));
  try {
    mkdirSync(join(root, 'bin'));
    copyFileSync(new URL('../bin/faravan', import.meta.url), join(root, 'bin/faravan'));
    writeFileSync(join(root, 'VERSION'), '1.2.3-preview.4\n');
    const run = spawnSync(process.execPath, [join(root, 'bin/faravan'), '--version'], {encoding:'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '1.2.3-preview.4');
  } finally {
    rmSync(root, {recursive:true, force:true});
  }
});
