import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBrowserShims } from './helpers/no-browser.mjs';
import { isolateTestGitEnv } from './helpers/git-env.mjs';
import { openUrl } from '../lib/v1/open-url.mjs';
import { validateArchive } from '../lib/archive.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-mac-portability-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
const commandPath = async name => (await exec('sh', ['-c', 'command -v "$1"', 'sh', name])).stdout.trim();

test('both tar creators suppress BSD xattrs; the real host tar accepts --no-xattrs', async t => {
  const dir = await fixture(t), shims = join(dir, 'shims'), plain = join(dir, 'plain'), repo = join(dir, 'repo');
  for (const path of [shims, plain, repo]) await mkdir(path);
  await writeFile(join(plain, 'plain.txt'), 'plain\n');
  const git = args => exec('git', ['-C', repo, ...args]);
  await git(['init', '-q']);
  await writeFile(join(repo, 'tracked.txt'), 'old\n');
  await git(['add', '.']); await git(['commit', '-qm', 'initial']);
  await writeFile(join(repo, 'tracked.txt'), 'changed\n');
  const realTar = await commandPath('tar'), log = join(dir, 'tar.log');
  // A BSD-behaviour stand-in fails when creation could emit binary xattr PAX records.
  // Successful calls still run the actual host tar, including GNU tar on Linux.
  await writeFile(join(shims, 'tar'), '#!/bin/sh\n' +
    'found=0\nfor arg do [ "$arg" != "--no-xattrs" ] || found=1; done\n' +
    '[ "$found" = 1 ] || { echo "binary com.apple.provenance PAX would be included" >&2; exit 70; }\n' +
    'printf "%s\\n" "$*" >> "$PORTABILITY_TAR_LOG"\nexec "$PORTABILITY_REAL_TAR" "$@"\n', {mode: 0o755});
  const sourceUrl = new URL('../lib/source-package.mjs', import.meta.url).href;
  const runUrl = new URL('../lib/v1/run.mjs', import.meta.url).href;
  const archiveUrl = new URL('../lib/archive.mjs', import.meta.url).href;
  const program = [
    'import assert from "node:assert/strict";',
    'import {packageSourceDirectory} from ' + JSON.stringify(sourceUrl) + ';',
    'import {runJob} from ' + JSON.stringify(runUrl) + ';',
    'import {validateArchive} from ' + JSON.stringify(archiveUrl) + ';',
    'const source = await packageSourceDirectory(process.env.PORTABILITY_PLAIN);',
    'assert.equal(source.method, "tar"); assert.equal(validateArchive(source.buffer).bytes, 6);',
    'let submitted;',
    'const code = await runJob(["synthetic task", "--yes", "--include-uncommitted", "--detach", "--circle", "portable"], {',
    'cwd: process.env.PORTABILITY_REPO, stdout: {write() {}}, stderr: {write() {}},',
    'device: {selectCircle: async () => ({id: "portable", name: "Portable"})},',
    'operations: {submit: async input => {submitted = input; return {jobDigest: "sha256:" + "a".repeat(64)};}}});',
    'assert.equal(code, 0); assert.equal(validateArchive(submitted.sourceTar).bytes, 8);',
    'console.log("both source creators passed");',
  ].join('\n');
  const result = await exec(process.execPath, ['--input-type=module', '--eval', program], {env: {...process.env,
    PATH: shims + delimiter + process.env.PATH, PORTABILITY_REAL_TAR: realTar, PORTABILITY_TAR_LOG: log,
    PORTABILITY_PLAIN: plain, PORTABILITY_REPO: repo}});
  assert.match(result.stdout, /both source creators passed/);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2);
  t.diagnostic((await exec(realTar, ['--version'])).stdout.split('\n')[0]);
});

test('staging works with BSD install and preserves nested names and modes', async t => {
  const dir = await fixture(t), repo = join(dir, 'repo'), shims = join(dir, 'shims'), dest = join(dir, 'staged app');
  await mkdir(join(repo, 'packaging'), {recursive: true}); await mkdir(shims);
  await copyFile(join(root, 'packaging/stage-app.sh'), join(repo, 'packaging/stage-app.sh'));
  const files = {
    'bin/faravan': '#!/bin/sh\nexit 0\n',
    'lib/nested/a b.mjs': 'export default 1;\n',
    'lib/v1/lending-prices.json': '{}\n',
    'lib/v1/lending-kappa-calibration.json': '{}\n',
    'lib/v1/telemetry/catalog.json': '{}\n',
    "kits/quote'and space/file.txt": 'kit\n',
    'profiles/faravan-docker.json': '{}\n',
    'docs/protocol/job.schema.json': '{}\n',
    'docs/security/credential-proxy-evidence.json': '{}\n',
    'public/nested/style.css': 'body {}\n',
    'coordinator/package.json': '{}\n',
    'coordinator/package-lock.json': '{}\n',
    'LICENSE.md': 'licence\n',
    'package.json': '{"name":"portability-fixture","version":"1.0.0"}\n',
    'package-lock.json': '{"name":"portability-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"portability-fixture","version":"1.0.0"}}}\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), {recursive: true});
    await writeFile(join(repo, path), content);
  }
  await writeFile(join(shims, 'install'), '#!/bin/sh\n' +
    'for arg do case "$arg" in -D|--*) echo "BSD install: unsupported option" >&2; exit 64;; esac; done\n' +
    'exec "$PORTABILITY_REAL_INSTALL" "$@"\n', {mode: 0o755});
  await exec('bash', [join(repo, 'packaging/stage-app.sh'), dest, '0.0.1'], {env: {...process.env,
    PATH: shims + delimiter + process.env.PATH, PORTABILITY_REAL_INSTALL: await commandPath('install')}});
  for (const [path, content] of Object.entries(files)) {
    assert.equal(await readFile(join(dest, path), 'utf8'), content, path);
    assert.equal((await stat(join(dest, path))).mode & 0o777, path.startsWith('bin/') ? 0o755 : 0o644, path);
  }
  assert.equal(await readFile(join(dest, 'VERSION'), 'utf8'), '0.0.1\n');
});

for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open']]) {
  test(platform + ' opener uses only the supplied PATH recording shim', {timeout: 5000}, async t => {
    const dir = await fixture(t), log = join(dir, 'opened.log');
    installBrowserShims(dir, log);
    const env = {...process.env, FARAVAN_NO_BROWSER: '0', PATH: dir};
    let closed;
    openUrl('https://example.invalid/synthetic', {platform, env, spawn: (cmd, args, options) => {
      assert.equal(cmd, command);
      // Check the env before starting any process: a regression must not launch a real opener.
      assert.equal(options.env, env);
      const child = spawn(cmd, args, options);
      closed = once(child, 'close');
      return child;
    }});
    assert.ok(closed, 'spawn was reached with the injected environment');
    let timer;
    try {
      await Promise.race([closed.then(([code]) => assert.equal(code, 0)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shim did not finish')), 3000); })]);
    } finally { clearTimeout(timer); }
    assert.equal((await readFile(log, 'utf8')).trim(), command + ' https://example.invalid/synthetic');
  });
}

test('every test inherits isolated Git config and synthetic identity, including child commits', async t => {
  const dir = await fixture(t), hostile = join(dir, 'hostile.gitconfig'), repo = join(dir, 'repo');
  await mkdir(repo);
  const contents = '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/synthetic-signing-program\n';
  await writeFile(hostile, contents);
  const env = {...process.env, GIT_CONFIG_GLOBAL: hostile, GIT_CONFIG_SYSTEM: hostile,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_PARAMETERS: "'commit.gpgsign=true'", GIT_AUTHOR_NAME: 'Wrong', GIT_COMMITTER_NAME: 'Wrong'};
  const isolated = isolateTestGitEnv({...env});
  assert.equal(isolated.GIT_CONFIG_GLOBAL, devNull);
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, '1');
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM'])
    assert.equal(isolated[key], undefined, key);
  const guard = new URL('./helpers/no-browser.mjs', import.meta.url).href;
  const program = [
    'import ' + JSON.stringify(guard) + ';',
    'import {execFileSync} from "node:child_process";',
    'const git = (...args) => execFileSync("git", args, {encoding: "utf8"}).trim();',
    'git("init", "-q"); git("commit", "--allow-empty", "-qm", "synthetic");',
    'console.log(git("show", "-s", "--format=%an <%ae>|%cn <%ce>"));',
  ].join('\n');
  const result = await exec(process.execPath, ['--input-type=module', '--eval', program], {cwd: repo, env});
  assert.equal(result.stdout.trim(), 'Test <test@example.test>|Test <test@example.test>');
  assert.equal(await readFile(hostile, 'utf8'), contents, 'no config file was changed');
});

test('untrusted binary PAX xattrs remain malformed instead of weakening archive validation', () => {
  for (const key of ['SCHILY.xattr.com.apple.provenance', 'LIBARCHIVE.xattr.com.apple.provenance']) {
    const body = Buffer.concat([Buffer.from(key + '='), Buffer.from([0xff]), Buffer.from('\n')]);
    let length = body.length + 2;
    while (length !== body.length + String(length).length + 1) length = body.length + String(length).length + 1;
    const record = Buffer.concat([Buffer.from(length + ' '), body]);
    const header = Buffer.alloc(512);
    header.write('pax'); header.write('x', 156);
    header.write(record.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    const archive = Buffer.concat([header, record, Buffer.alloc(512 - record.length), Buffer.alloc(1024)]);
    assert.throws(() => validateArchive(archive), {code: 'malformed', message: 'Invalid UTF-8 in tar metadata'}, key);
  }
});
