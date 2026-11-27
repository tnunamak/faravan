import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const script = root + 'packaging/deb-version.sh';
const have = async name => run('sh', ['-c', 'command -v ' + name]).then(() => true, () => false);
const skip = (await Promise.all(['bash', 'dpkg'].map(have))).every(Boolean) ? false : 'needs bash and dpkg';

const debVersion = async release => (await run('bash', [script, release])).stdout.trim();
// What dpkg itself says, not our idea of the order.
const dpkgOrders = async (lower, higher) => {
  const lt = await run('dpkg', ['--compare-versions', lower, 'lt', higher]).then(() => true, () => false);
  const gt = await run('dpkg', ['--compare-versions', higher, 'gt', lower]).then(() => true, () => false);
  return lt && gt;
};

test('a preview sorts below the release it leads to, and previews sort in order', {skip}, async () => {
  const stable = await debVersion('0.1.0');
  const p7 = await debVersion('0.1.0-preview.20261020.7');
  const p8 = await debVersion('0.1.0-preview.20261020.8');
  const p10 = await debVersion('0.1.0-preview.20261020.10');
  const nextDay = await debVersion('0.1.0-preview.20261021.1');
  assert.equal(p7, '1:0.1.0~preview.20261020.7-1');
  assert.equal(stable, '1:0.1.0-1');
  assert.ok(await dpkgOrders(p7, stable), 'preview < stable');
  assert.ok(await dpkgOrders(p7, p8), 'preview N < preview N+1');
  assert.ok(await dpkgOrders(p8, p10), 'preview 8 < preview 10 (numeric, not text)');
  assert.ok(await dpkgOrders(p10, nextDay), 'a later day sorts above an earlier one');
  assert.ok(await dpkgOrders(stable, await debVersion('0.2.0-preview.20261101.1')), 'a preview of the next release sorts above this stable');
  assert.ok(await dpkgOrders(await debVersion('0.2.0-preview.20261101.1'), await debVersion('0.2.0')), 'next release preview < next stable');
});

test('the first tilde preview upgrades the hyphen previews that already shipped', {skip}, async () => {
  // Preview 1 to 6 were published as "0.1.0-preview.YYYYMMDD.N-1" (no epoch). Without the epoch, the tilde form
  // sorts BELOW them and apt refuses preview 7 as a downgrade.
  const shipped = '0.1.0-preview.20261020.6-1';
  assert.ok(await dpkgOrders(shipped, await debVersion('0.1.0-preview.20261020.7')));
  assert.equal(await run('dpkg', ['--compare-versions', '0.1.0~preview.20261020.7-1', 'gt', shipped]).then(() => true, () => false), false,
    'the epoch is what makes this an upgrade');
});

test('nFPM and dpkg-deb take the version from the same place', {skip}, async () => {
  const nfpm = await readFile(root + 'packaging/nfpm.yaml', 'utf8');
  const build = await readFile(root + 'packaging/build.sh', 'utf8');
  const epoch = (await run('bash', ['-c', `. "${script}"; printf %s "$DEB_EPOCH"`])).stdout;
  assert.match(nfpm, /^version: \$\{PACKAGE_DEB_VERSION\}$/m);
  assert.match(nfpm, /^version_schema: none$/m, 'nFPM must not split the version again');
  assert.match(nfpm, new RegExp(`^epoch: "${epoch}"$`, 'm'), 'nfpm.yaml epoch equals DEB_EPOCH (nFPM does not expand variables there)');
  assert.match(build, /PACKAGE_DEB_VERSION="\$\(deb_upstream_version "\$package_version"\)"/);
  assert.match(build, /Version: \$\{DEB_EPOCH\}:\$\{PACKAGE_DEB_VERSION\}-\$\{DEB_REVISION\}/);
  assert.doesNotMatch(build, /Version: \$\{package_version\}/, 'dpkg-deb must not use the raw release version');
});
