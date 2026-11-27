import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Execute the real build orchestration with synthetic stage data and process
// effects only. No compiler, signer, runtime download, GUI or live service.
const source = resolve('packaging/macos');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mac-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mac = join(root, 'packaging/macos');
  const bin = join(root, 'bin');
  const out = join(root, 'Applications stage');
  await Promise.all([mac, bin, out, join(root, 'lib'), join(root, 'tray'), join(mac, 'launcher')].map(p => mkdir(p, { recursive: true })));
  for (const name of ['build-app.sh', 'Info.plist', 'launcher/main.swift']) {
    await writeFile(join(mac, name), await readFile(join(source, name)), { mode: 0o755 });
  }
  await writeFile(join(mac, 'launcher/cli.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(root, 'lib/channel-identity.mjs'), 'export const isChannelIdentity = x => x.id === "stable"; export const plistSedReplacement = x => x;\n');
  async function script(path, content) { await writeFile(path, '#!/bin/bash\nset -eu\n' + content, { mode: 0o755 }); }
  await script(join(root, 'packaging/stage-app.sh'), 'printf "new artifact" > "$1/identity"\nif [ "${FAIL_STAGE:-}" = 1 ]; then exit 42; fi\n');
  for (const name of ['bundle-node.sh', 'bundle-guest-runtime.sh']) await script(join(root, 'packaging', name), 'exit 0\n');
  await writeFile(join(root, 'packaging/check-staged-runtime.mjs'), '// Synthetic runtime check only.\n');
  await script(join(mac, 'build-notify-helper.sh'), 'mkdir -p "$1/Contents"\n');
  await script(join(mac, 'verify-app.sh'), '[ -f "$1/Contents/Info.plist" ]\n[ -x "$1/Contents/MacOS/faravan-launch" ]\nif [ "${FAIL_VERIFY:-}" = 1 ]; then exit 43; fi\n');
  await script(join(bin, 'uname'), 'echo arm64\n');
  const compiler = 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; mkdir -p "$(dirname "$1")"; printf "#!/bin/sh\\nexit 0\\n" > "$1"; chmod +x "$1"; exit 0; fi; shift; done\nexit 1\n';
  for (const name of ['go', 'swiftc', 'clang', 'iconutil']) await script(join(bin, name), compiler);
  await script(join(bin, 'mv'), 'if [ "${FAIL_PUBLISH:-}" = 1 ] && [[ "$1" == */.Faravan.build.*/Faravan.app ]] && [ "$2" = "$FINAL_APP" ]; then exit 44; fi\nexec /bin/mv "$@"\n');
  const env = {
    PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root,
    // Deliberate exported-source identity; no ambient source metadata.
    PACKAGE_SOURCE_SHA: 'c'.repeat(40),
    TMPDIR: root,
    FARAVAN_NODE_BIN: process.execPath,
    FARAVAN_BUILD_NODE: process.execPath,
    FINAL_APP: join(out, 'Faravan.app'),
  };
  const run = extra => spawnSync('/bin/bash', [join(mac, 'build-app.sh'), out], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  return { root, out, run };
}
async function previous(out) {
  await mkdir(join(out, 'Faravan.app'));
  await writeFile(join(out, 'Faravan.app/identity'), 'previous artifact');
}
async function clean(out) {
  assert.deepEqual((await readdir(out)).sort(), ['Faravan.app']);
}
for (const [flag, code] of [['FAIL_STAGE', 42], ['FAIL_VERIFY', 43], ['FAIL_PUBLISH', 44]]) {
  test('failed ' + flag + ' preserves last usable app and cleans temporary state', async t => {
    const f = await fixture(t); await previous(f.out);
    const r = f.run({ [flag]: '1' });
    assert.equal(r.status, code, r.stderr);
    assert.equal(await readFile(join(f.out, 'Faravan.app/identity'), 'utf8'), 'previous artifact');
    await clean(f.out);
  });
}
test('successful install stages a complete bundle and replaces only after verification', async t => {
  const f = await fixture(t); await previous(f.out);
  const r = f.run({});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(join(f.out, 'Faravan.app/Contents/Resources/faravan/identity'), 'utf8'), 'new artifact');
  const plist = await readFile(join(f.out, 'Faravan.app/Contents/Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>faravan-launch<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com.faravan.app<\/string>/);
  assert.doesNotMatch(plist, /@@/);
  assert.equal(JSON.parse(await readFile(join(f.out, 'Faravan.app/Contents/Resources/faravan/channel.json'), 'utf8')).id, 'stable');
  assert.deepEqual(JSON.parse(await readFile(join(f.out, 'Faravan.app/Contents/Resources/faravan/installed-source.json'), 'utf8')),
    { schemaVersion: 1, sourceSha: 'c'.repeat(40), version: '0.1.0' });
  await clean(f.out);
});
test('a concurrent builder cannot remove another build lock or previous app', async t => {
  const f = await fixture(t); await previous(f.out);
  const lock = join(f.out, '.Faravan.build.lock');
  await mkdir(lock); await writeFile(join(lock, 'owner'), 'other builder');
  const r = f.run({});
  assert.equal(r.status, 2, r.stderr);
  assert.equal(await readFile(join(lock, 'owner'), 'utf8'), 'other builder');
  assert.equal(await readFile(join(f.out, 'Faravan.app/identity'), 'utf8'), 'previous artifact');
});
test('first build failure leaves no partial Applications bundle and can be retried', async t => {
  const f = await fixture(t);
  const failed = f.run({ FAIL_STAGE: '1' });
  assert.equal(failed.status, 42, failed.stderr);
  assert.deepEqual(await readdir(f.out), []);
  const retry = f.run({});
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(await readFile(join(f.out, 'Faravan.app/Contents/Resources/faravan/identity'), 'utf8'), 'new artifact');
  await clean(f.out);
});
