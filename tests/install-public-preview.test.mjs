import './helpers/no-browser.mjs';
// A stranger installs the public preview with the one installer command: the installer checks the computer,
// verifies the download against the signed public feed, installs into the channel's own folder, adds an
// applications-menu entry and opens the app. Every command the installer runs is a fake; nothing is downloaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createPrivateKey, generateKeyPairSync, sign} from 'node:crypto';
import {buildSignedManifest} from '../packaging/sign-update.mjs';
import {PREVIEW_FEED_URL} from '../lib/v1/self-update.mjs';

const execFile = promisify(execFileCallback);
const installer = fileURLToPath(new URL('../bin/faravan-install.sh', import.meta.url));
const VERSION = '0.1.0-preview.20261102.53';
const CHANNEL = 'preview-20261028';
const PREFIX = 'faravan-preview-20261028';
const RELEASES = 'https://github.com/tnunamak/faravan-updates/releases/download/v' + VERSION + '/';
const TARBALL_URL = RELEASES + 'faravan-linux-x64-' + VERSION + '.tar.gz';
const MAC_URL = RELEASES + 'Faravan-mac-arm64-' + VERSION + '.zip';

async function writeExecutable(path, lines) {
  await writeFile(path, ['#!/bin/sh', ...lines].join('\n') + '\n');
  await chmod(path, 0o755);
}

// The public tarball's layout (packaging/linux-download.sh): the runtime, the relocatable commands and the channel.
async function buildBundle(root) {
  const bundle = join(root, 'bundle'), lib = join(bundle, 'usr/lib/faravan');
  await mkdir(join(lib, 'runtime/bin'), {recursive: true});
  await mkdir(join(lib, 'bin'), {recursive: true});
  await mkdir(join(lib, 'public/v1'), {recursive: true});
  await mkdir(join(bundle, 'usr/bin'), {recursive: true});
  await writeExecutable(join(lib, 'runtime/bin/node'), [
    'if [ "${2:-}" = --readiness ]; then printf "readiness %s\\n" "$1" >> "$TEST_LOG"; [ "${TEST_FAIL_READINESS:-no}" = no ]; exit $?; fi',
    'exit 0',
  ]);
  await writeExecutable(join(lib, 'bin/faravan'), ['exit 0']);
  // Opening the app is the bare command, as the applications-menu entry runs it.
  await writeExecutable(join(bundle, 'usr/bin/faravan'), [
    'printf "opened %s %s\\n" "$0" "$*" >> "$TEST_LOG"', '[ "${TEST_FAIL_LAUNCH:-no}" = no ]']);
  await writeFile(join(lib, 'VERSION'), VERSION + '\n');
  await writeFile(join(lib, '.installed-via'), 'tarball\n');
  await writeFile(join(lib, 'public/v1/icon-512.png'), 'png');
  await writeFile(join(lib, 'channel.json'), JSON.stringify({id: CHANNEL, name: 'Faravan',
    dataFolder: 'Faravan', bundleId: 'com.faravan.app',
    helperBundleId: 'com.faravan.app.notify', launchAgentLabel: 'com.faravan.agent',
    linuxPrefix: PREFIX}) + '\n');
  const tarball = join(root, 'faravan-linux-x64-' + VERSION + '.tar.gz');
  await execFile('tar', ['-czf', tarball, '-C', bundle, 'usr']);
  return tarball;
}

async function setup(t, {os = 'Linux', arch = 'x86_64', libc = 'glibc 2.39', macVersion = '15.1', kvm = true,
  desktop = true, tamper = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faravan-public-install-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'), feed = join(root, 'feed'), shims = join(root, 'shims'), log = join(root, 'log');
  await mkdir(home, {recursive: true});
  await mkdir(feed);
  await mkdir(shims);
  const tarball = await buildBundle(root);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({type: 'pkcs8', format: 'pem'});
  const tarballBytes = await readFile(tarball), zipBytes = Buffer.from('mac zip');
  const {bytes} = buildSignedManifest({tarball: tarballBytes, version: VERSION, tarballUrl: TARBALL_URL, privateKeyPem,
    assets: [
      {archive: zipBytes, platform: 'darwin', arch: 'arm64', kind: 'macos-app-zip', channel: CHANNEL,
        bundleId: 'com.faravan.app', url: MAC_URL},
      {archive: tarballBytes, platform: 'linux', arch: 'x64', kind: 'tarball', channel: CHANNEL, url: TARBALL_URL},
    ]});
  await writeFile(join(feed, 'update.json'), bytes);
  await writeFile(join(feed, 'update.json.sig'), sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64') + '\n');
  await writeFile(join(feed, 'faravan-linux-x64-' + VERSION + '.tar.gz'), tamper ? Buffer.concat([tarballBytes, Buffer.from('x')]) : tarballBytes);
  // The installer carries the release public key; this copy carries the test key instead.
  const script = join(root, 'install.sh');
  await writeFile(script, (await readFile(installer, 'utf8'))
    .replace(/UPDATE_PUBLIC_KEY_PEM='[^']*'/, () => `UPDATE_PUBLIC_KEY_PEM='${publicKey.export({type: 'spki', format: 'pem'}).trimEnd()}'`));

  // curl serves the feed by file name and logs every URL it is asked for.
  await writeExecutable(join(shims, 'curl'), [
    'out=; url=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in -o) out=$2; shift 2 ;; --max-filesize) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac',
    'done',
    'printf "download %s\\n" "$url" >> "$TEST_LOG"',
    'file="$TEST_FEED/${url##*/}"',
    '[ -f "$file" ] && [ -n "$out" ] && cp "$file" "$out"',
  ]);
  await writeExecutable(join(shims, 'uname'), [
    'case "$1" in -s) printf "%s\\n" "$TEST_OS" ;; -m) printf "%s\\n" "$TEST_ARCH" ;; *) printf "%s\\n" "$TEST_OS" ;; esac',
  ]);
  await writeExecutable(join(shims, 'getconf'), [
    '[ "$1" = GNU_LIBC_VERSION ] && [ -n "$TEST_LIBC" ] && { printf "%s\\n" "$TEST_LIBC"; exit 0; }', 'exit 1',
  ]);
  await writeExecutable(join(shims, 'sw_vers'), ['printf "%s\\n" "$TEST_MAC_VERSION"']);
  const kvmDevice = join(root, 'kvm');
  if (kvm) await writeFile(kvmDevice, '');

  const env = {PATH: shims + ':' + process.env.PATH, HOME: home, SHELL: '/bin/sh',
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CONFIG_HOME: join(home, '.config'),
    FARAVAN_KVM_DEVICE: kvmDevice, FARAVAN_NO_TRAY_LAUNCH: '1',
    TEST_FEED: feed, TEST_LOG: log, TEST_OS: os, TEST_ARCH: arch, TEST_LIBC: libc, TEST_MAC_VERSION: macVersion};
  if (desktop) env.WAYLAND_DISPLAY = 'wayland-0';
  const install = () => execFile('sh', [script], {env})
    .then(r => ({code: 0, out: r.stdout + r.stderr}), e => ({code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '')}));
  const target = join(home, '.local/share', PREFIX);
  const entry = join(home, '.local/share/applications', PREFIX + '.desktop');
  return {root, home, env, install, target, entry, log: () => readFile(log, 'utf8').catch(() => '')};
}

const exists = path => lstat(path).then(() => true, () => false);

test('the installer reads the same public feed the app updates from', async () => {
  const text = await readFile(installer, 'utf8');
  assert.ok(text.includes(PREVIEW_FEED_URL), 'the installer default feed is the app update feed');
});

test('a stranger installs the public preview, gets a menu entry and the app opens', async t => {
  const f = await setup(t);
  const result = await f.install();
  assert.equal(result.code, 0, result.out);
  const log = await f.log();
  assert.match(log, new RegExp('download ' + PREVIEW_FEED_URL.replace(/[.?]/g, '\\$&') + '\n'), 'reads the public signed feed');
  assert.match(log, new RegExp('download ' + TARBALL_URL.replace(/[.?]/g, '\\$&') + '\n'), 'downloads the signed Linux asset');
  assert.match(result.out, /Checking this computer/);
  assert.match(result.out, /This computer can run Faravan\./);
  assert.match(result.out, /Verified the download against Faravan's signed release list\./);
  // The whole tree is kept together in the channel's own folder, so it can update itself there.
  assert.equal(await readFile(join(f.target, 'usr/lib/faravan/VERSION'), 'utf8'), VERSION + '\n');
  assert.equal(await readFile(join(f.target, 'usr/lib/faravan/.installed-via'), 'utf8'), 'tarball\n');
  assert.equal(await exists(join(f.home, '.local/bin/faravan')), false, 'a preview does not take the stable command');
  assert.match(log, /readiness .*\/usr\/lib\/faravan\/bin\/faravan\n/, 'the runtime is proved to start before it is kept');
  const entry = await readFile(f.entry, 'utf8');
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Name=Faravan$/m);
  assert.match(entry, new RegExp('^Exec=' + join(f.target, 'usr/bin/faravan') + '$', 'm'));
  assert.match(entry, new RegExp('^Icon=' + join(f.target, 'usr/lib/faravan/public/v1/icon-512.png') + '$', 'm'));
  assert.match(entry, /^Terminal=false$/m);
  assert.match(log, new RegExp('opened ' + join(f.target, 'usr/bin/faravan') + ' \n'), 'the app is opened once installed');
  assert.match(result.out, /Open Faravan from your applications menu: Faravan\./);
});

test('a second run keeps the installed copy and opens it', async t => {
  const f = await setup(t);
  assert.equal((await f.install()).code, 0);
  await writeFile(join(f.target, 'usr/lib/faravan/user-sentinel'), 'kept');
  const again = await f.install();
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Faravan is already installed in .*; it updates itself\./);
  assert.equal(await readFile(join(f.target, 'usr/lib/faravan/user-sentinel'), 'utf8'), 'kept');
  assert.equal((await f.log()).match(/^opened /gm)?.length, 2);
});

test('a download that does not match the signed feed installs nothing', async t => {
  const f = await setup(t, {tamper: true});
  const result = await f.install();
  assert.notEqual(result.code, 0);
  assert.match(result.out, /does not match its signed manifest entry; nothing was installed/);
  assert.equal(await exists(f.target), false);
  assert.equal(await exists(f.entry), false);
});

test('a runtime that cannot start on this computer is not kept', async t => {
  const f = await setup(t);
  f.env.TEST_FAIL_READINESS = 'yes';
  const result = await f.install();
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Faravan could not start on this computer; nothing was installed/);
  assert.equal(await exists(f.target), false);
  assert.equal(await exists(f.entry), false);
  assert.deepEqual((await readdir(join(f.home, '.local/share'))).filter(name => name.startsWith('.faravan-install.')), [],
    'the unpacked copy is removed');
  assert.doesNotMatch(await f.log(), /^opened /m);
});

test('a menu entry that cannot be written leaves no install and says so', async t => {
  const f = await setup(t);
  // The applications folder is a file, so the menu entry cannot be created.
  await mkdir(join(f.home, '.local/share'), {recursive: true});
  await writeFile(join(f.home, '.local/share/applications'), 'mine');
  const result = await f.install();
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /could not add Faravan to the applications menu; nothing was installed/);
  assert.doesNotMatch(result.out, /Open Faravan from your applications menu/);
  assert.equal(await exists(f.target), false, 'the tree this run unpacked is removed');
  assert.doesNotMatch(await f.log(), /^opened /m);
  assert.equal(await readFile(join(f.home, '.local/share/applications'), 'utf8'), 'mine');
});

test('a foreign menu entry with the channel name fails the install and is left alone', async t => {
  for (const content of ['[Desktop Entry]\nType=Application\nName=Other\nExec=/usr/bin/other\n', '']) {
    const f = await setup(t);
    await mkdir(dirname(f.entry), {recursive: true});
    await writeFile(f.entry, content);
    const result = await f.install();
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /already exists and belongs to something else/);
    assert.match(result.out, /could not add Faravan to the applications menu; nothing was installed/);
    assert.doesNotMatch(result.out, /Open Faravan from your applications menu/);
    assert.equal(await readFile(f.entry, 'utf8'), content, 'the foreign file is byte-identical');
    assert.equal(await exists(f.target), false, 'the tree this run unpacked is removed');
    assert.doesNotMatch(await f.log(), /^opened /m);
  }
});

test('an app that does not open on the first launch is not reported as installed', async t => {
  const f = await setup(t);
  f.env.TEST_FAIL_LAUNCH = 'yes';
  const result = await f.install();
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /Faravan is installed in .*, but it did not open/);
  assert.doesNotMatch(result.out, /Open Faravan from your applications menu/);
  assert.equal(await readFile(join(f.target, 'usr/lib/faravan/VERSION'), 'utf8'), VERSION + '\n', 'the install is kept');
  assert.equal(await exists(f.entry), true, 'the menu entry is kept');
});

test('a computer whose C library version cannot be read downloads nothing', async t => {
  const f = await setup(t, {libc: ''});
  const result = await f.install();
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /Faravan for Linux needs the GNU C library \(glibc\) 2\.28 or newer/);
  assert.match(result.out, /This computer cannot run Faravan\. Nothing was downloaded or installed\./);
  assert.doesNotMatch(await f.log(), /download /);
  assert.equal(await exists(f.target), false);
});

test('a folder that is not a Faravan install is never replaced', async t => {
  const f = await setup(t);
  await mkdir(f.target, {recursive: true});
  await writeFile(join(f.target, 'mine'), 'kept');
  const result = await f.install();
  assert.notEqual(result.code, 0);
  assert.match(result.out, /already exists and is not a Faravan install; move it, then run this again/);
  assert.equal(await readFile(join(f.target, 'mine'), 'utf8'), 'kept');
});

test('an unsupported Linux computer is told why before anything downloads', async t => {
  for (const [options, reason] of [
    [{arch: 'aarch64'}, /Faravan for Linux needs a 64-bit Intel or AMD \(x86-64\) computer\. This computer is aarch64\./],
    [{libc: 'glibc 2.17'}, /Faravan needs the GNU C library 2\.28 or newer\. This computer has 2\.17\./],
  ]) {
    const f = await setup(t, options);
    const result = await f.install();
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, reason);
    assert.match(result.out, /This computer cannot run Faravan\. Nothing was downloaded or installed\./);
    assert.doesNotMatch(await f.log(), /download /);
  }
});

test('lending needs are explained without blocking a borrower', async t => {
  const f = await setup(t, {kvm: false});
  const result = await f.install();
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Lending needs hardware virtualization \(\/dev\/kvm\), which this computer does not offer\. You can still borrow\./);
});

test('a Mac is checked and sent to the Mac app download', async t => {
  const mac = await setup(t, {os: 'Darwin', arch: 'arm64'});
  const result = await mac.install();
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /This Mac can run Faravan\./);
  assert.match(result.out, /Faravan for Mac is a separate app download, not this command\./);
  assert.doesNotMatch(await mac.log(), /download /);
  assert.equal(await exists(mac.target), false);

  const intel = await setup(t, {os: 'Darwin', arch: 'x86_64'});
  const refused = await intel.install();
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /Faravan for Mac needs Apple silicon \(M1 or later\)\./);
  assert.match(refused.out, /This computer cannot run Faravan\. Nothing was downloaded or installed\./);

  const old = await setup(t, {os: 'Darwin', arch: 'arm64', macVersion: '13.6'});
  const tooOld = await old.install();
  assert.notEqual(tooOld.code, 0);
  assert.match(tooOld.out, /Faravan for Mac needs macOS 14 or later\. This Mac has 13\.6\./);
});

test('the computer check uses the same minimums the builds use', async () => {
  const text = await readFile(installer, 'utf8');
  const macBuild = await readFile(new URL('../packaging/macos/build-app.sh', import.meta.url), 'utf8');
  assert.equal(/^MIN_MACOS="([0-9.]+)"$/m.exec(text)?.[1], /^min_macos=([0-9.]+)$/m.exec(macBuild)?.[1]);
});
