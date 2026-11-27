import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash, createPrivateKey, generateKeyPairSync, sign} from 'node:crypto';
import {buildSignedManifest} from '../packaging/sign-update.mjs';
import {UPDATE_PUBLIC_KEY} from '../lib/v1/update-key.mjs';

const execFile = promisify(execFileCallback);
const installer = fileURLToPath(new URL('../bin/faravan-install.sh', import.meta.url));

async function writeShim(dir, name, body) {
  const path = join(dir, name);
  await writeFile(path, '#!/bin/sh\n' + body + '\n');
  await chmod(path, 0o755);
}

// A throwaway Ed25519 release key, made at test time. No private key is committed.
function makeSigner() {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({type: 'pkcs8', format: 'pem'}),
    publicPem: publicKey.export({type: 'spki', format: 'pem'}),
  };
}

function signBytes(signer, bytes) {
  return sign(null, bytes, createPrivateKey(signer.privateKeyPem)).toString('base64') + '\n';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Writes update.json and update.json.sig for a release, signed by the test key. Options go to buildSignedManifest.
async function publishRelease(f, signer, options = {}) {
  const {bytes, signature} = buildSignedManifest({tarball: await readFile(f.tarball), version: '0.2.0',
    tarballUrl: 'faravan_linux_amd64.tar.gz', privateKeyPem: signer.privateKeyPem, ...options});
  await writeFile(join(f.release, 'update.json'), bytes);
  await writeFile(join(f.release, 'update.json.sig'), signature);
}

// Writes a release whose top-level deb object describes the test .deb.
async function publishWithDeb(f, signer, {channel = 'faravan'} = {}) {
  await publishRelease(f, signer, {deb: {archive: await readFile(f.deb), arch: 'x64', channel, file: 'faravan_amd64.deb'}});
}

// Writes a manifest exactly as given, signed by the test key, for entries buildSignedManifest would refuse to sign.
async function publishRaw(f, signer, manifest) {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(f.release, 'update.json'), bytes);
  await writeFile(join(f.release, 'update.json.sig'), signBytes(signer, bytes));
}

// Every file and directory under dir, with its bytes and mode, so a test can prove nothing changed.
async function snapshot(dir) {
  const out = {};
  const walk = async (path, rel) => {
    const st = await lstat(path).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      out[rel + '/'] = 'dir';
      for (const name of await readdir(path)) await walk(join(path, name), rel + '/' + name);
    } else if (st.isSymbolicLink()) out[rel] = 'link';
    else out[rel] = (await readFile(path)).toString('base64') + ':' + (st.mode & 0o777);
  };
  await walk(dir, '');
  return out;
}

const commands = f => readFile(f.commandLog, 'utf8').catch(() => '');

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faravan-install-safety-'));
  const home = join(root, 'home'), installRoot = join(home, '.local'), shimBin = join(root, 'shim-bin');
  const bundle = join(root, 'bundle'), runtime = join(bundle, 'usr/lib/faravan');
  const tarball = join(root, 'faravan.tar.gz'), deb = join(root, 'faravan.deb');
  const aptKeyring = join(root, 'apt-keyring.gpg');
  const packageState = join(root, 'package-state'), commandLog = join(root, 'commands.log');
  const aptCache = join(root, 'apt-cache');
  const preservedData = join(home, '.faravan', 'keys/member.key');
  const testArgsFile = join(root, 'stub-args.log');
  await mkdir(join(runtime, 'runtime/bin'), {recursive:true});
  await mkdir(join(runtime, 'bin'), {recursive:true});
  await mkdir(home, {recursive:true});
  await mkdir(shimBin);
  await mkdir(aptCache);
  await mkdir(join(root, 'system-keyrings'));
  await mkdir(join(root, 'system-sources'));
  if (options.existingData) {
    await mkdir(join(home, '.faravan/keys'), {recursive:true});
    await writeFile(preservedData, 'existing device key sentinel\n');
  }
  // A runtime that prints a version but cannot start the app: --version passes, the readiness check fails.
  await writeFile(join(runtime, 'runtime/bin/node'), [
    '#!/bin/sh',
    'if [ "${2:-}" = --readiness ] && [ "${TEST_FAIL_READINESS:-no}" != no ]; then exit 9; fi',
    'printf "%s\\n" "$1" >> "$TEST_ARGS_FILE.calls"',
    'if [ "${1:-}" = --input-type=module ]; then exit 0; fi',
    'printf "%s\\n" "$*" > "$TEST_ARGS_FILE"',
    'exit 0',
  ].join('\n'));
  await writeFile(join(runtime, 'bin/faravan'), '#!/bin/sh\nexit 0\n');
  await chmod(join(runtime, 'runtime/bin/node'), 0o755);
  await chmod(join(runtime, 'bin/faravan'), 0o755);
  if (options.tray) {
    await writeFile(join(runtime, 'faravan-tray'), '#!/bin/sh\nexit 0\n');
    await chmod(join(runtime, 'faravan-tray'), 0o755);
  }
  await execFile('tar', ['-czf', tarball, '-C', bundle, 'usr']);
  await writeFile(deb, 'fake deb bytes');
  await writeFile(aptKeyring, 'fake apt signing key bytes');
  // A signed release: the installer script carries this test's public key, and update.json/.sig are published beside the assets.
  const release = join(root, 'release'), signer = options.signer, scriptPath = join(root, 'faravan-install.sh');
  await mkdir(release);
  const realTar = (await execFile('sh', ['-c', 'command -v tar'])).stdout.trim();
  if (signer) {
    await writeFile(scriptPath, (await readFile(installer, 'utf8')).replace(/UPDATE_PUBLIC_KEY_PEM='[^']*'/, () => `UPDATE_PUBLIC_KEY_PEM='${signer.publicPem.trimEnd()}'`));
    const {bytes, signature} = buildSignedManifest({tarball: await readFile(tarball), version: '0.2.0',
      tarballUrl: 'faravan_linux_amd64.tar.gz', privateKeyPem: signer.privateKeyPem});
    await writeFile(join(release, 'update.json'), bytes);
    await writeFile(join(release, 'update.json.sig'), signature);
  } else await writeFile(scriptPath, await readFile(installer, 'utf8'));
  if (options.cachedDebArch) {
    await writeFile(join(aptCache, `faravan_${options.packageVersion}_${options.cachedDebArch}.deb`), 'cached old deb bytes');
  }

  if (options.oldRuntime) {
    const current = join(installRoot, 'lib/faravan');
    await mkdir(join(current, 'runtime/bin'), {recursive:true});
    await mkdir(join(current, 'bin'), {recursive:true});
    await writeFile(join(current, 'VERSION'), 'old-version');
    await writeFile(join(current, 'runtime/bin/node'), '#!/bin/sh\nexit 0\n');
    await chmod(join(current, 'runtime/bin/node'), 0o755);
    await writeFile(join(current, 'bin/faravan'), '#!/bin/sh\nexit 0\n');
  }
  await mkdir(join(installRoot, 'bin'), {recursive:true});
  const stub = join(installRoot, 'bin/faravan'), sentinel = join(root, 'dev-checkout-faravan');
  if (options.stubSymlink) {
    await writeFile(sentinel, `#!/bin/sh\nexec node "${installRoot}/lib/faravan/bin/faravan" "$@"\n`);
    await symlink(sentinel, stub);
  } else await writeFile(stub, `#!/bin/sh\nexec node "${installRoot}/lib/faravan/bin/faravan" "$@"\n`);
  if (options.packageVersion) await writeFile(packageState, `installed ${options.packageVersion}\n`);

  await writeShim(shimBin, 'curl', [
    'head=no', 'out=', 'url=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out=$2; shift 2; continue ;;',
    '    --max-filesize) shift 2; continue ;;',
    '    -*) case "$1" in *I*) head=yes ;; esac; shift ;;',
    '    *) url=$1; shift ;;',
    '  esac',
    'done',
    'case "$url" in',
    '  */update.json|*/update.json.sig)',
    '    [ "$head" = no ] && [ -f "$TEST_RELEASE_DIR/${url##*/}" ] && cp "$TEST_RELEASE_DIR/${url##*/}" "$out" ;;',
    '  */dists/stable/InRelease) [ "$head" = yes ] ;;',
    '  */faravan-archive-keyring.gpg) [ "$head" = no ] && cp "$TEST_APT_KEYRING" "$out" ;;',
    '  *faravan_amd64.deb)',
    '    [ "$head" = yes ] || { cp "$TEST_DEB" "$out"; exit $?; }',
    '    [ "$TEST_HAS_DEB" = yes ] ;;',
    '  *faravan_linux_amd64.tar.gz)',
    '    if [ "$head" = yes ]; then exit 0; fi',
    '    [ "$TEST_FAIL_TAR_DOWNLOAD" = no ] || exit 22',
    '    cp "$TEST_TARBALL" "$out" ;;',
    '  *) exit 22 ;;',
    'esac',
  ].join('\n'));
  await writeShim(shimBin, 'cp', [
    'if [ "${TEST_FAIL_CP:-}" = stage ]; then',
    '  case "$*" in *"$INSTALL_ROOT/lib/faravan.new"*) exit 1 ;; esac',
    'fi',
    'exec /bin/cp "$@"',
  ].join('\n'));
  // The installer stages the .deb with 'sudo install -m 0644 -o root'. Record the call, then install as this user.
  // A test can corrupt the staged copy after it is written, with TEST_CORRUPT_STAGED=yes.
  const realInstall = (await execFile('sh', ['-c', 'command -v install'])).stdout.trim();
  await writeShim(shimBin, 'install', [
    'printf "install %s\\n" "$*" >> "$TEST_COMMAND_LOG"',
    '[ "$3" = -o ] && set -- "$1" "$2" "$5" "$6"',
    '"' + realInstall + '" "$@" || exit $?',
    'for dst do :; done',
    'case "$dst" in *faravan.deb) [ "$TEST_CORRUPT_STAGED" = yes ] && printf x >> "$dst" ;; esac',
    'exit 0',
  ].join('\n'));
  await writeShim(shimBin, 'mv', [
    'src=', 'dst=',
    'for arg do', '  case "$arg" in -*) continue ;; esac', '  src=$dst; dst=$arg', 'done',
    'case "$src:$dst" in',
    '  "$INSTALL_ROOT/lib/faravan:$INSTALL_ROOT/lib/faravan.prev"|"$INSTALL_ROOT/lib/faravan.new:$INSTALL_ROOT/lib/faravan"|"$INSTALL_ROOT/lib/faravan.prev:$INSTALL_ROOT/lib/faravan"|"$INSTALL_ROOT/lib/faravan:$INSTALL_ROOT/lib/faravan.new")',
    '    case " $* " in *" -T "*|*" -Tn "*) ;; *) exit 93 ;; esac ;;',
    'esac',
    'case "${TEST_FAIL_MV:-}" in',
    '  current-to-prev) [ "$src" = "$INSTALL_ROOT/lib/faravan" ] && [ "$dst" = "$INSTALL_ROOT/lib/faravan.prev" ] && exit 1 ;;',
    '  new-to-current) [ "$src" = "$INSTALL_ROOT/lib/faravan.new" ] && [ "$dst" = "$INSTALL_ROOT/lib/faravan" ] && exit 1 ;;',
    '  stub-replace) [ "$dst" = "$INSTALL_ROOT/bin/faravan" ] && case "$src" in "$INSTALL_ROOT/bin/.faravan."*) exit 1 ;; esac ;;',
    'esac',
    '/bin/mv "$@" || exit $?',
    'if [ "${TEST_STUB_RECOVERY_DURING_SWAP:-no}" = yes ] && [ "$src" = "$INSTALL_ROOT/lib/faravan" ] && [ "$dst" = "$INSTALL_ROOT/lib/faravan.prev" ]; then',
    '  "$INSTALL_ROOT/bin/faravan" --probe >/dev/null 2>&1 || exit 92',
    'fi',
    'exit 0',
  ].join('\n'));
  // Records every extraction, then runs the real tar, so a test can prove that nothing was unpacked.
  await writeShim(shimBin, 'tar', ['printf "tar %s\\n" "$*" >> "$TEST_COMMAND_LOG"', `exec "${realTar}" "$@"`].join('\n'));
  await writeShim(shimBin, 'sudo', 'exec "$@"');
  await writeShim(shimBin, 'dpkg', [
    'printf "dpkg %s\\n" "$*" >> "$TEST_COMMAND_LOG"',
    'case "$1" in',
    '  --print-architecture) printf "%s\\n" "$TEST_ARCH"; exit 0 ;;',
    '  -i)',
    '    case "$2" in "$FARAVAN_APT_CACHE_DIR"/*) [ "$TEST_ALLOW_CACHED_RESTORE" = yes ] || exit 1; printf "installed %s\\n" "$TEST_OLD_VERSION" > "$TEST_PACKAGE_STATE"; exit 0 ;; esac',
    '    printf "half-configured 99.0.0\\n" > "$TEST_PACKAGE_STATE"; exit 1 ;;',
    '  -r|--remove) [ "$TEST_FAIL_DPKG_REMOVE" = no ] || exit 1; rm -f "$TEST_PACKAGE_STATE"; exit 0 ;;',
    '  --purge) rm -f "$TEST_PACKAGE_STATE"; exit 0 ;;',
    'esac', 'exit 0',
  ].join('\n'));
  await writeShim(shimBin, 'dpkg-query', [
    'state=$(cat "$TEST_PACKAGE_STATE" 2>/dev/null || true)',
    'status=${state%% *}', 'version=${state#* }',
    'case "$*" in',
    '  *Status-Status*Version*) [ -n "$status" ] && printf "%s\\t%s\\n" "$status" "$version" ;;',
    '  *Status-Status*) [ -n "$status" ] && printf "%s" "$status" ;;',
    'esac',
  ].join('\n'));
  await writeShim(shimBin, 'apt-get', [
    'printf "apt-get %s\\n" "$*" >> "$TEST_COMMAND_LOG"',
    'case "$*" in',
    '  *"faravan="*) [ "$TEST_FAIL_APT_RESTORE" = no ] || exit 1; printf "installed %s\\n" "$TEST_OLD_VERSION" > "$TEST_PACKAGE_STATE"; exit 0 ;;',
    'esac', '[ "$TEST_APT_SUCCESS" = yes ] && exit 0', 'exit 1',
  ].join('\n'));
  // Like gpg --with-colons: one primary key record, then its fingerprint.
  await writeShim(shimBin, 'gpg', 'printf "pub:u:4096:1:0000000000000000:0:::u:::scESC:::::::::0:\\nfpr:::::::::TESTAPTKEYFINGERPRINT000000000000000000000000:\\n"');
  // The apt package's launcher, which the installer starts once for its readiness check.
  await writeShim(shimBin, 'packaged-faravan', '[ "$1" = --readiness ]');
  await writeShim(shimBin, 'dpkg-deb', [
    'case "$3" in',
    '  Package) printf "faravan\\n" ;;',
    '  Version) printf "%s\\n" "$TEST_OLD_VERSION" ;;',
    '  Architecture) printf "%s\\n" "$TEST_ARCH" ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'));

  const env = {...process.env, PATH:shimBin + ':' + process.env.PATH, HOME:home, FARAVAN_CHANNEL:'stable',
    INSTALL_ROOT:installRoot, FARAVAN_INSTALL_ROOT:installRoot,
    FARAVAN_DOWNLOAD_BASE:'https://release.example.test', FARAVAN_RELEASE_API:'https://api.example.test/release',
    FARAVAN_APT_KEY_FPR:'REPLACE_WITH_ARCHIVE_KEY_FINGERPRINT', FARAVAN_NO_TRAY_LAUNCH:'1',
    FARAVAN_PACKAGED_BIN:join(shimBin, 'packaged-faravan'),
    FARAVAN_APT_KEYRING:join(root, 'system-keyrings/faravan.gpg'),
    FARAVAN_APT_SOURCES:join(root, 'system-sources/faravan.sources'),
    TEST_APT_KEYRING:aptKeyring, TEST_APT_SUCCESS:options.aptSuccess ? 'yes' : 'no',
    TEST_TARBALL:tarball, TEST_DEB:deb, TEST_HAS_DEB:options.hasDeb ? 'yes' : 'no',
    TEST_FAIL_TAR_DOWNLOAD:options.failTarDownload ? 'yes' : 'no', TEST_FAIL_READINESS:options.failReadiness ? 'yes' : 'no',
    TEST_FAIL_DPKG_REMOVE:options.failDpkgRemove ? 'yes' : 'no',
    TEST_FAIL_APT_RESTORE:options.failAptRestore ? 'yes' : 'no',
    TEST_ALLOW_CACHED_RESTORE:options.cachedDebArch ? 'yes' : 'no',
    TEST_FAIL_MV:options.failMv ?? '', TEST_FAIL_CP:options.failCp ?? '',
    TEST_STUB_RECOVERY_DURING_SWAP:options.stubRecoveryDuringSwap ? 'yes' : 'no',
    FARAVAN_APT_CACHE_DIR:aptCache, TEST_PACKAGE_STATE:packageState, TEST_OLD_VERSION:options.packageVersion ?? '',
    TEST_ARCH:options.packageArch ?? 'amd64', TEST_COMMAND_LOG:commandLog,
    TEST_RELEASE_DIR:release,
    TEST_ARGS_FILE:testArgsFile};
  // Unsigned fixtures opt in to the warned-about bypass; signed ones must pass verification.
  if (signer) delete env.FARAVAN_ALLOW_UNVERIFIED;
  else env.FARAVAN_ALLOW_UNVERIFIED = '1';
  const install = () => execFile('sh', [scriptPath], {env, maxBuffer:1024 * 1024})
    .then(result => ({code:0, stdout:result.stdout, stderr:result.stderr}), error => ({code:error.code ?? 1, stdout:error.stdout ?? '', stderr:error.stderr ?? ''}));
  return {root, installRoot, packageState, commandLog, sentinel, stub, testArgsFile, preservedData, env, install,
    tarball, deb, release, signer};
}

test('portable install atomically replaces a symlink stub without changing its target', async t => {
  const f = await setup(t, {stubSymlink:true, signer:makeSigner()});
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(await readFile(f.sentinel, 'utf8'), /exec node .*\/lib\/faravan\/bin\/faravan/);
  assert.equal((await lstat(f.stub)).isFile(), true);
  assert.equal((await lstat(f.stub)).isSymbolicLink(), false);
  assert.equal((await lstat(f.stub)).mode & 0o777, 0o755);
  await execFile('sh', [f.stub, '--probe'], {env:f.env});
  assert.equal(await readFile(f.testArgsFile, 'utf8'), join(f.installRoot, 'lib/faravan/bin/faravan') + ' --probe\n');
  const faravanStub = join(f.installRoot, 'bin', 'faravan');
  assert.equal((await lstat(faravanStub)).mode & 0o777, 0o755, 'the portable install adds the Faravan command');
  await execFile('sh', [faravanStub, '--probe'], {env:f.env});
  assert.equal(await readFile(f.testArgsFile, 'utf8'), join(f.installRoot, 'lib/faravan/bin/faravan') + ' --probe\n',
    'the Faravan command keeps the old command path and arguments');
  assert.equal(await readFile(join(f.installRoot, 'lib/faravan/.installed-via'), 'utf8'), 'tarball\n');
  await assert.rejects(lstat(join(f.installRoot, 'lib/faravan.prev')));
});

test('portable install completes without SHELL and adds its PATH block', async t => {
  const f = await setup(t, {signer:makeSigner()});
  delete f.env.SHELL;
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Ready\. Start the guided onboarding flow with: faravan/);
  assert.match(await readFile(join(f.env.HOME, '.profile'), 'utf8'), /# Faravan command path/);
  assert.match(await readFile(join(f.env.HOME, '.profile'), 'utf8'), /\.local\/bin/);
});

test('apt handoff removes this tarball install and keeps a foreign launcher', async t => {
  const f = await setup(t, {tray:true, aptSuccess:true});
  const first = await f.install();
  assert.equal(first.code, 0, first.stdout + first.stderr);
  f.env.FARAVAN_APT_KEY_FPR = 'TESTAPTKEYFINGERPRINT000000000000000000000000';
  const second = await f.install();
  assert.equal(second.code, 0, second.stdout + second.stderr);
  await assert.rejects(lstat(join(f.installRoot, 'bin/faravan')));
  await assert.rejects(lstat(join(f.installRoot, 'lib/faravan')));

  const foreign = await setup(t, {aptSuccess:true});
  await mkdir(foreign.installRoot, {recursive:true});
  await mkdir(join(foreign.installRoot, 'bin'), {recursive:true});
  const foreignLauncher = join(foreign.installRoot, 'bin/faravan');
  await writeFile(foreignLauncher, '#!/bin/sh\necho foreign\n');
  foreign.env.FARAVAN_APT_KEY_FPR = 'TESTAPTKEYFINGERPRINT000000000000000000000000';
  const aptResult = await foreign.install();
  assert.equal(aptResult.code, 0, aptResult.stdout + aptResult.stderr);
  assert.equal(await readFile(foreignLauncher, 'utf8'), '#!/bin/sh\necho foreign\n');
});

test('failed apt install preserves repository files that existed before this run', async t => {
  const f = await setup(t);
  const keyring = f.env.FARAVAN_APT_KEYRING;
  const sources = f.env.FARAVAN_APT_SOURCES;
  await mkdir(join(f.root, 'system-keyrings'), {recursive:true});
  await mkdir(join(f.root, 'system-sources'), {recursive:true});
  await writeFile(keyring, 'existing keyring sentinel');
  await writeFile(sources, 'existing sources sentinel');
  f.env.FARAVAN_APT_KEY_FPR = 'TESTAPTKEYFINGERPRINT000000000000000000000000';
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(keyring, 'utf8'), 'existing keyring sentinel');
  assert.equal(await readFile(sources, 'utf8'), 'existing sources sentinel');
});

test('installer rejects install roots with spaces before writing broken desktop Exec lines', async t => {
  const f = await setup(t, {tray:true});
  const installRoot = join(f.root, 'home with space', '.local');
  f.env.INSTALL_ROOT = installRoot;
  f.env.FARAVAN_INSTALL_ROOT = installRoot;
  const result = await f.install();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /FARAVAN_INSTALL_ROOT cannot contain spaces or shell metacharacters/);
});

test('the install check starts the new app (readiness), not only a version print, before it keeps the runtime', async t => {
  const f = await setup(t, {oldRuntime:true});
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(f.testArgsFile, 'utf8'), join(f.installRoot, 'lib/faravan/bin/faravan') + ' --readiness\n');
  assert.equal(await readFile(f.testArgsFile + '.calls', 'utf8'), join(f.installRoot, 'lib/faravan/bin/faravan') + '\n--input-type=module\n',
    'the real app readiness check precedes the optional install report');
  await assert.rejects(lstat(join(f.installRoot, 'lib/faravan.prev')));
});

test('a failed PATH update does not record a successful portable install', async t => {
  const f = await setup(t);
  f.env.SHELL = '/bin/sh';
  await mkdir(join(f.env.HOME, '.profile'));
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the PATH update failed');
  assert.match(result.stderr, /could not add .* to your shell profile/);
  assert.equal(await readFile(f.testArgsFile + '.calls', 'utf8'), join(f.installRoot, 'lib/faravan/bin/faravan') + '\n',
    'the failed install ran readiness but did not write an ok report');
});

test('portable install clears stale staging and backup directories before the swap', async t => {
  const f = await setup(t, {oldRuntime:true});
  const staleNew = join(f.installRoot, 'lib/faravan.new'), stalePrev = join(f.installRoot, 'lib/faravan.prev');
  await mkdir(staleNew, {recursive:true});
  await writeFile(join(staleNew, 'VERSION'), 'stale-new');
  await mkdir(stalePrev, {recursive:true});
  await writeFile(join(stalePrev, 'VERSION'), 'stale-prev');

  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(f.installRoot, 'lib/faravan/.installed-via'), 'utf8'), 'tarball\n');
  await assert.rejects(lstat(join(f.installRoot, 'lib/faravan/faravan')));
  await assert.rejects(lstat(staleNew));
  await assert.rejects(lstat(stalePrev));
});

for (const [name, launcherFor] of [
  ['friend-preview launcher', home => `#!/bin/sh\nexport FARAVAN_HOME="$HOME/.faravan-friend-preview"\nexport FARAVAN_COORDINATOR_HOME="$FARAVAN_HOME/coordinator"\nexec "$HOME/.local/share/faravan-friend-preview/usr/bin/faravan" "$@"\n`],
  ['versioned runtime launcher', root => `#!/bin/sh\nROOT="${root}"\nT="$ROOT/lib/faravan/current"\n[ -x "$T/runtime/bin/node" ] || T="$ROOT/lib/faravan"\nexec "$T/runtime/bin/node" "$T/bin/faravan" "$@"\n`],
]) {
  test(`portable install replaces its earlier ${name}`, async t => {
    const f = await setup(t);
    await writeFile(f.stub, launcherFor(f.installRoot), {mode:0o755});
    const result = await f.install();
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(await readFile(f.stub, 'utf8'), /lib\/faravan\/runtime\/bin\/node/);
  });
}

test('portable install refuses a foreign launcher but rejects shell-metacharacter roots first', async t => {
  const f = await setup(t);
  await writeFile(f.stub, '#!/bin/sh\necho another program\n', {mode:0o755});
  const foreign = await f.install();
  assert.notEqual(foreign.code, 0);
  assert.match(foreign.stderr, /is not this install's launcher/);
  f.env.FARAVAN_INSTALL_ROOT = `${f.root}/bad;touch${f.root}/unexpected`;
  const unsafe = await f.install();
  assert.notEqual(unsafe.code, 0);
  assert.match(unsafe.stderr, /FARAVAN_INSTALL_ROOT cannot contain spaces or shell metacharacters/);
});

test('installer keeps separate PATH blocks for separate install roots', async t => {
  const f = await setup(t);
  f.env.SHELL = '/bin/sh';
  const profile = join(f.env.HOME, '.profile');
  await writeFile(profile, '# Faravan command path\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n');
  const customRoot = join(f.env.HOME, 'custom-root');
  f.env.FARAVAN_INSTALL_ROOT = customRoot;
  f.env.INSTALL_ROOT = customRoot;
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const installedLauncher = await readFile(join(customRoot, 'bin', 'faravan'), 'utf8');
  assert.match(installedLauncher, /mv -Tn .*faravan\.prev/);
  assert.match(installedLauncher, /could not restore the previous runtime safely/);
  const contents = await readFile(profile, 'utf8');
  assert.match(contents, /\$HOME\/\.local\/bin/);
  assert.match(contents, new RegExp(customRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/bin'));
  assert.equal((contents.match(/# Faravan command path/g) ?? []).length, 2);
});

test('installer preserves foreign desktop files with its application names', async t => {
  const f = await setup(t, {tray:true});
  const appsDir = join(f.root, 'xdg-data/applications');
  const autostartDir = join(f.root, 'xdg-config/autostart');
  const handler = join(appsDir, 'faravan-open-link.desktop');
  const autostart = join(autostartDir, 'faravan-tray.desktop');
  await mkdir(appsDir, {recursive:true});
  await mkdir(autostartDir, {recursive:true});
  await writeFile(handler, '[Desktop Entry]\nName=Foreign handler\n');
  await writeFile(autostart, '[Desktop Entry]\nName=Foreign tray\n');
  f.env.XDG_DATA_HOME = join(f.root, 'xdg-data');
  f.env.XDG_CONFIG_HOME = join(f.root, 'xdg-config');
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(handler, 'utf8'), '[Desktop Entry]\nName=Foreign handler\n');
  assert.equal(await readFile(autostart, 'utf8'), '[Desktop Entry]\nName=Foreign tray\n');
});

test('Windows packaging checks each native build and requires faravan.exe before MSIX staging', async () => {
  const layoutScript = await readFile(fileURLToPath(new URL('../packaging/windows/build-layout.ps1', import.meta.url)), 'utf8');
  const msixScript = await readFile(fileURLToPath(new URL('../packaging/windows/build-msix.ps1', import.meta.url)), 'utf8');
  assert.equal((layoutScript.match(/\$LASTEXITCODE -ne 0/g) ?? []).length, 5);
  assert.match(layoutScript, /throw "Resident launcher build failed with exit code \$LASTEXITCODE"/);
  assert.match(msixScript, /'faravan-tray\.exe', 'faravan\.exe'/);
  assert.doesNotMatch(msixScript, /Copy-Item[^\n]*SilentlyContinue/);
  assert.match(msixScript, /default Faravan\.Faravan/);
});

test('Windows layout resolves a relative output before changing directories', async () => {
  const source = await readFile(fileURLToPath(new URL('../packaging/windows/build-layout.ps1', import.meta.url)), 'utf8');
  assert.match(source, /\$Out = \$ExecutionContext\.SessionState\.Path\.GetUnresolvedProviderPathFromPSPath\(\$Out\)/);
  assert.match(source, /\$layout = Join-Path \$Out 'Faravan'/);
  assert.ok(source.indexOf('GetUnresolvedProviderPathFromPSPath($Out)') < source.indexOf("$layout = Join-Path $Out 'Faravan'"));
  assert.ok(source.indexOf('GetUnresolvedProviderPathFromPSPath($Out)') < source.indexOf('Push-Location'));
});

test('desktop launchers are staged beside their targets before replacement', async () => {
  const source = await readFile(installer, 'utf8');
  assert.match(source, /desktop_tmp="\$\(mktemp "\$apps_dir\/\.faravan-open-link\.XXXXXX"\)"/);
  assert.match(source, /desktop_tmp="\$\(mktemp "\$autostart_dir\/\.faravan-tray\.XXXXXX"\)"/);
  assert.match(source, /mv -fT "\$desktop_tmp" "\$desktop"/);
});

test('stub recovery during the rename window aborts instead of nesting the new runtime', async t => {
  const f = await setup(t, {oldRuntime:true, stubRecoveryDuringSwap:true});
  await writeFile(f.stub, [
    '#!/bin/sh',
    'if [ ! -d "$INSTALL_ROOT/lib/faravan" ] && [ -d "$INSTALL_ROOT/lib/faravan.prev" ]; then mv -T "$INSTALL_ROOT/lib/faravan.prev" "$INSTALL_ROOT/lib/faravan"; fi',
    'exec "$INSTALL_ROOT/lib/faravan/runtime/bin/node" "$INSTALL_ROOT/lib/faravan/bin/faravan" "$@"',
    '',
  ].join('\n'), {mode:0o755});
  await chmod(f.stub, 0o755);

  const result = await f.install();
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /previous runtime remains in place/);
  assert.equal(await readFile(join(f.installRoot, 'lib/faravan/VERSION'), 'utf8'), 'old-version');
  await assert.rejects(lstat(join(f.installRoot, 'lib/faravan.prev')));
  await assert.rejects(lstat(join(f.installRoot, 'lib/faravan.new')));
  await assert.rejects(lstat(join(f.installRoot, 'lib/faravan/faravan')));
});

for (const failure of [
  {name:'staging copy', options:{failCp:'stage'}, message:/could not stage the new runtime/},
  {name:'current-to-backup rename', options:{failMv:'current-to-prev'}, message:/previous runtime remains in place/},
  {name:'new-runtime rename', options:{failMv:'new-to-current'}, message:/previous runtime was restored/},
  {name:'readiness check', options:{failReadiness:true}, message:/previous runtime was restored/},
  {name:'stub replacement', options:{failMv:'stub-replace'}, message:/previous runtime was restored/},
]) {
  test(`portable install preserves the old runtime after ${failure.name} fails`, async t => {
    const f = await setup(t, {oldRuntime:true, ...failure.options});
    const result = await f.install();
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stderr, failure.message);
    assert.equal(await readFile(join(f.installRoot, 'lib/faravan/VERSION'), 'utf8'), 'old-version');
    await assert.rejects(lstat(join(f.installRoot, 'lib/faravan.prev')));
    await assert.rejects(lstat(join(f.installRoot, 'lib/faravan.new')));
  });
}

test('failed Debian upgrade and failed tarball fallback retain the installed version', async t => {
  const f = await setup(t, {hasDeb:true, packageVersion:'1.2.3', failTarDownload:true});
  const result = await f.install();
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /could not download the portable bundle/);
  assert.equal(await readFile(f.packageState, 'utf8'), 'installed 1.2.3\n');
  const calls = await readFile(f.commandLog, 'utf8');
  assert.match(calls, /dpkg -i/);
  assert.match(calls, /apt-get install -y --reinstall --no-download --allow-downgrades faravan=1\.2\.3/);
  assert.doesNotMatch(calls, /dpkg --purge/);
});

test('failed apt restoration selects a cached Debian package for the host architecture', async t => {
  const f = await setup(t, {hasDeb:true, packageVersion:'1.2.3', packageArch:'arm64', cachedDebArch:'arm64', failAptRestore:true, failTarDownload:true});
  const result = await f.install();
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(f.packageState, 'utf8'), 'installed 1.2.3\n');
  const calls = await readFile(f.commandLog, 'utf8');
  assert.match(calls, /dpkg --print-architecture/);
  assert.match(calls, /dpkg -i .*faravan_1\.2\.3_arm64\.deb/);
  assert.doesNotMatch(calls, /faravan_1\.2\.3_amd64\.deb/);
});

test('a failed first-time Debian install removes only its partial package state without purging data', async t => {
  const f = await setup(t, {hasDeb:true, failTarDownload:true, existingData:true});
  const result = await f.install();
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  await assert.rejects(readFile(f.packageState, 'utf8'));
  const calls = await readFile(f.commandLog, 'utf8');
  assert.match(calls, /dpkg -i/);
  assert.match(calls, /dpkg --remove faravan/);
  assert.doesNotMatch(calls, /dpkg --purge/);
  assert.equal(await readFile(f.preservedData, 'utf8'), 'existing device key sentinel\n');
});

test('portable fallback stops if dpkg cannot remove a failed first install', async t => {
  const f = await setup(t, {hasDeb:true, failTarDownload:true, failDpkgRemove:true});
  const result = await f.install();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /user data was not purged and portable fallback was stopped/);
  const calls = await readFile(f.commandLog, 'utf8');
  assert.match(calls, /dpkg --remove faravan/);
  assert.doesNotMatch(calls, /dpkg --purge/);
});

test('actual portable installer registers both schemes with no inherited legacy variable', async t => {
  const f = await setup(t);
  delete f.env.faravan_bin;
  f.env.XDG_DATA_HOME = join(f.root, 'xdg-data');
  f.env.XDG_CONFIG_HOME = join(f.root, 'xdg-config');
  await writeShim(join(f.root,'shim-bin'),'xdg-mime','exit 0');
  await writeShim(join(f.root,'shim-bin'),'update-desktop-database','exit 0');
  const result = await f.install();
  assert.equal(result.code,0,'installer must succeed without inherited variable');
  const desktop = await readFile(join(f.env.XDG_DATA_HOME,'applications/faravan-open-link.desktop'),'utf8');
  assert.ok(desktop.includes('Exec='+f.stub+' open-link %u'));
  assert.match(desktop,/x-scheme-handler\/faravan/);
  assert.match(desktop,/x-scheme-handler\/faravan/);
});

// Fail closed: a download that does not match the signed manifest, or a manifest that is not signed by the
// embedded key, stops the install before anything is unpacked (tar) or installed (dpkg), and changes nothing.
for (const [name, tamper] of [
  ['the tarball bytes differ from the signed manifest', async f => {
    // A valid tarball with one more file: the signature covers the old bytes, so the installer must not unpack it.
    await writeFile(join(f.root, 'bundle/usr/lib/faravan/EVIL'), 'swapped after signing\n');
    await execFile('tar', ['-czf', f.tarball, '-C', join(f.root, 'bundle'), 'usr']);
  }],
  ['the release has no signature', async f => rm(join(f.release, 'update.json.sig'))],
  ['the signature was made by another key', async f => writeFile(join(f.release, 'update.json.sig'),
    signBytes(makeSigner(), await readFile(join(f.release, 'update.json'))))],
]) {
  test(`a portable install is refused when ${name}`, {timeout: 60000}, async t => {
    const f = await setup(t, {signer: makeSigner()});
    await tamper(f);
    const before = await snapshot(f.env.HOME);
    const result = await f.install();
    assert.notEqual(result.code, 0, 'the install must fail');
    assert.match(result.stdout + result.stderr, /nothing was installed/);
    assert.doesNotMatch(await commands(f), /^(tar|dpkg) /m, 'nothing is extracted or installed');
    assert.deepEqual(await snapshot(f.env.HOME), before, 'the install root and home are unchanged');
  });
}

test('a signed portable release installs after its tarball matches the signed manifest', {timeout: 60000}, async t => {
  const f = await setup(t, {signer: makeSigner()});
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Verified the tarball against the release's signed manifest/);
  assert.match(await commands(f), /^tar -xzf /m);
  assert.equal(await readFile(join(f.installRoot, 'lib/faravan/.installed-via'), 'utf8'), 'tarball\n');
});

test('FARAVAN_ALLOW_UNVERIFIED=1 installs an unsigned release, with a warning', {timeout: 60000}, async t => {
  const f = await setup(t);
  const result = await f.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(f.env.FARAVAN_ALLOW_UNVERIFIED, '1');
  assert.match(result.stderr, /FARAVAN_ALLOW_UNVERIFIED=1: installing the tarball without checking its signature/);
});

test('a .deb is refused when its bytes differ from the signed linux deb entry', {timeout: 60000}, async t => {
  const signer = makeSigner();
  const f = await setup(t, {signer, hasDeb: true});
  await publishWithDeb(f, signer);
  await writeFile(f.deb, 'a different package\n');
  const before = await snapshot(f.env.HOME);
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the install must fail');
  assert.match(result.stdout + result.stderr, /nothing was installed/);
  assert.doesNotMatch(await commands(f), /^(tar|dpkg) /m, 'dpkg never runs on bytes the manifest does not sign');
  assert.deepEqual(await snapshot(f.env.HOME), before);
});

test('a .deb is refused when the only linux entry in the signed manifest is the tarball', {timeout: 60000}, async t => {
  const signer = makeSigner();
  const f = await setup(t, {signer, hasDeb: true});
  const tarball = await readFile(f.tarball);
  const {bytes, signature} = buildSignedManifest({tarball, version: '0.2.0', tarballUrl: 'https://release.example.test/faravan_linux_amd64.tar.gz',
    privateKeyPem: signer.privateKeyPem, assets: [{archive: tarball, platform: 'linux', arch: 'x64', kind: 'tarball', channel: 'faravan',
      url: 'https://release.example.test/faravan_linux_amd64.tar.gz'}]});
  await writeFile(join(f.release, 'update.json'), bytes);
  await writeFile(join(f.release, 'update.json.sig'), signature);
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the install must fail');
  assert.match(result.stdout + result.stderr, /no linux \.deb entry/);
  assert.doesNotMatch(await commands(f), /^dpkg /m, 'dpkg never runs for a tarball-only manifest');
});

test('a .deb is refused when its signed linux deb entry is for another channel', {timeout: 60000}, async t => {
  const signer = makeSigner();
  const f = await setup(t, {signer, hasDeb: true});
  await publishWithDeb(f, signer, {channel: 'other-product'});
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the install must fail');
  assert.match(result.stdout + result.stderr, /no linux \.deb entry/);
  assert.doesNotMatch(await commands(f), /^dpkg /m);
});

test('a .deb whose bytes match its signed linux deb entry is verified before dpkg runs', {timeout: 60000}, async t => {
  const signer = makeSigner();
  const f = await setup(t, {signer, hasDeb: true});
  await publishWithDeb(f, signer);
  const result = await f.install();
  // The fake dpkg fails, so the installer falls back to the (also signed) tarball; the order of the two steps is what is tested.
  assert.match(result.stdout, /Verified the deb against the release's signed manifest/);
  assert.match(await commands(f), /^dpkg -i .*faravan\.deb$/m);
  assert.match(result.stdout + result.stderr, /using the portable bundle instead/);
});

test('a .deb is refused when the signed manifest has no linux deb entry, and does not fall back to the tarball', {timeout: 60000}, async t => {
  const f = await setup(t, {signer: makeSigner(), hasDeb: true});
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the install must fail');
  assert.match(result.stdout + result.stderr, /no linux \.deb entry/);
  assert.doesNotMatch(await commands(f), /^(tar|dpkg) /m);
});

test('the installer embeds the release public key that lib/v1/update-key.mjs exports', async () => {
  const embedded = (await readFile(installer, 'utf8')).match(/^UPDATE_PUBLIC_KEY_PEM='([^']*)'/m);
  assert.ok(embedded, 'bin/faravan-install.sh must define UPDATE_PUBLIC_KEY_PEM');
  assert.equal(embedded[1] + '\n', UPDATE_PUBLIC_KEY);
});

test('every installer curl call bounds its response with --max-filesize', async () => {
  const calls = (await readFile(installer, 'utf8')).split('\n').filter(line => /(^|[\s;(|&])curl -/.test(line));
  assert.ok(calls.length >= 4, 'the test must see the installer curl calls');
  for (const line of calls) assert.match(line, /--max-filesize /, line);
});

// Refused means: no tar or dpkg ran, and the install root and home are exactly as they were.
async function assertRefused(f, pattern) {
  const before = await snapshot(f.env.HOME);
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the install must fail');
  assert.match(result.stdout + result.stderr, /nothing was installed/);
  assert.match(result.stdout + result.stderr, pattern);
  assert.doesNotMatch(await commands(f), /^(tar|dpkg) /m, 'nothing is extracted or installed');
  assert.deepEqual(await snapshot(f.env.HOME), before, 'the install root and home are unchanged');
}

// A signed manifest is not enough: the installer also refuses a stable release that is a preview, or older than
// its minimum version, so an old signed release cannot be replayed to a user.
test('a validly signed preview manifest is refused by the stable installer', {timeout: 60000}, async t => {
  const f = await setup(t, {signer: makeSigner()});
  await publishRelease(f, f.signer, {version: '0.2.1-preview.20261102.1', tarballUrl: 'https://release.example.test/faravan_linux_amd64.tar.gz'});
  await assertRefused(f, /not a stable release/);
});

test('a signed version with leading zeros or an oversized part is not a stable release', {timeout: 60000}, async t => {
  for (const version of ['00.01.000', '0.1.0000000000']) {
    const f = await setup(t, {signer: makeSigner()});
    const tarball = await readFile(f.tarball);
    // The signer refuses these versions, so sign the raw manifest directly.
    await publishRaw(f, f.signer, {schema: 1, version, tarball: 'faravan_linux_amd64.tar.gz', sha256: sha256(tarball),
      size: tarball.length, released: new Date(0).toISOString()});
    await assertRefused(f, /not a stable release/);
  }
});

test('a validly signed release below the installer minimum version is refused', {timeout: 60000}, async t => {
  const f = await setup(t, {signer: makeSigner()});
  await publishRelease(f, f.signer, {version: '0.0.9'});
  await assertRefused(f, /older than the minimum version this installer accepts/);
});

test('a signed tarball manifest with assets must name exactly one linux x64 stable tarball entry', {timeout: 60000}, async t => {
  const macOnly = {archive: Buffer.from('mac bundle'), platform: 'darwin', arch: 'universal', kind: 'macos-app-zip',
    channel: 'faravan', bundleId: 'com.faravan.app', url: 'Faravan-0.2.0-universal.zip'};
  const f = await setup(t, {signer: makeSigner()});
  await publishRelease(f, f.signer, {assets: [macOnly]});
  await assertRefused(f, /no linux x64 stable tarball entry/);
});

test('a signed linux tarball entry that disagrees with the signed tarball is refused', {timeout: 60000}, async t => {
  const f = await setup(t, {signer: makeSigner()});
  const tarball = await readFile(f.tarball);
  await publishRaw(f, f.signer, {schema: 1, version: '0.2.0', tarball: 'faravan_linux_amd64.tar.gz', sha256: sha256(tarball),
    size: tarball.length, released: new Date(0).toISOString(), assets_schema: 1,
    assets: [{platform: 'linux', arch: 'x64', kind: 'tarball', channel: 'faravan',
      url: 'https://release.example.test/faravan_linux_amd64.tar.gz', size: tarball.length + 1, sha256: sha256(Buffer.from('other'))}]});
  await assertRefused(f, /no linux x64 stable tarball entry/);
});

test('a .deb listed only in assets is not a signed .deb, and dpkg never runs', {timeout: 60000}, async t => {
  const f = await setup(t, {signer: makeSigner(), hasDeb: true});
  const tarball = await readFile(f.tarball), deb = await readFile(f.deb);
  await publishRaw(f, f.signer, {schema: 1, version: '0.2.0', tarball: 'faravan_linux_amd64.tar.gz', sha256: sha256(tarball),
    size: tarball.length, released: new Date(0).toISOString(), assets_schema: 1,
    assets: [{platform: 'linux', arch: 'x64', kind: 'deb', channel: 'faravan', url: 'https://release.example.test/faravan_amd64.deb',
      size: deb.length, sha256: sha256(deb)}]});
  await assertRefused(f, /no linux \.deb entry/);
});

// OpenSSL 1.x has no -rawin; without it the signature check cannot run, so the installer says so and stops.
test('an OpenSSL without -rawin is refused before anything is downloaded or installed', {timeout: 60000}, async t => {
  const f = await setup(t, {signer: makeSigner()});
  const realOpenssl = (await execFile('sh', ['-c', 'command -v openssl'])).stdout.trim();
  await writeShim(join(f.root, 'shim-bin'), 'openssl', [
    'if [ "$1 $2" = "pkeyutl -help" ]; then echo "Usage: pkeyutl" >&2; exit 1; fi',
    `exec "${realOpenssl}" "$@"`,
  ].join('\n'));
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the install must fail');
  assert.match(result.stdout + result.stderr, /needs OpenSSL 3/);
  assert.doesNotMatch(await commands(f), /^(tar|dpkg) /m);
});

test('the installer header states what it needs: python3, base64 and OpenSSL 3', async () => {
  const header = (await readFile(installer, 'utf8')).split('\n').slice(0, 12).join('\n');
  assert.match(header, /python3, base64 and OpenSSL 3/);
});

// The installer restores an interrupted self-update's lib/faravan.prev before it downloads anything. This is a
// guard for that ordering: the restore must not depend on the download succeeding.
test('an interrupted self-update is restored from lib/faravan.prev even when the download fails', {timeout: 60000}, async t => {
  const f = await setup(t);
  await mkdir(join(f.installRoot, 'lib/faravan.prev/bin'), {recursive: true});
  await writeFile(join(f.installRoot, 'lib/faravan.prev/VERSION'), 'previous\n');
  f.env.TEST_FAIL_TAR_DOWNLOAD = 'yes';
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the download fails, so the install fails');
  assert.equal(await readFile(join(f.installRoot, 'lib/faravan/VERSION'), 'utf8'), 'previous\n');
});

// dpkg runs as root, and this user could replace a file it can write. The verified .deb is copied into a root-owned
// directory, and the copy is checked again before dpkg installs it.
test('a .deb is installed from a root-owned copy, and that copy is what dpkg runs on', {timeout: 60000}, async t => {
  const signer = makeSigner();
  const f = await setup(t, {signer, hasDeb: true});
  await publishWithDeb(f, signer);
  await f.install();
  const log = await commands(f);
  const staged = log.match(/^install -m 0644 -o root (\S+) (\S+\/faravan\.deb)$/m);
  assert.ok(staged, 'the verified .deb is copied with sudo install -m 0644 -o root');
  assert.notEqual(dirname(staged[2]), dirname(staged[1]), 'the copy is in a different directory from the download');
  assert.match(log, new RegExp('^dpkg -i ' + staged[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
});

test('a .deb changed after it was copied to the root-owned directory is refused before dpkg runs', {timeout: 60000}, async t => {
  const signer = makeSigner();
  const f = await setup(t, {signer, hasDeb: true});
  await publishWithDeb(f, signer);
  f.env.TEST_CORRUPT_STAGED = 'yes';
  const result = await f.install();
  assert.notEqual(result.code, 0, 'the install must fail');
  assert.match(result.stdout + result.stderr, /does not match its signed manifest entry; nothing was installed/);
  assert.doesNotMatch(await commands(f), /^dpkg /m, 'dpkg never runs on the changed copy');
});
