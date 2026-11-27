import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {helpFor, COMMANDS, topLevelUsage} from '../lib/v1/help.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Old spellings are built at runtime so the checker can scan its own tests.
const retiredNames = ['spare' + 'kin', 'feder' + 'ation'];
function assertNoOldBrand(value, source) {
  assert.equal(new RegExp(retiredNames.join('|'), 'i').test(String(value)), false, source + ' contains a retired product name');
}

test('help output has no old product name', () => {
  const help = [topLevelUsage(), ...Object.keys(COMMANDS).map(name => helpFor([name])),
    ...Object.entries(COMMANDS).flatMap(([name, entry]) => Object.keys(entry.actions ?? {}).map(action => helpFor([name, action])))].join('\n');
  assertNoOldBrand(help, 'command help');
  const cli = spawnSync(process.execPath, ['bin/faravan', '--help'], {cwd:root, encoding:'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assertNoOldBrand(cli.stdout + cli.stderr, 'CLI help');
  for (const args of [['ops', 'list', '--json'], ['ops', 'describe', 'uninstall.run', '--json']]) {
    const output = spawnSync(process.execPath, ['bin/faravan', ...args], {cwd:root, encoding:'utf8'});
    assert.equal(output.status, 0, output.stderr);
    assertNoOldBrand(output.stdout + output.stderr, `CLI ${args.join(' ')}`);
  }
  const isolatedHome = mkdtempSync(join(tmpdir(), 'faravan-rename-guard-'));
  try {
    const status = spawnSync(process.execPath, ['bin/faravan', 'status', '--json'], {
      cwd:root, encoding:'utf8', env:{...process.env, FARAVAN_HOME:isolatedHome},
    });
    assert.ok([0, 7].includes(status.status), status.stderr);
    assertNoOldBrand(status.stdout + status.stderr, 'CLI status');
  } finally {
    rmSync(isolatedHome, {recursive:true, force:true});
  }
});

test('built UI assets use the Faravan invitation scheme and contain no old visible product copy', async () => {
  assertNoOldBrand(readFileSync(new URL('../public/v1/app.mjs', import.meta.url), 'utf8'), 'built UI bundle');
  const invitePage = readFileSync(new URL('../public/join/index.html', import.meta.url), 'utf8');
  assert.ok(invitePage.includes('faravan://join?link='), 'new invitation links use the primary scheme');
});
