import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import cp, { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createFakeCommands, runJob } from '../scripts/run-tests.mjs';

test('real-CLI red proof: all Node process APIs reject an executable outside allowed dirs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-guard-real-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'executed');
  for (const name of ['claude', 'codex', 'sbx', 'docker', 'security']) {
    writeFileSync(join(dir, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  }
  // Mark this otherwise allowed temporary HOME-like directory as a real installation.
  const prior = process.env.TEST_CLI_GUARD_DENY_DIR;
  process.env.TEST_CLI_GUARD_DENY_DIR = dir;
  t.after(() => { if (prior === undefined) delete process.env.TEST_CLI_GUARD_DENY_DIR; else process.env.TEST_CLI_GUARD_DENY_DIR = prior; });
  for (const name of ['claude', 'codex', 'sbx', 'docker', 'security']) {
    const file = join(dir, name), env = { PATH: dir };
    for (const api of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
      assert.throws(() => cp[api](file, [], { env }), /TEST_CLI_GUARD: blocked real CLI/);
      assert.throws(() => cp[api](name, [], { env }), /TEST_CLI_GUARD: blocked real CLI/);
    }
    for (const api of ['exec', 'execSync']) {
      assert.throws(() => cp[api](`'${file}' auth status`, { env }), /TEST_CLI_GUARD: blocked real CLI/);
    }
    assert.throws(() => cp.spawn('/bin/sh', ['-c', `${name} auth status`], { env }), /TEST_CLI_GUARD: blocked real CLI/);
    assert.throws(() => cp.spawn('/bin/sh', ['-c', `PATH='${dir}' ${name} auth status`]), /TEST_CLI_GUARD: blocked real CLI/);
    assert.throws(() => cp.spawn('/bin/sh', ['-c', `CLI='${file}'; "$CLI" auth status`]), /TEST_CLI_GUARD: blocked real CLI/);
    assert.throws(() => cp.spawn('/bin/sh', ['-c', '"$HOME/claude" auth status'], { env: { HOME: dir } }), /TEST_CLI_GUARD: blocked real CLI/);
    assert.throws(() => cp.spawn('env', [name], { shell: true, env }), /TEST_CLI_GUARD: blocked real CLI/);
    assert.throws(() => cp.fork('unused.mjs', [], { execPath: file }), /TEST_CLI_GUARD: blocked real CLI/);
    assert.throws(() => cp.spawn(name, [], { shell: true, env }), /TEST_CLI_GUARD: blocked real CLI/);
  }
  const aliases = join(dir, 'aliases');
  mkdirSync(aliases);
  symlinkSync(join(dir, 'claude'), join(aliases, 'claude'));
  assert.throws(() => cp.spawn('claude', [], { env: { PATH: aliases } }), /TEST_CLI_GUARD: blocked real CLI/);
  const pathDirectory = join(dir, 'directory-entry');
  mkdirSync(join(pathDirectory, 'claude'), { recursive: true });
  assert.throws(() => cp.spawn('claude', [], { env: { PATH: `${pathDirectory}:${dir}` } }), /TEST_CLI_GUARD: blocked real CLI/);
  assert.equal(existsSync(marker), false, 'blocked executable never ran');
});

test('runner fakes are inert and test-owned fakes can override them', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-guard-fakes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakes = createFakeCommands(dir);
  for (const name of ['claude', 'codex', 'sbx', 'docker', 'security']) {
    const result = spawnSync(name, [], { env: { PATH: fakes }, encoding: 'utf8' });
    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'TEST_FAKE_CLI: unavailable\n');
  }
  const own = join(dir, 'own');
  mkdirSync(own);
  writeFileSync(join(own, 'claude'), '#!/bin/sh\necho test-owned\n', { mode: 0o755 });
  assert.equal(execFileSync('claude', [], { env: { PATH: `${own}:${fakes}` }, encoding: 'utf8' }).trim(), 'test-owned');
  const result = await runJob({ kind: 'shell', name: 'fake-cli', command: '/bin/sh', args: ['-c', 'claude'] }, { dir, fileTimeoutMs: 5000 });
  assert.equal(result.code, 127);
  assert.match(result.output, /TEST_FAKE_CLI: unavailable/);
});

test('preload survives a Node child with a replacement env and preserves promisify', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-guard-child-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(cp.execFile)(process.execPath, ['-e', 'console.log("ok")'], { env: {} });
  assert.equal(stdout, 'ok\n');
  const file = join(dir, 'claude');
  writeFileSync(file, '#!/bin/sh\necho must-not-run\n', { mode: 0o755 });
  process.env.TEST_CLI_GUARD_DENY_DIR = dir;
  t.after(() => delete process.env.TEST_CLI_GUARD_DENY_DIR);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {spawnSync} from 'node:child_process'; spawnSync(${JSON.stringify(file)});`], { env: {}, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /TEST_CLI_GUARD: blocked real CLI/);
  assert.equal(child.stdout, '');
});

test('review regression: a renamed symlink to a protected CLI is blocked', t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-guard-renamed-'));
  const previous = process.env.TEST_CLI_GUARD_DENY_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_CLI_GUARD_DENY_DIR;
    else process.env.TEST_CLI_GUARD_DENY_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const installed = join(root, 'installed');
  mkdirSync(installed);
  const target = join(installed, 'claude');
  writeFileSync(target, '#!/bin/sh\nprintf "INERT_RENAMED_SYMLINK\\n"\n', { mode: 0o755 });
  const alias = join(root, 'agent-alias');
  symlinkSync(target, alias);
  process.env.TEST_CLI_GUARD_DENY_DIR = installed;
  assert.throws(() => {
    const output = execFileSync(alias, [], { encoding: 'utf8' });
    console.log(`unexpectedly allowed: ${output.trim()}`);
  }, /TEST_CLI_GUARD: blocked real CLI/);
  assert.throws(() => execFileSync('agent-alias', [], { env: { PATH: root } }), /TEST_CLI_GUARD: blocked real CLI/);
});

test('review regression: shell cd cannot reach a protected relative command', t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-guard-shell-cd-'));
  const previous = process.env.TEST_CLI_GUARD_DENY_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_CLI_GUARD_DENY_DIR;
    else process.env.TEST_CLI_GUARD_DENY_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const working = join(root, 'working'), installed = join(root, 'installed');
  mkdirSync(working);
  mkdirSync(installed);
  writeFileSync(join(installed, 'claude'), '#!/bin/sh\nprintf "INERT_SHELL_CD\\n"\n', { mode: 0o755 });
  const fakes = createFakeCommands(root);
  process.env.TEST_CLI_GUARD_DENY_DIR = installed;
  const env = { PATH: fakes, TEST_CLI_FAKE_DIR: fakes };
  assert.throws(() => {
    const output = execFileSync('/bin/sh', ['-c', `cd '${installed}' && ./claude auth status`], { cwd: working, env, encoding: 'utf8' });
    console.log(`unexpectedly allowed: ${output.trim()}`);
  }, /TEST_CLI_GUARD: blocked real CLI/);
  // A relative PATH entry can change its target after cd too.
  assert.throws(() => execFileSync('/bin/sh', ['-c', `cd '${installed}' && claude auth status`], {
    cwd: working, env: { ...env, PATH: `.:${fakes}` },
  }), /TEST_CLI_GUARD: blocked real CLI/);
});
