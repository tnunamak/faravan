import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Build transaction fixtures only: these do NOT certify graphical installation,
// artifact trust, user privileges, extraction safety or desktop first launch.
const builder = fileURLToPath(new URL('../../packaging/linux-download.sh', import.meta.url));
const version = '1.2.3-preview.20261114.1';
const name = `faravan-linux-x64-${version}.tar.gz`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'faravan-download-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const stage = join(root, 'stage'), dist = join(root, 'dist'), bin = join(root, 'bin');
  for (const dir of [stage, dist, bin]) await mkdir(dir, {recursive:true});
  for (const relative of ['usr/bin/faravan', 'usr/bin/faravan', 'usr/lib/faravan/bin/faravan',
    'usr/lib/faravan/runtime/bin/node', 'usr/lib/faravan/faravan-tray']) {
    const path = join(stage, relative);
    await mkdir(join(path, '..'), {recursive:true});
    await writeFile(path, '#!/bin/sh\nexit 99\n', {mode:0o755});
  }
  await writeFile(join(stage, 'usr/lib/faravan/VERSION'), version);
  // Only tar is substituted. No runtime executable is launched, no network is
  // used and the PATH override is confined to this synthetic build subprocess.
  await writeFile(join(bin, 'tar'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-czf" ]; then
    shift
    printf 'fixture archive' > "$1"
    exit "$FAKE_TAR_STATUS"
  fi
  shift
done
exit 98
`, {mode:0o755});
  return {dist, run(status) {
    return spawnSync('bash', [builder, stage, dist], {encoding:'utf8',
      timeout:10000, env:{...process.env, PATH:bin+':'+process.env.PATH, FAKE_TAR_STATUS:String(status)}});
  }};
}

test('failed archive creation preserves previous artifact and removes staging', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dist, name), 'previous accepted bytes');
  const result = f.run(7);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(await readFile(join(f.dist, name), 'utf8'), 'previous accepted bytes');
  assert.deepEqual(await readdir(f.dist), [name]);
});

test('failed first build leaves no apparently downloadable artifact', async t => {
  const f = await fixture(t);
  const result = f.run(7);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(await readdir(f.dist), []);
});

test('successful build publishes only the exact version-selected artifact', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dist, name), 'previous accepted bytes');
  await writeFile(join(f.dist, 'unrelated.tar.gz'), 'other release');
  const result = f.run(0);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.dist, name), 'utf8'), 'fixture archive');
  assert.equal(await readFile(join(f.dist, 'unrelated.tar.gz'), 'utf8'), 'other release');
  assert.deepEqual((await readdir(f.dist)).sort(), [name, 'unrelated.tar.gz'].sort());
});
