import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { checkLinuxLayout, verifyStagedRuntime } from '../../packaging/check-staged-runtime.mjs';

const packaging = fileURLToPath(new URL('../../packaging/', import.meta.url));
async function put(path, text = '', executable = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  if (executable) await chmod(path, 0o755);
}
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'faravan-runtime-dependencies-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'usr/lib/faravan');
  for (const path of ['runtime/bin/node', 'bin/faravan', '../../bin/faravan', '../../bin/faravan']) {
    await put(join(root, path), '#!/bin/sh\nexit 0\n', true);
  }
  await put(join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { '@fixture/sdk': '1.0.0' } }));
  await put(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  await put(join(root, 'node_modules/@fixture/sdk/package.json'), '{"name":"@fixture/sdk","version":"1.0.0"}');
  const metadata = join(base, 'nfpm.yaml');
  await put(metadata, 'name: fixture\ndepends:\n  - python3\nsuggests:\n  - optional\n');
  for (const path of ['kits/wf-gh-cli/spec.yaml', 'kits/wf-claude-account/spec.yaml', 'public/v1/index.html', 'public/v1/app.mjs', 'public/v1/app.css']) await put(join(root, path));
  const pi = join(root, 'kits/wf-pi');
  await put(join(pi, 'spec.yaml'), 'harness_id: pi\n');
  await put(join(pi, 'faravan-pi.sh'), '#!/bin/sh\nexit 0\n', true);
  const assets = join(pi, 'files/home/.faravan');
  await put(join(assets, 'install-pi.sh'), '#!/bin/sh\nexit 0\n', true);
  // A valid, empty gzip-compressed tar keeps this fixture self-contained.
  const payload = gzipSync(Buffer.alloc(1024));
  await put(join(assets, 'pi-payload.tgz'), payload);
  await put(join(assets, 'pi-payload.sha256'), createHash('sha256').update(payload).digest('hex') + '  pi-payload.tgz\n');
  await put(join(root, 'profiles/faravan-docker.json'), '{}');
  return { base, root, metadata };
}

test('complete disposable Linux layout is accepted with explicit Python dependency', async t => {
  const f = await fixture(t);
  await checkLinuxLayout(f.root, f.metadata);
  await put(f.metadata, 'Package: fixture\nDepends: coreutils, python3 (>= 3.10)\nDescription: fixture\n');
  await checkLinuxLayout(f.root, f.metadata, 'deb-control');
});
for (const [path, message] of [
  ['runtime/bin/node', /bundled Node/],
  ['bin/faravan', /product entrypoint/],
  ['../../bin/faravan', /faravan launcher/],
  ['../../bin/faravan', /faravan launcher/],
  ['package.json', /runtime package.json/],
  ['package-lock.json', /runtime package-lock.json/],
  ['node_modules/@fixture/sdk/package.json', /installed dependency/],
]) {
  test('missing ' + path + ' refuses layout readiness', async t => {
    const f = await fixture(t);
    await rm(join(f.root, path));
    await assert.rejects(checkLinuxLayout(f.root, f.metadata), message);
  });
}
test('present but nonexecutable bundled Node is rejected', async t => {
  const f = await fixture(t);
  await chmod(join(f.root, 'runtime/bin/node'), 0o644);
  await assert.rejects(checkLinuxLayout(f.root, f.metadata), /bundled Node/);
});
test('missing or malformed runtime metadata is rejected', async t => {
  const f = await fixture(t);
  await put(join(f.root, 'package-lock.json'), 'not-json');
  await assert.rejects(checkLinuxLayout(f.root, f.metadata), /package-lock.json/);
  await put(join(f.root, 'package-lock.json'), '{}');
  await assert.rejects(checkLinuxLayout(f.root, f.metadata), /invalid runtime package metadata/);
});
test('Python must be required, not merely suggested or an optional alternative', async t => {
  const f = await fixture(t);
  for (const [format, value] of [
    ['nfpm', 'name: fixture\nsuggests:\n  - python3\n'],
    ['nfpm', 'name: fixture\ndepends:\n  - nodejs\n'],
    ['deb-control', 'Depends: python3 | unrelated\n'],
    ['deb-control', 'Suggests: python3\n'],
  ]) {
    await put(f.metadata, value);
    await assert.rejects(checkLinuxLayout(f.root, f.metadata, format), /must require python3.*apt/);
  }
  await rm(f.metadata);
  await assert.rejects(checkLinuxLayout(f.root, f.metadata), /missing package dependency metadata/);
  await assert.rejects(checkLinuxLayout(f.root), /metadata is required/);
});
test('existing fixed entrypoint and both-agent pin verification remains enforced', async t => {
  const f = await fixture(t);
  const names = [], agents = [];
  await verifyStagedRuntime(f.root, { loadModule: async url => {
    names.push(fileURLToPath(url));
    if (url.endsWith('/sbx-image-pins.mjs')) return {
      loadImagePins: () => ({ fixture: true }),
      createImageArgs: (agent, pins) => { assert.equal(pins.fixture, true); agents.push(agent); },
    };
    return {};
  } });
  assert.deepEqual(names.map(path => path.slice(f.root.length + 1)), [
    'lib/v1/app.mjs', 'lib/executor.mjs', 'lib/docker-backend.mjs', 'lib/sbx-image-pins.mjs',
  ]);
  assert.deepEqual(agents, ['claude', 'codex']);
  await assert.rejects(verifyStagedRuntime(f.root, { loadModule: async url => {
    if (url.endsWith('/sbx-image-pins.mjs')) return {
      loadImagePins: () => ({}),
      createImageArgs: agent => { if (agent === 'codex') throw new Error('missing synthetic pin'); },
    };
    return {};
  } }), /codex is not pinned/);
});
test('verification errors and missing assets are not converted into success', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyStagedRuntime(f.root, { loadModule: async () => { throw new Error('synthetic import failure'); } }), /synthetic import failure/);
  await rm(join(f.root, 'public/v1/app.css'));
  await assert.rejects(verifyStagedRuntime(f.root, { loadModule: async () => ({
    loadImagePins: () => ({}), createImageArgs: () => [],
  }) }), /ENOENT/);
});

test('both packaging declarations require Python and verification follows bundling/launcher creation', async t => {
  const f = await fixture(t);
  const build = await readFile(join(packaging, 'build.sh'), 'utf8');
  const nfpm = await readFile(join(packaging, 'nfpm.yaml'), 'utf8');
  await put(f.metadata, nfpm);
  await checkLinuxLayout(f.root, f.metadata);
  const control = build.match(/cat >"\$root\/DEBIAN\/control" <<EOF\n([\s\S]*?)\nEOF/)[1];
  await put(f.metadata, control);
  await checkLinuxLayout(f.root, f.metadata, 'deb-control');
  const gate = build.indexOf('--linux-package');
  assert.ok(gate > build.indexOf('"$package_dir/bundle-node.sh"'));
  assert.ok(gate > build.indexOf('"$package_dir/bundle-guest-runtime.sh"'));
  assert.ok(gate > build.indexOf('chmod 0755 "$stage_dir/usr/bin/faravan"'));
  assert.ok(build.includes('--linux-package "$root/DEBIAN/control" deb-control'));
});

test('actual generated launcher refuses missing Python/Node without fallback and starts only after repair', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const build = await readFile(join(packaging, 'build.sh'), 'utf8');
  const launcher = build.match(/cat >"\$stage_dir\/usr\/bin\/faravan" <<'EOF'\n([\s\S]*?)\nEOF/)[1];
  const path = join(f.base, 'usr/bin/faravan');
  await put(path, launcher + '\n', true);
  const fakePath = join(f.base, 'fake-path');
  await mkdir(fakePath);
  // Only path-resolution utilities are real; runtime/Python are disposable stubs.
  for (const name of ['readlink', 'dirname']) await symlink('/usr/bin/' + name, join(fakePath, name));
  const run = () => spawnSync('/bin/sh', [path, 'fixture-argument'], {
    encoding: 'utf8', env: { PATH: fakePath, HOME: f.base },
  });
  await put(join(f.root, 'runtime/bin/node'), '#!/bin/sh\nprintf "synthetic runtime started\\n"\n', true);
  let result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Python 3 is required.*verification/);
  assert.match(result.stderr, /sudo apt install python3/);
  assert.doesNotMatch(result.stdout, /started/);
  await put(join(fakePath, 'python3'), '#!/bin/sh\nexit 0\n', true);
  await rm(join(f.root, 'runtime/bin/node'));
  // A system-named node stub must never be used as a fallback.
  await put(join(fakePath, 'node'), '#!/bin/sh\nprintf "wrong fallback\\n"\n', true);
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundled Node.*missing/);
  assert.doesNotMatch(result.stdout, /fallback|started/);
  await put(join(f.root, 'runtime/bin/node'), '#!/bin/sh\nprintf "synthetic runtime started\\n"\n', true);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic runtime started/);
});
