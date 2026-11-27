import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, machO, fatMachO, fakeAppleTools } from './helpers/macos-app.mjs';

// Signing preparation (D5). No key, certificate or Apple/Microsoft service is used: tools are stubs that record
// their arguments, and the scripts read identities from the environment only. Real signing was NOT run.
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const mac = join(root, 'packaging/macos/sign-notarize.sh');
const winScript = join(root, 'packaging/windows/build-msix.ps1');
const have = async name => run('sh', ['-c', 'command -v ' + name]).then(() => true, () => false);
const exec = (file, args, env) => run(file, args, {env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}}).then(r => ({code: 0, ...r}), e => ({code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? ''}));

// Signing happens only after the universal merge, so the fixture is a merged bundle (synthetic Mach-O bytes).
const fakeApp = dir => makeApp(dir, {arch: 'universal'});
async function stubs(dir, scripts) {
  const bin = join(dir, 'stubs');
  await mkdir(bin, {recursive: true});
  await fakeAppleTools(bin); // Includes host isolation for synthetic Mach-O/icns bytes.
  const log = join(dir, 'calls.log');
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body ?? ''}\n`);
    await chmod(join(bin, name), 0o755);
  }
  return {bin, log, calls: () => readFile(log, 'utf8').catch(() => '')};
}

test('macOS: with no identity the script refuses, says why, and calls nothing', async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const app = await fakeApp(d), s = await stubs(d, {codesign: '', xcrun: '', ditto: '', spctl: ''});
  const result = await exec('bash', [mac, app], {PATH: s.bin + ':' + process.env.PATH});
  assert.equal(result.code, 2);
  assert.match(result.stderr, /FARAVAN_MAC_SIGN_IDENTITY/);
  assert.match(result.stderr, /FARAVAN_NOTARY_PROFILE/);
  assert.match(result.stderr, /T27/);
  assert.match(result.stderr, /FARAVAN_MAC_UNSIGNED_PREVIEW=1/, 'says how to make an explicit unsigned preview');
  assert.equal(await s.calls(), '');
  const partial = await exec('bash', [mac, app], {PATH: s.bin + ':' + process.env.PATH, FARAVAN_MAC_SIGN_IDENTITY: 'id', FARAVAN_NOTARY_KEY_ID: 'k'});
  assert.equal(partial.code, 2);
  assert.match(partial.stderr, /FARAVAN_NOTARY_KEY_PATH FARAVAN_NOTARY_ISSUER/);
});

test('macOS: signs inside out with the hardened runtime, notarizes, staples and checks Gatekeeper', async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const app = await fakeApp(d);
  const s = await stubs(d, {codesign: '', ditto: '', spctl: '', xcrun: 'case "$1" in notarytool) [ "$2" = submit ] && echo \'{"status":"Accepted","id":"sub-1"}\';; esac'});
  const env = {PATH: s.bin + ':' + process.env.PATH, FARAVAN_MAC_SIGN_IDENTITY: 'Developer ID Application: Test (ABCDE12345)', FARAVAN_NOTARY_PROFILE: 'faravan-notary'};
  const result = await exec('bash', [mac, app, d], env);
  assert.equal(result.code, 0, result.stderr);
  const calls = (await s.calls()).trim().split('\n');
  const signs = calls.filter(c => c.startsWith('codesign --force'));
  const order = [/runtime\/bin\/node$/, /Helpers\/FaravanNotify\.app$/, /MacOS\/faravan-tray$/, /MacOS\/faravan-process-identity$/, /MacOS\/faravan-update-exchange$/, /MacOS\/faravan$/, /MacOS\/faravan$/, /Faravan\.app$/];
  assert.equal(signs.length, 8, signs.join('\n'));
  order.forEach((pattern, i) => assert.match(signs[i], pattern));
  for (const line of signs) {
    for (const flag of ['--timestamp', '--options runtime', '--sign Developer ID Application: Test (ABCDE12345)']) assert.ok(line.includes(flag), flag + ' in ' + line);
    assert.equal(line.includes('entitlements.plist'), /runtime\/bin\/node$/.test(line), 'only Node gets the JIT entitlements: ' + line);
    assert.equal(line.includes('--deep'), false, 'no --deep when signing');
  }
  assert.ok(calls.some(c => c.startsWith('codesign --verify') && c.includes('--strict') && c.endsWith(app)), 'strict verification targets the outer app');
  const steps = ['codesign --verify', 'ditto -c -k', 'xcrun notarytool submit', 'xcrun stapler staple', 'xcrun stapler validate', 'spctl --assess'].map(prefix => calls.findIndex(c => c.startsWith(prefix)));
  assert.ok(steps.every(i => i >= 0) && steps.every((v, i) => i === 0 || v > steps[i - 1]), 'steps run in order: ' + steps);
  assert.ok(calls.findIndex(c => c.startsWith('codesign --verify')) > calls.lastIndexOf(signs.at(-1)), 'verification follows the last signature');
  assert.ok(calls.find(c => c.startsWith('xcrun notarytool submit')).includes('--keychain-profile faravan-notary'));
  assert.match(result.stdout, /NOT run/);
  const entitlements = await readFile(join(root, 'packaging/macos/entitlements.plist'), 'utf8');
  assert.match(entitlements, /allow-jit/); assert.equal((entitlements.match(/<key>/g) ?? []).length, 2, 'only what Node needs');
});

test('macOS: only a verified universal bundle is signed', async t => {
  const env = s => ({PATH: s.bin + ':' + process.env.PATH, FARAVAN_MAC_SIGN_IDENTITY: 'id', FARAVAN_NOTARY_PROFILE: 'p'});
  for (const [name, prepare, message] of [
    ['a single-architecture leg', d => makeApp(d, {arch: 'arm64'}), /needs arm64 \+ x86_64/],
    ['an unlisted Mach-O', async d => { const app = await fakeApp(d); await writeFile(join(app, 'Contents/Resources/faravan/addon.node'), fatMachO([machO('arm64'), machO('x86_64')])); return app; }, /addon\.node: Mach-O outside the signing inventory/],
  ]) {
    const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
    const app = await prepare(d), s = await stubs(d, {codesign: '', xcrun: '', ditto: '', spctl: ''});
    const result = await exec('bash', [mac, app, d], env(s));
    assert.notEqual(result.code, 0, name);
    assert.match(result.stderr, message, name);
    assert.equal(await s.calls(), '', name + ': nothing was signed');
  }
});

test('macOS: an unsigned preview is explicit, ad-hoc signed, never notarized and labelled', async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const app = await fakeApp(d), s = await stubs(d, {codesign: '', xcrun: '', ditto: '', spctl: ''});
  const both = await exec('bash', [mac, app, d], {PATH: s.bin + ':' + process.env.PATH, FARAVAN_MAC_UNSIGNED_PREVIEW: '1', FARAVAN_MAC_SIGN_IDENTITY: 'id'});
  assert.equal(both.code, 2, 'a signed release never falls back to an unsigned one');
  assert.match(both.stderr, /FARAVAN_MAC_UNSIGNED_PREVIEW .* FARAVAN_MAC_SIGN_IDENTITY/);
  assert.equal(await s.calls(), '');
  const result = await exec('bash', [mac, app, d], {PATH: s.bin + ':' + process.env.PATH, FARAVAN_MAC_UNSIGNED_PREVIEW: '1'});
  assert.equal(result.code, 0, result.stderr);
  const calls = (await s.calls()).trim().split('\n'), signs = calls.filter(c => c.startsWith('codesign --force'));
  const order = [/runtime\/bin\/node$/, /Helpers\/FaravanNotify\.app$/, /MacOS\/faravan-tray$/, /MacOS\/faravan-process-identity$/, /MacOS\/faravan-update-exchange$/, /MacOS\/faravan$/, /MacOS\/faravan$/, /Faravan\.app$/];
  assert.equal(signs.length, 8, signs.join('\n'));
  order.forEach((pattern, i) => assert.match(signs[i], pattern));
  for (const line of signs) { assert.ok(line.includes('--sign -'), line); assert.equal(line.includes('--timestamp'), false, line); }
  assert.equal(calls.some(c => /notarytool|stapler|spctl/.test(c)), false, 'no notarization, stapling or Gatekeeper pass is claimed');
  assert.ok(calls.some(c => c.startsWith('codesign --verify') && c.includes('--strict') && c.endsWith(app)), 'strict verification targets the outer app');
  assert.ok(calls.some(c => c.startsWith('ditto -c -k') && c.endsWith('Faravan-unsigned-preview.zip')), calls.join('\n'));
  assert.match(result.stdout, /UNSIGNED PREVIEW/); assert.match(result.stdout, /Open Anyway/);
});

test('macOS: a native arm64 unsigned preview is finalized and verified before archiving', async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const app = await makeApp(d, {arch: 'arm64'}), s = await stubs(d, {codesign: '', xcrun: '', ditto: '', spctl: ''});
  const result = await exec('bash', [mac, app, d], {
    PATH: s.bin + ':' + process.env.PATH,
    FARAVAN_MAC_UNSIGNED_PREVIEW: '1', FARAVAN_MAC_PREVIEW_ARCH: 'arm64',
  });
  assert.equal(result.code, 0, result.stderr);
  const calls = (await s.calls()).trim().split('\n'), signs = calls.filter(c => c.startsWith('codesign --force'));
  assert.equal(signs.length, 8, signs.join('\n'));
  for (const line of signs) assert.ok(line.includes('--sign -'), line);
  const verify = calls.findIndex(c => c.startsWith('codesign --verify --deep --strict'));
  const archive = calls.findIndex(c => c.startsWith('ditto -c -k'));
  assert.ok(verify >= 0 && archive > verify, 'strict seal verification precedes the preview archive');
  assert.equal(calls.some(c => /notarytool|stapler|spctl/.test(c)), false, 'no notarization or Gatekeeper operation');
  assert.ok(calls[archive].endsWith('Faravan-unsigned-preview.zip'));
  assert.match(result.stdout, /UNSIGNED PREVIEW/);
});

test('macOS: preview architecture selection is explicit and cannot weaken release signing', async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const app = await makeApp(d, {arch: 'arm64'}), s = await stubs(d, {codesign: '', xcrun: '', ditto: '', spctl: ''});
  const invalid = await exec('bash', [mac, app, d], {
    PATH: s.bin + ':' + process.env.PATH,
    FARAVAN_MAC_UNSIGNED_PREVIEW: '1', FARAVAN_MAC_PREVIEW_ARCH: 'i386',
  });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /FARAVAN_MAC_PREVIEW_ARCH.*arm64.*x86_64.*universal/);
  assert.equal(await s.calls(), '', 'invalid architecture is rejected before any Apple tool runs');

  const release = await exec('bash', [mac, app, d], {
    PATH: s.bin + ':' + process.env.PATH,
    FARAVAN_MAC_PREVIEW_ARCH: 'arm64', FARAVAN_MAC_SIGN_IDENTITY: 'id', FARAVAN_NOTARY_PROFILE: 'p',
  });
  assert.notEqual(release.code, 0, 'a release never accepts a thin preview architecture');
  assert.match(release.stderr, /FARAVAN_MAC_PREVIEW_ARCH.*only.*unsigned preview/i);
  assert.equal(await s.calls(), '', 'release selection is rejected before signing');
});

test('macOS: a rejected notarization stops with Apple\'s log, and an API key is never printed', async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const app = await fakeApp(d);
  const keyFile = join(d, 'AuthKey_TEST.p8');
  await writeFile(keyFile, 'SECRET-KEY-CONTENT');
  const s = await stubs(d, {codesign: '', ditto: '', spctl: '', xcrun: 'case "$2" in submit) echo \'{"status":"Invalid","id":"sub-9"}\';; log) echo "the binary is not signed";; esac'});
  const env = {PATH: s.bin + ':' + process.env.PATH, FARAVAN_MAC_SIGN_IDENTITY: 'id', FARAVAN_NOTARY_KEY_PATH: keyFile, FARAVAN_NOTARY_KEY_ID: 'KEYID', FARAVAN_NOTARY_ISSUER: 'ISSUER'};
  const result = await exec('bash', [mac, app, d], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid/); assert.match(result.stderr, /the binary is not signed/);
  const calls = await s.calls();
  assert.match(calls, /notarytool submit .* --key .*AuthKey_TEST\.p8 --key-id KEYID --issuer ISSUER/);
  assert.equal(calls.includes('stapler'), false, 'nothing is stapled after a rejection');
  assert.equal((result.stdout + result.stderr + calls).includes('SECRET-KEY-CONTENT'), false);
});

test('macOS: dry run prints every command and runs none', async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const s = await stubs(d, {codesign: '', xcrun: '', ditto: '', spctl: ''});
  const result = await exec('bash', [mac, join(d, 'Missing.app/'), d], {PATH: s.bin + ':' + process.env.PATH, FARAVAN_SIGN_DRY_RUN: '1', FARAVAN_MAC_SIGN_IDENTITY: 'id', FARAVAN_NOTARY_PROFILE: 'p'});
  assert.equal(result.code, 2, 'a missing bundle is refused even in a dry run');
  const app = await fakeApp(d);
  const dry = await exec('bash', [mac, app, d], {PATH: s.bin + ':' + process.env.PATH, FARAVAN_SIGN_DRY_RUN: '1', FARAVAN_MAC_SIGN_IDENTITY: 'id', FARAVAN_NOTARY_PROFILE: 'p'});
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(dry.stdout.split('\n').filter(l => l.startsWith('DRY-RUN:')).length >= 10);
  assert.equal(await s.calls(), '');
});

const pwsh = await have('pwsh');
const winEnv = {FARAVAN_WIN_PUBLISHER: 'CN=Test & Co, O=Test, C=US'};
async function layout(dir) {
  const l = join(dir, 'Faravan');
  for (const file of ['faravan-tray.exe', 'faravan.exe', 'faravan.cmd', 'faravan.cmd', 'app/runtime/node.exe', 'app/bin/faravan', 'app/bin/faravan', 'app/lib/v1/cli.mjs', 'app/package.json', 'app/VERSION', 'Assets/StoreLogo.png', 'Assets/Square150x150Logo.png', 'Assets/Square44x44Logo.png']) {
    await mkdir(join(l, file, '..'), {recursive: true});
    await writeFile(join(l, file), 'x');
  }
  await writeFile(join(l, 'app-files.txt'), 'lib/v1/cli.mjs\nlib/v1/other.mjs\n');
  await writeFile(join(l, 'app/lib/v1/other.mjs'), 'x');
  return l;
}

test('Windows: without a publisher and certificate the script refuses and calls nothing', {skip: !pwsh && 'needs pwsh'}, async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const s = await stubs(d, {makeappx: '', signtool: ''});
  const result = await exec('pwsh', ['-NoProfile', '-File', winScript, '-Layout', await layout(d), '-Version', '0.1.0'], {PATH: s.bin + ':' + process.env.PATH});
  assert.equal(result.code, 2);
  assert.match(result.stderr, /FARAVAN_WIN_PUBLISHER/); assert.match(result.stderr, /FARAVAN_WIN_CERT_PFX/); assert.match(result.stderr, /T27/);
  const noPassword = await exec('pwsh', ['-NoProfile', '-File', winScript, '-Layout', await layout(d), '-Version', '0.1.0'], {PATH: s.bin + ':' + process.env.PATH, ...winEnv, FARAVAN_WIN_CERT_PFX: 'x.pfx'});
  assert.match(noPassword.stderr, /FARAVAN_WIN_CERT_PASSWORD/);
  assert.equal(await s.calls(), '');
});

test('Windows: packs with a filled manifest, signs with SHA-256 and a timestamp, verifies; the password is never shown', {skip: !pwsh && 'needs pwsh', timeout: 120000}, async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const copied = join(d, 'manifest-seen.xml');
  const s = await stubs(d, {
    makeappx: `staging=$(echo "$*" | sed -n 's#.*pack /d \\([^ ]*\\) /p.*#\\1#p'); cp "$staging/AppxManifest.xml" "${copied}"`, signtool: '',
  });
  const env = {PATH: s.bin + ':' + process.env.PATH, ...winEnv, FARAVAN_WIN_CERT_PFX: 'cert.pfx', FARAVAN_WIN_CERT_PASSWORD: 'SECRET-PASSWORD'};
  const out = join(d, 'out');
  const result = await exec('pwsh', ['-NoProfile', '-File', winScript, '-Layout', await layout(d), '-Version', '0.1.0', '-Out', out], env);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const calls = (await s.calls()).trim().split('\n');
  assert.match(calls[0], /^makeappx pack \/d .* \/p .*Faravan-0\.1\.0-x64\.msix \/o$/);
  assert.match(calls[1], /^signtool sign \/fd SHA256 \/tr http:\/\/timestamp\.digicert\.com \/td SHA256 \/f cert\.pfx \/p SECRET-PASSWORD .*\.msix$/, 'signtool gets the password; nothing else does');
  assert.match(calls[2], /^signtool verify \/pa \/v .*\.msix$/);
  assert.equal(result.stdout.includes('SECRET-PASSWORD'), false);
  const manifest = await readFile(copied, 'utf8');
  assert.match(manifest, /Name="Faravan\.Faravan"/);
  assert.match(manifest, /Publisher="CN=Test &amp; Co, O=Test, C=US"/, 'XML-escaped');
  assert.match(manifest, /Version="0\.1\.0\.0"/); assert.match(manifest, /ProcessorArchitecture="x64"/);
  assert.equal(/@@/.test(manifest), false, 'every placeholder was filled');
  assert.match(result.stdout, /NOT run/);
});

test('Windows: a certificate in the store is used by thumbprint, and a dry run hides the password', {skip: !pwsh && 'needs pwsh', timeout: 120000}, async t => {
  const d = await mkdtemp(join(tmpdir(), 'spk-sign-')); t.after(() => rm(d, {recursive: true, force: true}));
  const s = await stubs(d, {makeappx: '', signtool: ''});
  const dir = await layout(d);
  const temp = join(d, 'temp');
  await mkdir(temp);
  const base = ['-NoProfile', '-File', winScript, '-Layout', dir, '-Version', '0.2.0', '-Out', join(d, 'o'), '-DryRun'];
  const byThumb = await exec('pwsh', base, {PATH: s.bin + ':' + process.env.PATH, TMPDIR: temp, ...winEnv, FARAVAN_WIN_CERT_THUMBPRINT: 'AB12CD34'});
  assert.equal(byThumb.code, 0, byThumb.stderr);
  // The .NET runtime under pwsh keeps its named-mutex state in TMPDIR/.dotnet (shm, lockfiles) on Unix; no setting moves it.
  // That folder is the runtime's own. The script itself must leave nothing in TMPDIR.
  const left = await readdir(temp);
  assert.deepEqual(left.filter(name => name !== '.dotnet'), [], 'the dry run writes no temporary file');
  if (left.includes('.dotnet')) for (const name of await readdir(join(temp, '.dotnet'))) assert.ok(['shm', 'lockfiles'].includes(name), 'only runtime state in .dotnet: ' + name);
  await assert.rejects(readdir(join(d, 'o')), {code: 'ENOENT'});
  assert.match(byThumb.stdout, /DRY-RUN: signtool sign .*\/sha1 AB12CD34/);
  const byPfx = await exec('pwsh', base, {PATH: s.bin + ':' + process.env.PATH, ...winEnv, FARAVAN_WIN_CERT_PFX: 'c.pfx', FARAVAN_WIN_CERT_PASSWORD: 'SECRET-PASSWORD'});
  assert.match(byPfx.stdout, /\/p <hidden>/); assert.equal(byPfx.stdout.includes('SECRET-PASSWORD'), false);
  assert.equal(await s.calls(), '', 'a dry run calls no tool');
  await rm(join(dir, 'Assets/StoreLogo.png'));
  const missingAsset = await exec('pwsh', base, {...winEnv, FARAVAN_WIN_CERT_THUMBPRINT: 'x'});
  assert.equal(missingAsset.code, 2);
  assert.match(missingAsset.stderr, /missing Assets[\\/]StoreLogo\.png/);
  await writeFile(join(dir, 'Assets/StoreLogo.png'), 'x');
  await rm(join(dir, 'app/lib/v1/other.mjs'));
  const missingModule = await exec('pwsh', base, {...winEnv, FARAVAN_WIN_CERT_THUMBPRINT: 'x'});
  assert.equal(missingModule.code, 2);
  assert.match(missingModule.stderr, /missing .*other\.mjs/);
  await writeFile(join(dir, 'app/lib/v1/other.mjs'), 'x');
  await rm(join(dir, 'faravan.exe'));
  const incomplete = await exec('pwsh', base, {...winEnv, FARAVAN_WIN_CERT_THUMBPRINT: 'x'});
  assert.equal(incomplete.code, 2);
  assert.match(incomplete.stderr, /missing faravan\.exe/);
  assert.equal((await exec('pwsh', ['-NoProfile', '-File', winScript, '-Layout', d, '-Version', '1.2', '-DryRun'], {...winEnv, FARAVAN_WIN_CERT_THUMBPRINT: 'x'})).code, 2);
});

test('the manifest template and the script agree on their placeholders', async () => {
  const template = await readFile(join(root, 'packaging/windows/AppxManifest.template.xml'), 'utf8');
  const script = await readFile(winScript, 'utf8');
  const tokens = new Set(template.match(/@@[A-Z_]+@@/g));
  for (const token of tokens) assert.ok(script.includes("'" + token + "'"), token + ' is filled by build-msix.ps1');
  assert.match(template, /<uap:Protocol Name="faravan" \/>/);
  assert.match(template, /<uap:Protocol Name="faravan" \/>/, 'the former invitation scheme remains registered');
  assert.equal(/\b(password|thumbprint|pfx)\b/i.test(template), false, 'no secrets or cert names in the template');
});
