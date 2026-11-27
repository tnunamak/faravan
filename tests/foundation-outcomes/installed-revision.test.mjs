import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const A = 'a'.repeat(40), B = 'b'.repeat(40);
// Actual producer orchestration, synthetic build effects only. No artifact qualification.
async function fixture(t, platform, parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'installed-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'packaging'), mac = join(pkg, 'macos'), bin = join(root, 'tools');
  const out = join(root, 'output'), effects = join(root, 'effects');
  for (const p of [mac, bin, out, join(root, 'tray'), join(root, 'lib'), join(pkg, 'assets'), join(pkg, 'scripts'), join(mac, 'launcher')]) await mkdir(p, { recursive: true });
  const source = platform === 'mac' ? 'packaging/macos/build-app.sh' : 'packaging/build.sh';
  const scriptPath = join(root, source);
  await writeFile(scriptPath, await readFile(join(repo, source)));
  async function script(path, body) { await writeFile(path, '#!/bin/bash\nset -eu\n' + body, { mode: 0o755 }); }
  await writeFile(effects, '');
  await script(join(pkg, 'stage-app.sh'), 'echo stage >> "$EFFECTS"\nmkdir -p "$1/public/v1"\nprintf icon > "$1/public/v1/icon-512.png"\nprintf "%s" "$2" > "$1/version"\nprintf stale > "$1/installed-source.json"\n');
  for (const name of ['bundle-node.sh', 'bundle-guest-runtime.sh']) await script(join(pkg, name), 'echo bundle >> "$EFFECTS"\n');
  await writeFile(join(pkg, 'check-staged-runtime.mjs'), '');
  await script(join(bin, 'node'), 'exec "$REAL_NODE" "$@"\n');
  const compiler = 'echo compile >> "$EFFECTS"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; mkdir -p "$(dirname "$1")"; printf "#!/bin/sh\\nexit 0\\n" > "$1"; chmod +x "$1"; exit 0; fi; shift; done\nexit 1\n';
  for (const name of ['go', 'swiftc', 'clang', 'iconutil']) await script(join(bin, name), compiler);
  await script(join(bin, 'uname'), 'echo arm64\n');
  await script(join(bin, 'docker'), 'echo forbidden-docker >> "$EFFECTS"; exit 99\n');
  await script(join(bin, 'nfpm'), 'echo package >> "$EFFECTS"\n');
  await script(join(bin, 'dpkg-deb'), 'echo package >> "$EFFECTS"\n');
  if (platform === 'mac') {
    await writeFile(join(mac, 'launcher/main.swift'), '// synthetic');
    await script(join(mac, 'launcher/cli.sh'), 'exit 0\n');
    await writeFile(join(mac, 'Info.plist'), '<plist>@@VERSION@@ @@MIN_MACOS@@ @@BUNDLE_ID@@ @@APP_NAME@@</plist>');
    await writeFile(join(root, 'lib/channel-identity.mjs'), 'export const isChannelIdentity = x => x.id === "stable"; export const plistSedReplacement = x => x;');
    await script(join(mac, 'build-notify-helper.sh'), 'mkdir -p "$1/Contents"\n');
    await script(join(mac, 'verify-app.sh'), 'echo verify >> "$EFFECTS"\n');
  } else {
    await writeFile(join(pkg, 'deb-version.sh'), 'deb_upstream_version() { printf "%s" "$1"; }\ndeb_full_version() { printf "1:%s-1" "$1"; }\n');
    await writeFile(join(pkg, 'nfpm.env'), 'DEB_EPOCH=1\nDEB_REVISION=1\n');
    for (const name of ['faravan-app.service','faravan-coordinator.service','faravan-tray.service','faravan-tray-start','faravan-session-environment.sh','faravan-open-link.desktop','faravan.desktop','faravan-tray.desktop']) await writeFile(join(pkg, 'assets', name), 'synthetic');
    for (const name of ['preinstall.sh','postinstall.sh','remove.sh','transition-postinstall.sh']) await script(join(pkg, 'scripts', name), 'exit 0\n');
  }
  const env = { PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, TMPDIR: root,
    REAL_NODE: process.execPath, FARAVAN_NODE_BIN: process.execPath, FARAVAN_BUILD_NODE: process.execPath,
    PACKAGE_VERSION: '1.2.3', PACKAGE_SOURCE_SHA: A, EFFECTS: effects };
  const run = extra => spawnSync('/bin/bash', [scriptPath, ...(platform === 'mac' ? [out] : [])], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  const app = platform === 'mac' ? join(out, 'Faravan.app/Contents/Resources/faravan') : join(pkg, 'stage/usr/lib/faravan');
  async function installed(version = '1.2.3') {
    if (platform === 'mac') return JSON.parse(await readFile(join(app, 'installed-source.json'), 'utf8'));
    // Check the packaged tar payload, not merely the staging file. No real package manager.
    const r = spawnSync('/usr/bin/tar', ['-xOzf', join(pkg, 'dist', 'faravan_' + version + '_linux_amd64.tar.gz'), 'usr/lib/faravan/installed-source.json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  }
  async function git(...args) {
    const r = spawnSync('git', ['-C', root, ...args], { env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  }
  return { root, pkg, app, out, run, installed, git, effects };
}
for (const platform of ['linux', 'mac']) {
  test(platform + ': valid source embeds exact metadata in installed payload and replaces stale metadata', async t => {
    const f = await fixture(t, platform);
    for (const [sha, version] of [[A.toUpperCase(), '1.2.3'], [B, '1.2.4']]) {
      const r = f.run({ PACKAGE_SOURCE_SHA: sha, PACKAGE_VERSION: version });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(await f.installed(version), { schemaVersion: 1, sourceSha: sha.toLowerCase(), version });
      assert.equal(await readFile(join(f.app, 'version'), 'utf8'), version);
      if (platform === 'mac') assert.match(r.stdout, /unsigned/);
    }
  });
  test(platform + ': invalid and absent exported-tree identities fail before build effects', async t => {
    const f = await fixture(t, platform);
    for (const sha of ['', 'main', 'abcd123', 'g'.repeat(40), undefined]) {
      const r = f.run({ PACKAGE_SOURCE_SHA: sha });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /PACKAGE_SOURCE_SHA/);
      assert.equal(await readFile(f.effects, 'utf8'), '');
      assert.deepEqual(await readdir(f.out), []);
    }
  });
  test(platform + ': verified own checkout resolves HEAD, mismatch rejects before effects', async t => {
    const f = await fixture(t, platform);
    await f.git('init', '--quiet');
    await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture', '--quiet');
    const sha = await f.git('rev-parse', 'HEAD');
    const mismatch = f.run({ PACKAGE_SOURCE_SHA: A });
    assert.equal(mismatch.status, 2, mismatch.stderr);
    assert.match(mismatch.stderr, /PACKAGE_SOURCE_SHA/);
    assert.equal(await readFile(f.effects, 'utf8'), '');
    const r = f.run({ PACKAGE_SOURCE_SHA: undefined });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(await f.installed(), { schemaVersion: 1, sourceSha: sha, version: '1.2.3' });
  });
  test(platform + ': unrelated parent checkout cannot supply exported source identity', async t => {
    // A .git marker is absent at the producer's actual source root even if git
    // would otherwise discover an ancestor. A hostile ambient Git dir is ignored.
    const other = await fixture(t, platform); await other.git('init', '--quiet');
    await other.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'other', '--quiet');
    const f = await fixture(t, platform, other.root);
    const r = f.run({ PACKAGE_SOURCE_SHA: undefined, GIT_DIR: join(other.root, '.git'), GIT_WORK_TREE: other.root });
    assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /PACKAGE_SOURCE_SHA/);
    assert.equal(await readFile(f.effects, 'utf8'), '');
  });
}
