import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, fixture, skip } from './helpers/apt-repo-fixture.mjs';

const installer = fileURLToPath(new URL('../bin/faravan-install.sh', import.meta.url));
const exists = path => access(path).then(() => true, () => false);

// The installer runs for real with shims for curl, sudo, apt-get and dpkg-query.
// curl serves the test repository from disk for the fake host and fails for any
// other URL; sudo runs the command without privilege (every path it writes is an
// override inside the temp directory); apt-get only records its arguments.
async function setup(t, {pin, serve = true} = {}) {
  const f = await fixture(t);
  const repo = await f.build('0.1.0');
  const bin = join(f.root, 'bin');
  await mkdir(bin);
  await mkdir(join(f.root, 'sources.d')); // /etc/apt/sources.list.d exists on a real system
  const shim = async (name, body) => { await writeFile(join(bin, name), '#!/bin/sh\n' + body + '\n'); await chmod(join(bin, name), 0o755); };
  await shim('curl', `
url=""; out=""; head=0
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --max-filesize) shift 2 ;; -*I*) head=1; shift ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in
  https://apt.example.test/*) path="${repo}/\${url#https://apt.example.test/}"; [ "${serve}" = true ] && [ -f "$path" ] || exit 22
    if [ $head = 1 ]; then exit 0; fi; cp "$path" "$out" ;;
  *) exit 22 ;;
esac`);
  await shim('sudo', 'exec "$@"');
  await shim('apt-get', `echo "$*" >> "${f.root}/apt-get.log"`);
  await shim('dpkg-query', 'printf 22.20.0');
  // The installed package's launcher. A stale faravan elsewhere on PATH must not be what the readiness check runs.
  await shim('packaged-faravan', '[ "$1" = --readiness ] && echo "$1" >> "' + join(f.root, 'readiness.log') + '"');
  await shim('faravan', 'echo "stale launcher on PATH" >&2; exit 7');
  const env = {...process.env, PATH: bin + ':' + process.env.PATH, HOME: join(f.root, 'home'),
    FARAVAN_APT_BASE: 'https://apt.example.test', FARAVAN_APT_KEYRING: join(f.root, 'keyrings/faravan.gpg'),
    FARAVAN_APT_SOURCES: join(f.root, 'sources.d/faravan.sources'), FARAVAN_INSTALL_ROOT: join(f.root, 'local'),
    FARAVAN_PACKAGED_BIN: join(bin, 'packaged-faravan'),
    FARAVAN_DOWNLOAD_BASE: 'https://github.invalid/dl', FARAVAN_RELEASE_API: 'https://github.invalid/api', FARAVAN_CHANNEL: 'stable'};
  if (pin !== undefined) env.FARAVAN_APT_KEY_FPR = pin === true ? f.fpr : pin;
  const install = () => new Promise(resolve => execFile('sh', [installer], {env}, (error, stdout, stderr) => resolve({code: error?.code ?? 0, stdout, stderr})));
  return {f, env, install, log: () => readFile(join(f.root, 'apt-get.log'), 'utf8').catch(() => '')};
}

test('with the pinned key the installer adds the signed repository and installs from it', {skip, timeout: 120000}, async t => {
  const s = await setup(t, {pin: true});
  const result = await s.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /needs administrator permission; your system may ask for your password/);
  const sources = await readFile(s.env.FARAVAN_APT_SOURCES, 'utf8');
  assert.match(sources, /^URIs: https:\/\/apt\.example\.test$/m);
  assert.match(sources, new RegExp('^Signed-By: ' + s.env.FARAVAN_APT_KEYRING.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '$', 'm'));
  assert.equal(await exists(s.env.FARAVAN_APT_KEYRING), true);
  assert.deepEqual((await s.log()).trim().split('\n'), ['update', 'install -y faravan']);
  const shown = (await run('gpg', ['--show-keys', '--with-colons', s.env.FARAVAN_APT_KEYRING])).stdout;
  assert.match(shown, new RegExp(s.f.fpr));
  assert.equal(await exists(join(s.env.FARAVAN_INSTALL_ROOT, 'bin/faravan')), false, 'no tarball install on the apt path');
  assert.equal(await readFile(join(s.f.root, 'readiness.log'), 'utf8'), '--readiness\n', 'the packaged launcher, not a stale one on PATH, is checked');
});

test('apt install removes an owned portable faravan shim from the PATH directory', {skip, timeout: 120000}, async t => {
  const s = await setup(t, {pin: true});
  const faravan = join(s.env.FARAVAN_INSTALL_ROOT, 'bin', 'faravan');
  await mkdir(join(s.env.FARAVAN_INSTALL_ROOT, 'bin'), {recursive: true});
  await writeFile(faravan, `#!/bin/sh\n# faravan-tarball-shim: ${s.env.FARAVAN_INSTALL_ROOT}\nexec "${s.env.FARAVAN_INSTALL_ROOT}/bin/faravan" "$@"\n`);

  const result = await s.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await exists(faravan), false);
  assert.match(result.stdout, /Removed the owned portable launchers and runtime/);
});

test('apt handoff removes desktop entries for the removed runtime and keeps foreign entries', {skip, timeout: 120000}, async t => {
  const s = await setup(t, {pin: true});
  const root = s.env.FARAVAN_INSTALL_ROOT;
  const autostart = join(s.env.HOME, '.config/autostart/faravan-tray.desktop');
  const handler = join(s.env.HOME, '.local/share/applications/faravan-open-link.desktop');
  await mkdir(join(root, 'bin'), {recursive: true});
  await mkdir(join(root, 'lib/faravan'), {recursive: true});
  await mkdir(join(s.env.HOME, '.config/autostart'), {recursive: true});
  await mkdir(join(s.env.HOME, '.local/share/applications'), {recursive: true});
  await writeFile(join(root, 'bin/faravan'), `# faravan-tarball-shim: ${root}\n`);
  await writeFile(join(root, 'lib/faravan/.installed-via'), 'tarball\n');
  await writeFile(autostart, `Exec=${root}/lib/faravan/faravan-tray\n`);
  await writeFile(handler, `Exec=${root}/bin/faravan open-link %u\n`);
  const result = await s.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await exists(autostart), false);
  assert.equal(await exists(handler), false);
  await writeFile(join(root, 'bin/faravan'), `# faravan-tarball-shim: ${root}\n`);
  await mkdir(join(root, 'lib/faravan'), {recursive: true});
  await writeFile(join(root, 'lib/faravan/.installed-via'), 'tarball\n');
  await writeFile(autostart, 'Exec=/other/tray\n');
  await writeFile(handler, 'Exec=/other/faravan open-link %u\n');
  assert.equal((await s.install()).code, 0);
  assert.equal(await readFile(autostart, 'utf8'), 'Exec=/other/tray\n');
  assert.equal(await readFile(handler, 'utf8'), 'Exec=/other/faravan open-link %u\n');
});

for (const [name, options, why] of [
  ['a key that does not match the pinned fingerprint', {pin: 'AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000'}, /does not match/],
  ['no pinned key yet (the placeholder)', {}, /no Linux Faravan/],
  ['a repository that is not reachable', {pin: true, serve: false}, /no Linux Faravan/],
]) {
  test('the installer does not use the apt repository for ' + name, {skip, timeout: 120000}, async t => {
    const s = await setup(t, options);
    const result = await s.install();
    assert.notEqual(result.code, 0, 'it falls through to the release assets, which are absent here');
    assert.match(result.stdout + result.stderr, why);
    assert.equal(await s.log(), '', 'apt-get never ran');
    assert.equal(await exists(s.env.FARAVAN_APT_KEYRING), false, 'no key was installed');
    assert.equal(await exists(s.env.FARAVAN_APT_SOURCES), false, 'no source was added');
  });
}

// A second signing key in the same repository, so the keyring holds two primary keys.
async function exportKeys(f, fprs, name) {
  const files = [];
  for (const fpr of fprs) {
    const file = join(f.root, `${name}-${fpr}.gpg`);
    await run('gpg', ['--homedir', f.gnupg, '--batch', '--yes', '--output', file, '--export', fpr]);
    files.push(await readFile(file));
  }
  return files;
}

for (const [order, pinnedFirst] of [['first', true], ['second', false]]) {
  test(`the installer refuses a keyring with two primary keys when the pinned key is ${order}`, {skip, timeout: 240000}, async t => {
    const s = await setup(t, {pin: true});
    await run('gpg', ['--homedir', s.f.gnupg, '--batch', '--passphrase', '', '--quick-generate-key',
      'Other Test Key <other@example.invalid>', 'rsa3072', 'sign', 'never']);
    const fprs = [...(await run('gpg', ['--homedir', s.f.gnupg, '--with-colons', '--list-keys'])).stdout.matchAll(/^fpr:::::::::(\w+):/gm)].map(m => m[1]);
    const other = fprs.find(fpr => fpr !== s.f.fpr);
    const [pinned, extra] = await exportKeys(s.f, [s.f.fpr, other], 'two-keys');
    await writeFile(join(s.f.out, 'faravan-archive-keyring.gpg'), Buffer.concat(pinnedFirst ? [pinned, extra] : [extra, pinned]));

    const result = await s.install();
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /exactly one signing key/);
    assert.equal(await s.log(), '', 'apt-get never ran');
    assert.equal(await exists(s.env.FARAVAN_APT_KEYRING), false, 'no keyring was written');
    assert.equal(await exists(s.env.FARAVAN_APT_SOURCES), false, 'no source file was written');
  });
}

// A pinned key that has expired is not a key to trust, even with the right fingerprint. Expiry is set two seconds
// ahead and the test waits past it, so the exported keyring carries validity e.
test('the installer refuses a pinned key that has expired', {skip, timeout: 120000}, async t => {
  const s = await setup(t, {pin: true});
  const {f} = s;
  await run('gpg', ['--homedir', f.gnupg, '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '',
    '--quick-set-expire', f.fpr, String(Math.floor(Date.now() / 1000) + 2)]);
  await new Promise(resolve => setTimeout(resolve, 3000));
  await run('gpg', ['--homedir', f.gnupg, '--batch', '--export', f.fpr], {encoding: 'buffer'})
    .then(({stdout}) => writeFile(join(f.out, 'faravan-archive-keyring.gpg'), stdout));
  const result = await s.install();
  assert.notEqual(result.code, 0, 'no other install path is available, so the install fails');
  assert.match(result.stdout + result.stderr, /revoked, expired or disabled/);
  assert.equal(await s.log(), '', 'apt-get never ran');
  assert.equal(await exists(s.env.FARAVAN_APT_KEYRING), false, 'no keyring was written');
});

// The scratch GnuPG home starts a gpg-agent. The installer stops it on the way out, with the home it used.
test('the installer stops the gpg-agent it started for its scratch keyring', {skip, timeout: 120000}, async t => {
  const s = await setup(t, {pin: true});
  const log = join(s.f.root, 'gpgconf.log');
  const real = (await run('sh', ['-c', 'command -v gpgconf'])).stdout.trim();
  await writeFile(join(s.f.root, 'bin/gpgconf'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  await chmod(join(s.f.root, 'bin/gpgconf'), 0o755);
  const result = await s.install();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(await readFile(log, 'utf8'), /--homedir \S+\/gnupg --kill gpg-agent/);
});
