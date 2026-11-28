import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, symlink, readFile, rm, access, readdir, writeFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeAppleTools, MIN_MACOS } from './helpers/macos-app.mjs';
import { npmCacheEnv } from './helpers/npm-cache.mjs';
import { machOArchs, parsePlist } from '../packaging/macos/bundle-tool.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const have = async name => run('sh', ['-c', 'command -v ' + name]).then(() => true, () => false);
const skip = (await Promise.all(['go', 'tar', 'dpkg-deb'].map(have))).every(Boolean) ? false : 'needs go, tar and dpkg-deb';
const PREVIEW = '0.0.1-preview.20260101.1';
const exists = path => access(path).then(() => true, () => false);

async function assertRemovalHooksInControlArchive(deb, scratch, label) {
  const control = join(scratch, label);
  await mkdir(control, {recursive:true});
  await run('dpkg-deb', ['--control', deb, control]);
  const expected = await readFile(join(root, 'packaging/scripts/remove.sh'), 'utf8');
  for (const phase of ['prerm','postrm']) {
    const path = join(control, phase);
    const contents = await readFile(path, 'utf8');
    assert.equal(contents, expected, label + ' control archive ships the safe ' + phase + ' hook');
    assert.match(contents, /^#!\/bin\/sh\n/, label + ' ' + phase + ' has a shell interpreter');
    assert.equal((await stat(path)).mode & 0o777, 0o755, label + ' ' + phase + ' is executable');
  }
}

// Builds the real package tree, tarball and .deb with this machine's Node standing in for the pinned
// download (FARAVAN_NODE_BIN, the development override; the pinned download itself was run by hand), then
// starts the app from each with a PATH that contains no node at all.
test('the tarball and the .deb run with no system Node on PATH', {skip, timeout: 600000}, async t => {
  const work = await mkdtemp(join(tmpdir(), 'spk-d6-'));
  t.after(() => rm(work, {recursive: true, force: true}));
  await run('bash', [join(root, 'packaging/build.sh')], {cwd: root, maxBuffer: 1 << 26,
    env: {...process.env, ...npmCacheEnv(), PACKAGE_VERSION: PREVIEW, PACKAGE_DEB_TOOL: 'dpkg-deb', DEB_COMPRESSION: 'none', FARAVAN_NODE_BIN: process.execPath}});
  const tarball = join(root, `packaging/dist/faravan_${PREVIEW}_linux_amd64.tar.gz`), deb = join(root, `packaging/dist/faravan_${PREVIEW}_amd64.deb`);
  const control = (await run('dpkg-deb', ['-f', deb])).stdout;
  await assertRemovalHooksInControlArchive(deb, work, 'dpkg-deb-control');
  // A preview must sort below the release it leads to: tilde, not hyphen (see packaging/deb-version.sh).
  assert.match(control, /^Version: 1:0\.0\.1~preview\.20260101\.1-1$/m);
  assert.doesNotMatch(control, /^Depends:.*node/mi, 'the .deb does not depend on a system Node');
  assert.match(control, /^Depends: python3$/m, 'the installer must resolve the verification prerequisite');
  assert.match(control, /^Suggests: docker-sbx/m);

  if (await have('nfpm') || await have('docker')) {
    const upstream = (await run('bash', ['-c', '. "$1"; deb_upstream_version "$2"', '--',
      join(root, 'packaging/deb-version.sh'), PREVIEW])).stdout.trim();
    const fullVersion = (await run('bash', [join(root, 'packaging/deb-version.sh'), PREVIEW])).stdout.trim();
    const nfpmImage = (await readFile(join(root, 'packaging/nfpm.env'), 'utf8')).match(/^NFPM_IMAGE=(.+)$/m)[1];
    const nfpmDeb = join(work, 'faravan-nfpm.deb');
    if (await have('nfpm')) {
      await run('nfpm', ['package','--config','nfpm.yaml','--packager','deb','--target',nfpmDeb], {
        cwd:join(root, 'packaging'), maxBuffer:1 << 26,
        env:{...process.env, PACKAGE_VERSION:PREVIEW, PACKAGE_DEB_VERSION:upstream, PACKAGE_DEB_FULL_VERSION:fullVersion},
      });
    } else {
      const packageDir = join(root, 'packaging');
      await run('docker', ['run','--rm','--user',`${process.getuid()}:${process.getgid()}`,
        '-e',`PACKAGE_VERSION=${PREVIEW}`,'-e',`PACKAGE_DEB_VERSION=${upstream}`,'-e',`PACKAGE_DEB_FULL_VERSION=${fullVersion}`,
        '-v',`${packageDir}:/work`,'-w','/work',nfpmImage,
        'package','--config','nfpm.yaml','--packager','deb','--target','/work/dist/faravan-nfpm-test.deb'],
      {cwd:packageDir, maxBuffer:1 << 26});
      await run('cp', [join(packageDir, 'dist/faravan-nfpm-test.deb'), nfpmDeb]);
      await run('rm', ['-f', join(packageDir, 'dist/faravan-nfpm-test.deb')]);
    }
    await assertRemovalHooksInControlArchive(nfpmDeb, work, 'nfpm-control');
    for (const artifact of [deb, nfpmDeb]) {
      const fields = (await run('dpkg-deb', ['-f', artifact])).stdout;
      assert.ok(fields.includes('Package: faravan'));
      assert.ok(fields.includes('Replaces: faravan (<< '+fullVersion+')'));
      assert.ok(fields.includes('Breaks: faravan (<< '+fullVersion+')'));
      assert.ok(!fields.includes('$'+'{PACKAGE_DEB_FULL_VERSION}'));
    }
  }

  // Model installer-resolved prerequisites without adding system Node.
  const bin = join(work, 'bin');
  await mkdir(bin);
  for (const tool of ['sh', 'readlink', 'dirname', 'python3']) {
    const found = (await run('sh', ['-c', 'command -v ' + tool])).stdout.trim();
    await symlink(found, join(bin, tool));
  }
  const env = home => ({PATH: bin, HOME: home, FARAVAN_HOME: join(home, '.faravan'), FARAVAN_NO_BROWSER: '1'});
  await assert.rejects(run(join(bin, 'sh'), ['-c', 'command -v node'], {env: {PATH: bin}}), 'the test PATH really has no node');

  for (const kind of ['tarball', 'deb']) {
    const tree = join(work, kind);
    await mkdir(tree);
    if (kind === 'tarball') await run('tar', ['-xzf', tarball, '-C', tree]);
    else await run('dpkg-deb', ['-x', deb, tree]);
    assert.equal(await exists(join(tree, 'usr/lib/faravan/runtime/bin/node')), true, kind + ' carries the runtime');
    assert.equal(await exists(join(tree, 'usr/lib/faravan/lib/session-environment.sh')), true, kind + ' carries the shared Linux session list');
    assert.equal(await exists(join(tree, 'usr/lib/faravan/VERSION')), true);
    const launcher = join(tree, 'usr/bin/faravan'), home = join(work, 'home-' + kind);
    await mkdir(home);
    const help = await run(launcher, ['--help'], {env: env(home)});
    assert.match(help.stdout, /Usage: faravan/, kind + ': the launcher runs without node on PATH');

    // The app itself starts on the bundled runtime and answers an authenticated request.
    const child = spawn(launcher, ['app'], {env: env(home), stdio: ['ignore', 'pipe', 'pipe']});
    t.after(() => child.kill('SIGKILL'));
    const record = join(home, '.local/share/Faravan/v1/app.json');
    let info;
    for (let i = 0; i < 200 && !info; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      info = await readFile(record, 'utf8').then(JSON.parse, () => null);
    }
    assert.ok(info, kind + ': the app wrote its discovery record');
    const response = await fetch('http://127.0.0.1:' + info.port + '/api/status', {headers: {'x-faravan-session-token': info.token}});
    assert.equal(response.status, 200, kind + ': /api/status');
    assert.ok((await response.json()).state);
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    assert.ok(!(await readdir(home)).includes('node'), 'nothing was installed beside it');
  }
});

test('the bundled runtime is pinned and an unpinned or mismatched archive is refused', {skip}, async t => {
  const work = await mkdtemp(join(tmpdir(), 'spk-d6b-'));
  t.after(() => rm(work, {recursive: true, force: true}));
  const pins = await readFile(join(root, 'packaging/node-runtime.env'), 'utf8');
  for (const target of ['linux_x64', 'linux_arm64', 'darwin_arm64', 'darwin_x64', 'win_x64', 'win_arm64'])
    assert.match(pins, new RegExp('^NODE_SHA256_' + target + '=[0-9a-f]{64}$', 'm'), target + ' is pinned');
  const fake = join(work, 'node-v24.14.1-linux-x64.tar.xz');
  await run('sh', ['-c', 'echo not node > "$1"', 'sh', fake]);
  await assert.rejects(run('bash', [join(root, 'packaging/bundle-node.sh'), 'linux', 'x64', join(work, 'out')], {env: {...process.env, FARAVAN_NODE_TARBALL: fake}}),
    error => /does not match the pinned SHA-256/.test(error.stderr));
  assert.equal(await exists(join(work, 'out/runtime/bin/node')), false, 'nothing is written for a bad archive');
  await assert.rejects(run('bash', [join(root, 'packaging/bundle-node.sh'), 'linux', 'riscv', join(work, 'o2')]), error => /no pinned hash/.test(error.stderr));
});

const macSkip = process.platform === 'win32' ? 'requires POSIX shell tools' : false;
const launcherSource = join(root, 'packaging/macos/launcher/main.swift');

// Only compilers, iconutil and uname are simulated: the stand-ins write real Mach-O and icns headers for
// the architecture they are asked to build, so the bundle check in build-app.sh parses real bytes. Stage
// the real app and execute its real generated CLI wrapper; the local Node override is deliberately
// confined to these offline development tests. None of this proves native compilation.
async function macFixture(t, host) {
  const work = await mkdtemp(join(tmpdir(), 'spk-macos-'));
  t.after(() => rm(work, {recursive: true, force: true}));
  const tools = join(work, 'stub tools'), cwd = join(work, 'other cwd');
  await fakeAppleTools(tools);
  await mkdir(cwd);
  await writeFile(join(tools, 'uname'), '#!/bin/sh\ncase "$1" in -m) printf "%s\\n" "' + host + '";; -s) echo Linux;; *) exit 90;; esac\n', {mode: 0o755});
  const helper = new URL('./helpers/macos-app.mjs', import.meta.url).href;
  for (const tool of ['go', 'swiftc']) {
    await writeFile(join(tools, tool), `#!${process.execPath}
import { appendFileSync, writeFileSync, chmodSync } from 'node:fs';
import { machO } from ${JSON.stringify(helper)};
const args = process.argv.slice(2), env = process.env;
appendFileSync(env.MAC_BUILD_LOG, [${JSON.stringify(tool)}, process.cwd(), env.CGO_ENABLED ?? '', env.GOOS ?? '', env.GOARCH ?? '', env.MACOSX_DEPLOYMENT_TARGET ?? '', args.join(' ')].join('|') + '\\n');
const out = args[args.indexOf('-o') + 1];
if (!args.includes('-o') || !out) process.exit(91);
let arch;
if (${JSON.stringify(tool)} === 'go') arch = {arm64: 'arm64', amd64: 'x86_64'}[env.GOARCH];
else { const target = args[args.indexOf('-target') + 1] ?? ''; arch = target.split('-')[0]; if (!args.includes('-target')) process.exit(93); }
if (!['arm64', 'x86_64'].includes(arch)) process.exit(94);
// Do not mkdir: a relative output interpreted under tray must fail this test.
writeFileSync(out, machO(arch, out)); chmodSync(out, 0o755);
`, {mode: 0o755});
  }
  const env = {...process.env, ...npmCacheEnv(), PATH: tools + ':' + process.env.PATH, PACKAGE_VERSION: '0.0.1', FARAVAN_NODE_BIN: process.execPath, MAC_BUILD_LOG: join(work, 'compilers.log')};
  // The launcher source belongs to the launcher lane; until it lands, build with a placeholder source.
  if (!(await exists(launcherSource))) {
    env.FARAVAN_LAUNCHER_SWIFT = join(work, 'placeholder launcher.swift');
    await writeFile(env.FARAVAN_LAUNCHER_SWIFT, '// placeholder\n');
  }
  return {work, cwd, log: env.MAC_BUILD_LOG, env};
}

test('macOS bundles relative paths with spaces and launches with its bundled Node', {skip: macSkip, timeout: 120000}, async t => {
  for (const [host, arch, goarch] of [['arm64', 'arm64', 'arm64'], ['x86_64', 'x86_64', 'amd64']]) {
    await t.test(host, async t => {
      const f = await macFixture(t, host);
      const env = {...f.env};
      delete env.ARCH; // Exercise native detection rather than inheriting the caller's target.
      const built = await run('bash', [join(root, 'packaging/macos/build-app.sh'), 'relative output with spaces'],
        {cwd: f.cwd, env, maxBuffer: 1 << 24});
      const app = join(f.cwd, 'relative output with spaces/Faravan.app');
      const macos = join(app, 'Contents/MacOS');
      assert.deepEqual((await readdir(macos)).sort(), ['faravan', 'faravan-launch', 'faravan-process-identity', 'faravan-tray', 'faravan-update-exchange'], 'Contents/MacOS holds only code');
      const notify = join(app, 'Contents/Helpers/FaravanNotify.app/Contents');
      for (const path of [join(macos, 'faravan-launch'), join(macos, 'faravan-tray'), join(macos,'faravan-process-identity'), join(macos, 'faravan-update-exchange'), join(notify, 'MacOS/faravan-notify')])
        assert.deepEqual(machOArchs(await readFile(path)), {fat: false, archs: [arch]}, path);
      assert.equal(parsePlist(await readFile(join(notify, 'Info.plist'), 'utf8')).CFBundleIdentifier, 'com.faravan.app.notify');
      assert.equal((await readFile(join(app, 'Contents/Resources/Faravan.icns'))).toString('latin1', 0, 4), 'icns');
      const plist = parsePlist(await readFile(join(app, 'Contents/Info.plist'), 'utf8'));
      assert.equal(plist.CFBundleExecutable, 'faravan-launch'); assert.equal(plist.CFBundleShortVersionString, '0.0.1');
      const log = (await readFile(f.log, 'utf8')).trim().split('\n');
      assert.ok(log.some(line => line.startsWith('go|' + join(root, 'tray') + '|1|darwin|' + goarch + '|' + MIN_MACOS + '|')), log.join('\n'));
      const clang = log.filter(line => line.startsWith('clang|'));
      assert.equal(clang.length, 1);
      const [compiler, compilerCwd, target, output, source] = clang[0].split('|');
      assert.deepEqual([compiler, compilerCwd, target, source],
        ['clang', f.cwd, arch + '-apple-macos' + MIN_MACOS, join(root, 'packaging/macos/launcher/update-exchange.c')]);
      assert.match(relative(join(f.cwd, 'relative output with spaces'), output),
        /^\.Faravan\.build\.[A-Za-z0-9]+\/Faravan\.app\/Contents\/MacOS\/faravan-update-exchange$/,
        'the helper is compiled into the private bundle before promotion');
      assert.ok((await readFile(join(macos, 'faravan-update-exchange'))).includes(Buffer.from(arch + ':update-exchange.c')),
        'the compiler stand-in produced the named C helper, not another executable');
      const swift = log.filter(line => line.startsWith('swiftc|'));
      assert.equal(swift.length, 2, 'the launcher and the notification helper');
      for (const line of swift) assert.ok(line.includes('-target ' + arch + '-apple-macos' + MIN_MACOS), line);
      assert.ok(swift.some(line => line.includes('MacOS/faravan-launch')) && swift.some(line => line.includes('MacOS/faravan-notify')));
      assert.match(built.stdout + built.stderr, /DEVELOPMENT runtime/);
      assert.match(built.stdout, /unsigned/);

      const minimal = join(f.work, 'minimal path'), home = join(f.work, 'home');
      await mkdir(minimal);
      await mkdir(home);
      const dirname = (await run('sh', ['-c', 'command -v dirname'])).stdout.trim();
      await symlink(dirname, join(minimal, 'dirname'));
      await assert.rejects(run('/bin/sh', ['-c', 'command -v node'], {env: {PATH: minimal}}));
      const evidence = join(f.work, 'runtime.json'), probe = join(f.work, 'probe.cjs');
      await writeFile(probe, "require('node:fs').writeFileSync(process.env.MAC_RUNTIME_EVIDENCE, JSON.stringify({execPath: process.execPath, path: process.env.PATH, notify: process.env.FARAVAN_NOTIFY_HELPER}));\n");
      const help = await run(join(macos, 'faravan'), ['--help'], {
        cwd: f.cwd, env: {PATH: minimal, HOME: home, FARAVAN_HOME: join(home, '.faravan'),
          FARAVAN_NO_BROWSER: '1', NODE_OPTIONS: '--require="' + probe + '"', MAC_RUNTIME_EVIDENCE: evidence}});
      assert.match(help.stdout, /Usage: faravan/);
      const actual = JSON.parse(await readFile(evidence, 'utf8'));
      assert.equal(await realpath(actual.execPath), await realpath(join(app, 'Contents/Resources/faravan/runtime/bin/node')));
      assert.equal(actual.path, '/opt/homebrew/bin:/usr/local/bin:' + minimal,
        'both Homebrew paths precede, rather than replace, the inherited PATH');
      assert.equal(await realpath(actual.notify), await realpath(join(notify, 'MacOS/faravan-notify')), 'the tray finds the bundled notification helper');

      // Homebrew's cask `binary` stanza links the CLI into its bin directory. Follow an absolute link and a
      // relative chain, from a prefix with spaces, invoked by path and by name, still with no node on PATH.
      const readlinkTool = (await run('sh', ['-c', 'command -v readlink'])).stdout.trim();
      await symlink(readlinkTool, join(minimal, 'readlink'));
      const prefix = join(f.work, 'brew prefix'), bin = join(prefix, 'bin'), opt = join(prefix, 'opt dir');
      await mkdir(bin, {recursive: true}); await mkdir(opt);
      await symlink(join(macos, 'faravan'), join(opt, 'faravan abs'));
      await symlink('../opt dir/faravan abs', join(bin, 'faravan'));
      await symlink(join(macos, 'faravan'), join(bin, 'faravan-direct'));
      for (const [file, path] of [[join(bin, 'faravan'), minimal], [join(bin, 'faravan-direct'), minimal], ['faravan', bin + ':' + minimal]]) {
        await rm(evidence, {force: true});
        const linked = await run(file, ['--help'], {cwd: f.cwd, env: {PATH: path, HOME: home, FARAVAN_HOME: join(home, '.faravan'),
          FARAVAN_NO_BROWSER: '1', NODE_OPTIONS: '--require="' + probe + '"', MAC_RUNTIME_EVIDENCE: evidence}});
        assert.match(linked.stdout, /Usage: faravan/, file + ' through a symlink');
        const seen = JSON.parse(await readFile(evidence, 'utf8'));
        assert.equal(await realpath(seen.execPath), await realpath(join(app, 'Contents/Resources/faravan/runtime/bin/node')), file);
        assert.equal(await realpath(seen.notify), await realpath(join(notify, 'MacOS/faravan-notify')), file);
      }
    });
  }
});

test('macOS rejects cross architecture before touching an existing bundle', {skip: macSkip, timeout: 30000}, async t => {
  for (const [host, arch, native] of [['arm64', 'x64', 'arm64'], ['x86_64', 'arm64', 'x64']]) {
    await t.test(host, async t => {
      const f = await macFixture(t, host);
      const out = join(f.cwd, 'existing output'), app = join(out, 'Faravan.app');
      await mkdir(app, {recursive: true});
      const marker = join(app, 'keep-me');
      await writeFile(marker, 'previous working bundle');
      await assert.rejects(run('bash', [join(root, 'packaging/macos/build-app.sh'), 'existing output'],
        {cwd: f.cwd, env: {...f.env, ARCH: arch}}), error => {
          assert.equal(error.code, 2);
          assert.ok(error.stderr.includes('ARCH=' + arch + ' does not match native architecture ' + native));
          assert.match(error.stderr, /cross compilation is not supported/);
          return true;
        });
      assert.equal(await readFile(marker, 'utf8'), 'previous working bundle');
      assert.deepEqual(await readdir(app), ['keep-me'], 'staging did not start');
      assert.equal(await exists(f.log), false, 'neither compiler ran');
    });
  }
});

test('macOS refuses to build without the launcher source, before touching an existing bundle', {skip: macSkip, timeout: 30000}, async t => {
  const f = await macFixture(t, 'arm64');
  const app = join(f.cwd, 'out/Faravan.app');
  await mkdir(app, {recursive: true});
  await writeFile(join(app, 'keep-me'), 'previous');
  await assert.rejects(run('bash', [join(root, 'packaging/macos/build-app.sh'), 'out'],
    {cwd: f.cwd, env: {...f.env, FARAVAN_LAUNCHER_SWIFT: join(f.work, 'missing.swift')}}), error => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /launcher source .*missing\.swift.* not found/);
      return true;
    });
  assert.deepEqual(await readdir(app), ['keep-me']);
  assert.equal(await exists(f.log), false, 'no compiler ran');
});

test('a release build refuses the development Node runtime before touching an existing bundle', {skip: macSkip, timeout: 30000}, async t => {
  const f = await macFixture(t, 'arm64');
  const app = join(f.cwd, 'out/Faravan.app');
  await mkdir(app, {recursive: true});
  await writeFile(join(app, 'keep-me'), 'previous');
  const env = {...f.env, FARAVAN_RELEASE_BUILD: '1'};
  delete env.FARAVAN_LAUNCHER_SWIFT; // only the Node override is under test here
  if (!(await exists(launcherSource))) env.FARAVAN_LAUNCHER_SWIFT = f.env.FARAVAN_LAUNCHER_SWIFT;
  await assert.rejects(run('bash', [join(root, 'packaging/macos/build-app.sh'), 'out'], {cwd: f.cwd, env}), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /FARAVAN_(NODE_BIN|LAUNCHER_SWIFT) is a development override; FARAVAN_RELEASE_BUILD=1 refuses it/);
    return true;
  });
  assert.deepEqual(await readdir(app), ['keep-me']);
  assert.equal(await exists(f.log), false, 'no compiler ran');
});
