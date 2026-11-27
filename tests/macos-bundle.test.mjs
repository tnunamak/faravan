import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, lstat, readlink, symlink, chmod, copyFile, stat, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { root, machO, fatMachO, makeApp, fakeAppleTools, MIN_MACOS } from './helpers/macos-app.mjs';
import { bundleIdentity, machOArchs, parsePlist, signPlan, verifyApp } from '../packaging/macos/bundle-tool.mjs';

// Offline checks of the macOS bundle contract. Mach-O, fat and icns bytes are synthetic and lipo/iconutil
// are stand-ins, so these tests prove the merge and verification logic, not native compilation, a real
// lipo, codesign, Gatekeeper or LaunchServices. Those need the native macOS build legs.
const run = promisify(execFile);
const skip = process.platform === 'win32' ? 'requires POSIX shell tools' : false;
const universal = join(root, 'packaging/macos/build-universal.sh');
const verify = join(root, 'packaging/macos/verify-app.sh');
const exists = path => access(path).then(() => true, () => false);
const result = promise => promise.then(r => ({code: 0, ...r}), e => ({code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? ''}));

async function work(t) {
  // macOS tmpdir() is under /var, a symlink to /private/var; the scripts use physical paths (pwd -P), so the fixture does too.
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'spk-macbundle-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const tools = await fakeAppleTools(join(dir, 'apple tools'));
  return {dir, env: {...process.env, PATH: tools + delimiter + process.env.PATH, FAKE_TOOL_LOG: join(dir, 'tools.log')}};
}
async function legs(dir) {
  await mkdir(join(dir, 'arm leg')); await mkdir(join(dir, 'intel leg'));
  return {arm: await makeApp(join(dir, 'arm leg'), {arch: 'arm64'}), x64: await makeApp(join(dir, 'intel leg'), {arch: 'x86_64'})};
}
const merge = (w, arm, x64, out = join(w.dir, 'universal out')) => result(run('bash', [universal, arm, x64, join(out, 'Faravan.app')], {env: w.env}));

// --- icon -------------------------------------------------------------------------------------------

function decodePng(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let at = 8, header, idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at), type = buffer.toString('latin1', at + 4, at + 8), data = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = {width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12]};
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  assert.equal(header.depth, 8); assert.equal(header.color, 6, 'RGBA'); assert.equal(header.interlace, 0);
  const raw = inflateSync(Buffer.concat(idat)), stride = header.width * 4, pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0, b = y ? pixels[(y - 1) * stride + x] : 0, c = x >= 4 && y ? pixels[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      assert.notEqual(predictor, undefined, 'PNG filter ' + filter);
      pixels[y * stride + x] = (line[x] + predictor) & 255;
    }
  }
  return {...header, alpha: (x, y) => pixels[(y * header.width + x) * 4 + 3]};
}

test('the macOS icon set is complete, sized for iconutil and drawn on the Apple icon grid', async () => {
  const dir = join(root, 'packaging/macos/icon/Faravan.iconset');
  const expected = {};
  for (const size of [16, 32, 128, 256, 512]) { expected[`icon_${size}x${size}.png`] = size; expected[`icon_${size}x${size}@2x.png`] = size * 2; }
  assert.deepEqual((await readdir(dir)).sort(), Object.keys(expected).sort(), 'exactly the ten files iconutil reads');
  for (const [name, pixels] of Object.entries(expected)) {
    const png = decodePng(await readFile(join(dir, name)));
    assert.equal(png.width, pixels, name); assert.equal(png.height, pixels, name);
    if (pixels < 128) continue;
    // The 1024 grid puts an 824-point tile at 100 points from each edge: the corners stay clear.
    assert.equal(png.alpha(Math.round(pixels * 0.04), Math.round(pixels * 0.04)), 0, name + ': transparent margin');
    assert.equal(png.alpha(pixels >> 1, pixels >> 1), 255, name + ': opaque tile');
  }
  assert.match(await readFile(join(root, 'packaging/macos/icon/Faravan.svg'), 'utf8'), /viewBox="0 0 1024 1024"/);
});

// --- plists -----------------------------------------------------------------------------------------

test('the app and the notification helper have separate identities and real metadata', async () => {
  const raw = Symbol('xml');
  const fill = async path => { const xml = (await readFile(join(root, path), 'utf8')).replaceAll('@@VERSION@@', '1.2.3').replaceAll('@@MIN_MACOS@@', MIN_MACOS).replaceAll('@@BUNDLE_ID@@', 'com.faravan.app').replaceAll('@@HELPER_BUNDLE_ID@@', 'com.faravan.app.notify').replaceAll('@@APP_NAME@@', 'Faravan'); return {...parsePlist(xml), [raw]: xml}; };
  const app = await fill('packaging/macos/Info.plist'), helper = await fill('packaging/macos/notify/Info.plist');
  assert.equal(app.CFBundleIdentifier, 'com.faravan.app');
  assert.equal(app.CFBundleExecutable, 'faravan-launch');
  assert.equal(app.CFBundleIconFile, 'Faravan');
  assert.equal(app.CFBundlePackageType, 'APPL');
  assert.equal(app.LSUIElement, true);
  assert.equal(app.LSMinimumSystemVersion, MIN_MACOS);
  assert.equal(app.CFBundleShortVersionString, '1.2.3'); assert.equal(app.CFBundleVersion, '1.2.3');
  assert.equal(helper.CFBundleIdentifier, 'com.faravan.app.notify');
  assert.equal(helper.CFBundleExecutable, 'faravan-notify');
  assert.equal(helper.CFBundleDisplayName, 'Faravan', 'notifications are titled Faravan');
  assert.equal(helper.CFBundleIconFile, 'Faravan');
  assert.equal(helper.LSUIElement, true);
  assert.equal(helper.LSMinimumSystemVersion, MIN_MACOS);
  // The filled templates must also load in a full plist parser, not only in ours.
  const python = await run('sh', ['-c', 'command -v python3']).then(() => true, () => false);
  for (const xml of python ? [app, helper].map(p => p[raw]) : [])
    await run('python3', ['-I', '-c', 'import plistlib,sys; plistlib.loads(sys.argv[1].encode())', xml]);
});

test('bundle identity uses one app and notification identity', () => {
  assert.deepEqual(bundleIdentity(), { name: 'Faravan', id: 'com.faravan.app', helperId: 'com.faravan.app.notify' });
  assert.deepEqual(bundleIdentity({ name: 'Faravan', bundleId: 'com.faravan.app', helperBundleId: 'com.faravan.app.notify' }), {
    name: 'Faravan', id: 'com.faravan.app', helperId: 'com.faravan.app.notify',
  });
});

test('bundle verification accepts channel-specific app and notification identifiers', async t => {
  const w = await work(t), app = await makeApp(w.dir, { arch: 'universal' });
  const channel = { id: 'faravan', name: 'Faravan', bundleId: 'com.faravan.app', helperBundleId: 'com.faravan.app.notify' };
  await writeFile(join(app, 'Contents/Resources/faravan/channel.json'), JSON.stringify(channel));
  const appPlist = join(app, 'Contents/Info.plist'), helperPlist = join(app, 'Contents/Helpers/FaravanNotify.app/Contents/Info.plist');
  const appName = xml => xml.replaceAll('<key>CFBundleName</key><string>Faravan</string>', `<key>CFBundleName</key><string>${channel.name}</string>`).replaceAll('<key>CFBundleDisplayName</key><string>Faravan</string>', `<key>CFBundleDisplayName</key><string>${channel.name}</string>`);
  await writeFile(appPlist, appName((await readFile(appPlist, 'utf8')).replace('com.faravan.app', channel.bundleId)));
  await writeFile(helperPlist, appName((await readFile(helperPlist, 'utf8')).replace('com.faravan.app.notify', channel.helperBundleId)).replace('<key>CFBundleName</key><string>FaravanNotify</string>', `<key>CFBundleName</key><string>${channel.name}Notify</string>`));
  await assert.doesNotReject(verifyApp(app, { arch: 'universal' }));
});

// --- Mach-O detection -------------------------------------------------------------------------------

test('Mach-O detection reads thin and fat headers and ignores lookalikes', () => {
  assert.deepEqual(machOArchs(machO('arm64')), {fat: false, archs: ['arm64']});
  assert.deepEqual(machOArchs(machO('x86_64')), {fat: false, archs: ['x86_64']});
  assert.deepEqual(machOArchs(fatMachO([machO('arm64'), machO('x86_64')])), {fat: true, archs: ['arm64', 'x86_64']});
  const java = Buffer.from('cafebabe00000034' + '00'.repeat(32), 'hex');
  assert.equal(machOArchs(java), null, 'a Java class file shares the fat magic');
  assert.equal(machOArchs(Buffer.from('#!/bin/sh\n')), null);
  assert.equal(machOArchs(Buffer.alloc(0)), null);
  const truncated = fatMachO([machO('arm64'), machO('x86_64')]).subarray(0, 64);
  assert.throws(() => machOArchs(truncated), /slice .* outside the file/);
});

// --- universal merge --------------------------------------------------------------------------------

test('two native legs merge into one universal bundle: every Mach-O gets both slices', {skip}, async t => {
  const w = await work(t), {arm, x64} = await legs(w.dir);
  const merged = await merge(w, arm, x64);
  assert.equal(merged.code, 0, merged.stderr + merged.stdout);
  const app = join(w.dir, 'universal out/Faravan.app');
  for (const path of ['Contents/MacOS/faravan-launch', 'Contents/MacOS/faravan-tray', 'Contents/MacOS/faravan-process-identity', 'Contents/MacOS/faravan-update-exchange', 'Contents/Helpers/FaravanNotify.app/Contents/MacOS/faravan-notify', 'Contents/Resources/faravan/runtime/bin/node']) {
    assert.deepEqual(machOArchs(await readFile(join(app, path))), {fat: true, archs: ['arm64', 'x86_64']}, path);
    assert.equal((await stat(join(app, path))).mode & 0o777, 0o755, path + ' stays executable');
  }
  assert.equal((await readFile(join(w.dir, 'tools.log'), 'utf8')).trim().split('\n').length, 6, 'one lipo per Mach-O');
  assert.equal(await readFile(join(app, 'Contents/MacOS/faravan'), 'utf8'), await readFile(join(arm, 'Contents/MacOS/faravan'), 'utf8'));
  const link = join(app, 'Contents/Resources/faravan/node_modules/.bin/tool');
  assert.ok((await lstat(link)).isSymbolicLink(), 'npm bin links stay links');
  assert.equal(await readlink(link), '../tool/cli.js');
  assert.match(merged.stdout, /universal \(arm64 \+ x86_64\)/);
  assert.match(merged.stdout, /unsigned/i, 'the output says plainly that it is unsigned');
  assert.deepEqual(machOArchs(await readFile(join(arm, 'Contents/MacOS/faravan-tray'))).archs, ['arm64'], 'the legs are left as they were');
  const checked = await result(run('bash', [verify, app, 'universal'], {env: w.env}));
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /native checks skipped/i, 'verification says what it could not check off macOS');
});

const rejections = [
  ['a non-binary file differs', async (arm, x64) => writeFile(join(x64, 'Contents/Resources/faravan/lib/v1/app.mjs'), 'export const x64 = true;\n'), /Contents\/Resources\/faravan\/lib\/v1\/app\.mjs: contents differ/],
  ['a symlink points elsewhere', async (arm, x64) => { const l = join(x64, 'Contents/Resources/faravan/node_modules/.bin/tool'); await rm(l); await symlink('../other/cli.js', l); }, /node_modules\/\.bin\/tool: symlink targets differ/],
  ['a path is a symlink in one leg and a file in the other', async (arm, x64) => { const l = join(x64, 'Contents/Resources/faravan/node_modules/.bin/tool'); await rm(l); await writeFile(l, 'x'); }, /node_modules\/\.bin\/tool: symlink in arm64, file in x86_64/],
  ['a symlink leaves the bundle', async (arm, x64) => { for (const leg of [arm, x64]) await symlink('../../../../outside', join(leg, 'Contents/Resources/faravan/escape')); }, /escape: symlink .* leaves the bundle/],
  ['a symlink is absolute', async (arm, x64) => { for (const leg of [arm, x64]) await symlink('/usr/local/bin/node', join(leg, 'Contents/Resources/faravan/abs')); }, /abs: symlink .* is absolute/],
  ['a file exists in one leg only', async (arm, x64) => writeFile(join(arm, 'Contents/Resources/faravan/extra.txt'), 'only arm\n'), /extra\.txt: only in arm64/],
  ['permissions differ', async (arm, x64) => chmod(join(x64, 'Contents/Resources/faravan/lib/v1/app.mjs'), 0o755), /app\.mjs: modes differ \(644 vs 755\)/],
  ['the legs are swapped', null, /faravan-launch: arm64 leg has x86_64/],
  ['a binary is Mach-O in one leg only', async (arm, x64) => writeFile(join(x64, 'Contents/MacOS/faravan-tray'), '#!/bin/sh\n'), /faravan-tray: Mach-O in arm64 only/],
  ['a leg is already universal', async (arm, x64) => writeFile(join(arm, 'Contents/MacOS/faravan-tray'), fatMachO([machO('arm64'), machO('x86_64')])), /faravan-tray: arm64 leg is already fat/],
  ['a leg was signed before merging', async (arm, x64) => { for (const leg of [arm, x64]) { await mkdir(join(leg, 'Contents/_CodeSignature')); await writeFile(join(leg, 'Contents/_CodeSignature/CodeResources'), leg); } }, /legs must be unsigned: sign after merging/],
  ['a leg carries the development runtime', async (arm, x64) => writeFile(join(arm, 'Contents/Resources/faravan/runtime/LICENSE'), 'development runtime, not for release\n'), /development Node runtime .* never released/],
];
for (const [name, mutate, message] of rejections) {
  test('the universal merge refuses when ' + name + ', and keeps the previous output', {skip}, async t => {
    const w = await work(t), {arm, x64} = await legs(w.dir);
    if (mutate) await mutate(arm, x64);
    const out = join(w.dir, 'universal out');
    await mkdir(join(out, 'Faravan.app'), {recursive: true});
    await writeFile(join(out, 'Faravan.app/keep-me'), 'previous');
    const merged = mutate ? await merge(w, arm, x64, out) : await merge(w, x64, arm, out);
    assert.notEqual(merged.code, 0, 'merge must fail');
    assert.match(merged.stderr, message);
    assert.equal(await readFile(join(out, 'Faravan.app/keep-me'), 'utf8'), 'previous', 'nothing was replaced');
    assert.equal(await exists(join(w.dir, 'tools.log')), false, 'lipo never ran');
  });
}

// --- bundle verification ----------------------------------------------------------------------------

const verifyFailures = [
  ['a single-architecture bundle is checked as universal', 'arm64', async () => {}, /faravan-launch: has arm64, needs arm64 \+ x86_64/],
  ['an unlisted Mach-O (a native addon) is present', 'universal', async app => writeFile(join(app, 'Contents/Resources/faravan/node_modules/tool/addon.node'), fatMachO([machO('arm64'), machO('x86_64')])), /addon\.node: Mach-O outside the signing inventory/],
  ['the icon is missing', 'universal', async app => rm(join(app, 'Contents/Resources/Faravan.icns')), /Contents\/Resources\/Faravan\.icns: missing/],
  ['the icon is not an icns file', 'universal', async app => writeFile(join(app, 'Contents/Resources/Faravan.icns'), 'png'), /Faravan\.icns: not an icns file/],
  ['a placeholder was left in Info.plist', 'universal', async app => writeFile(join(app, 'Contents/Info.plist'), (await readFile(join(app, 'Contents/Info.plist'), 'utf8')).replace('0.0.1', '@@VERSION@@')), /unfilled placeholder/],
  ['the version disagrees with VERSION', 'universal', async app => writeFile(join(app, 'Contents/Resources/faravan/VERSION'), '9.9.9\n'), /CFBundleShortVersionString 0\.0\.1 but Resources\/faravan\/VERSION says 9\.9\.9/],
  ['the CLI is not executable', 'universal', async app => chmod(join(app, 'Contents/MacOS/faravan'), 0o644), /Contents\/MacOS\/faravan: not executable/],
  ['the CLI uses a system node', 'universal', async app => writeFile(join(app, 'Contents/MacOS/faravan'), '#!/usr/bin/env node\n', {mode: 0o755}), /Contents\/MacOS\/faravan: does not start the bundled runtime/],
  ['the Faravan PATH alias uses a system node', 'universal', async app => writeFile(join(app, 'Contents/MacOS/faravan'), '#!/usr/bin/env node\n', {mode: 0o755}), /Contents\/MacOS\/faravan: does not start the bundled runtime/],
  ['an unexpected file is in Contents/MacOS', 'universal', async app => writeFile(join(app, 'Contents/MacOS/notes.txt'), 'x'), /Contents\/MacOS\/notes\.txt: unexpected/],
  ['the helper shares the app identity', 'universal', async app => { const p = join(app, 'Contents/Helpers/FaravanNotify.app/Contents/Info.plist'); await writeFile(p, (await readFile(p, 'utf8')).replace('com.faravan.app.notify', 'com.faravan.app')); }, /CFBundleIdentifier com\.faravan\.app, expected com\.faravan\.app\.notify/],
  ['the bundle has the development runtime', 'universal', async app => writeFile(join(app, 'Contents/Resources/faravan/runtime/LICENSE'), 'development runtime, not for release\n'), /development Node runtime/],
];
for (const [name, arch, mutate, message] of verifyFailures) {
  test('verify-app fails when ' + name, {skip}, async t => {
    const w = await work(t), app = await makeApp(w.dir, {arch});
    await mutate(app);
    const checked = await result(run('bash', [verify, app, '--arch', 'universal'], {env: w.env}));
    assert.notEqual(checked.code, 0);
    assert.match(checked.stderr, message);
  });
}

test('verify-app accepts each native leg for its own architecture only', {skip}, async t => {
  const w = await work(t);
  for (const arch of ['arm64', 'x86_64']) {
    const dir = join(w.dir, arch); await mkdir(dir);
    const app = await makeApp(dir, {arch});
    assert.equal((await result(run('bash', [verify, app, '--arch', arch], {env: w.env}))).code, 0, arch);
    const other = arch === 'arm64' ? 'x86_64' : 'arm64';
    assert.match((await result(run('bash', [verify, app, '--arch', other], {env: w.env}))).stderr, new RegExp('has ' + arch + ', needs ' + other));
  }
  assert.equal((await result(run('bash', [verify, join(w.dir, 'arm64/Faravan.app'), '--arch', 'mips'], {env: w.env}))).code, 2);
});

// --- stage-app portability --------------------------------------------------------------------------

test('staging uses no GNU-only tool options (BSD xargs, install and cp)', {skip}, async t => {
  const w = await work(t), repo = join(w.dir, 'repo'), shims = join(w.dir, 'bsd shims'), dest = join(w.dir, 'staged app');
  await mkdir(join(repo, 'packaging'), {recursive: true}); await mkdir(shims);
  await copyFile(join(root, 'packaging/stage-app.sh'), join(repo, 'packaging/stage-app.sh'));
  await copyFile(join(root, 'packaging/check-staged-runtime.mjs'), join(repo, 'packaging/check-staged-runtime.mjs'));
  const piPayloadPath = join(w.dir, 'pi-payload.tgz');
  const piPayload = Buffer.from('pinned fixture payload');
  await writeFile(piPayloadPath, piPayload);
  const files = {'bin/faravan': '#!/bin/sh\n', 'bin/faravan helper': '#!/bin/sh\n', 'lib/a.mjs': '', 'lib/v1/lending-prices.json': '{}',
    'lib/v1/lending-kappa-calibration.json': '{}', 'lib/v1/telemetry/catalog.json': '{}', 'kits/k/f': '', 'profiles/faravan-docker.json': '{}',
    'kits/wf-pi/files/home/.faravan/pi-payload.sha256': createHash('sha256').update(piPayload).digest('hex') + '\n',
    'docs/protocol/job.schema.json': '{}', 'docs/security/credential-proxy-evidence.json': '{}', 'public/x.css': '',
    'coordinator/package.json': '{}', 'coordinator/package-lock.json': '{}',
    'LICENSE.md': 'licence\n', 'package.json': '{"name":"f","version":"1.0.0"}', 'package-lock.json': '{"name":"f","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"f","version":"1.0.0"}}}'};
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(repo, path)), {recursive: true}); await writeFile(join(repo, path), content); }
  // BSD tools reject GNU long options and GNU-only flags; these stand-ins do the same, then run the real tool.
  for (const [tool, bad] of [['xargs', '-r|--*'], ['install', '-D|--*'], ['cp', '--*'], ['sed', '-r|--*'], ['readlink', '-f|--*']]) {
    const real = (await run('sh', ['-c', 'command -v ' + tool])).stdout.trim();
    await writeFile(join(shims, tool), `#!/bin/sh\nfor arg do case "$arg" in ${bad}) echo "BSD ${tool}: unsupported option $arg" >&2; exit 64;; esac; done\nexec ${real} "$@"\n`, {mode: 0o755});
  }
  await run('bash', [join(repo, 'packaging/stage-app.sh'), dest, '0.0.1'], {
    env: {...process.env, PATH: shims + delimiter + process.env.PATH, FARAVAN_PI_PAYLOAD:piPayloadPath},
  });
  assert.deepEqual(await readFile(join(dest, 'kits/wf-pi/files/home/.faravan/pi-payload.tgz')), piPayload);
  assert.equal(await readFile(join(dest, 'bin/faravan helper'), 'utf8'), '#!/bin/sh\n', 'entry points with spaces are staged');
  assert.equal((await stat(join(dest, 'bin/faravan helper'))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(dest, 'VERSION'), 'utf8'), '0.0.1\n');
  assert.equal(await readFile(join(dest, 'LICENSE.md'), 'utf8'), 'licence\n', 'the licence is staged');
  assert.equal(await readFile(join(dest,'lib/v1/lending-prices.json'),'utf8'),'{}','the runtime price catalog is staged');
  assert.equal(await readFile(join(dest,'lib/v1/telemetry/catalog.json'),'utf8'),'{}','the runtime telemetry catalog is staged');
});

const expectedSignPlan = app => [
  {path:join(app,'Contents/Resources/faravan/runtime/bin/node'),entitlements:true},
  {path:join(app,'Contents/Helpers/FaravanNotify.app'),entitlements:false},
  {path:join(app,'Contents/MacOS/faravan-tray'),entitlements:false},
  {path:join(app,'Contents/MacOS/faravan-process-identity'),entitlements:false},
  {path:join(app,'Contents/MacOS/faravan-update-exchange'),entitlements:false},
  {path:join(app,'Contents/MacOS/faravan'),entitlements:false},
  {path:join(app,'Contents/MacOS/faravan'),entitlements:false},
  {path:app,entitlements:false},
];
test('sign plan includes both approved CLI wrappers before the bundle with Node-only entitlements',()=>{
  const app=join(tmpdir(),'Faravan preview.app'),plan=signPlan(app);
  assert.deepEqual(plan,expectedSignPlan(app),'fixed inside-out inventory includes the rename alias and legacy CLI');
  assert.deepEqual(plan.filter(item=>item.entitlements).map(item=>item.path),[join(app,'Contents/Resources/faravan/runtime/bin/node')]);
});
test('sign-plan CLI prints both script wrappers as plain before the outer bundle',async()=>{
  const app=join(tmpdir(),'Faravan preview.app');
  const {stdout,stderr}=await run(process.execPath,[join(root,'packaging/macos/bundle-tool.mjs'),'sign-plan',app]);
  assert.equal(stderr,'');
  assert.deepEqual(stdout.trimEnd().split('\n'),expectedSignPlan(app).map(item=>(item.entitlements?'entitlements':'plain')+'\t'+item.path));
});

// Exercise the verifier's real ESM payload, not a duplicate containment helper.
test('installed SDK oracle rejects escaped runtime, metadata and import entries before evaluation', {skip}, async t => {
  const source = await readFile(join(root, 'scripts/verify-macos-install.mjs'), 'utf8');
  const payloads = [...source.matchAll(/String\.raw`([\s\S]*?)`/g)];
  assert.equal(payloads.length, 1, 'one actual installed SDK payload');
  const payload = payloads[0][1];
  assert.match(source, /`,app\],\{cwd:runtimeRoot,env,timeout:15000,killSignal:'SIGKILL'\}/,
    'native caller supplies the relocated app and retains its bounded child');
  const dir = await mkdtemp(join(tmpdir(), 'sdk-containment-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  for (const kind of ['local', 'runtime-link', 'sdk-link', 'manifest-link', 'metadata-link', 'entry-link', 'entry-sibling']) {
    await t.test(kind, async () => {
      const base = join(dir, kind), app = join(base, 'Faravan.app');
      const runtime = join(app, 'Contents/Resources/faravan');
      const sdk = join(runtime, 'node_modules/@tnunamak/gozar');
      const outside = join(base, 'Faravan.app-outside');
      const marker = join(base, 'evaluated');
      const manifest = JSON.stringify({dependencies: {'@tnunamak/gozar': '0.5.0'}});
      const metadata = JSON.stringify({name: '@tnunamak/gozar', version: '0.5.0', type: 'module',
        exports: {import: './entry.mjs', default: './unused.mjs'}});
      const entry = 'import {writeFileSync} from "node:fs"; writeFileSync(' + JSON.stringify(marker) +
        ', "evaluated"); export function createGozar() { throw new Error("factory must not run"); }\n';
      await mkdir(sdk, {recursive: true});
      await mkdir(outside, {recursive: true});
      await writeFile(join(runtime, 'package.json'), manifest);
      await writeFile(join(sdk, 'package.json'), metadata);
      await writeFile(join(sdk, 'entry.mjs'), entry);
      if (kind === 'runtime-link') {
        const externalSdk = join(outside, 'node_modules/@tnunamak/gozar');
        await mkdir(externalSdk, {recursive: true});
        await writeFile(join(outside, 'package.json'), manifest);
        await writeFile(join(externalSdk, 'package.json'), metadata);
        await writeFile(join(externalSdk, 'entry.mjs'), entry);
        await rm(runtime, {recursive: true});
        await symlink(outside, runtime);
      } else if (kind === 'sdk-link') {
        await writeFile(join(outside, 'package.json'), metadata);
        await writeFile(join(outside, 'entry.mjs'), entry);
        await rm(sdk, {recursive: true});
        await symlink(outside, sdk);
      } else if (kind === 'manifest-link' || kind === 'metadata-link') {
        const destination = kind === 'manifest-link' ? join(runtime, 'package.json') : join(sdk, 'package.json');
        await writeFile(join(outside, 'package.json'), kind === 'manifest-link' ? manifest : metadata);
        await rm(destination);
        await symlink(join(outside, 'package.json'), destination);
      } else if (kind === 'entry-link' || kind === 'entry-sibling') {
        // The sibling is inside runtime but outside SDK, sharing its string prefix.
        const entryRoot = kind === 'entry-sibling' ? sdk + '-outside' : outside;
        await mkdir(entryRoot, {recursive: true});
        await writeFile(join(entryRoot, 'entry.mjs'), entry);
        await rm(join(sdk, 'entry.mjs'));
        await symlink(join(entryRoot, 'entry.mjs'), join(sdk, 'entry.mjs'));
      }
      const env = {...process.env};
      delete env.NODE_OPTIONS; delete env.NODE_PATH;
      const checked = await result(run(process.execPath, ['--input-type=module', '--eval', payload, app],
        {cwd: runtime, env, timeout: 15000, killSignal: 'SIGKILL'}));
      if (kind === 'local') {
        assert.equal(checked.code, 0, checked.stderr);
        assert.equal(await readFile(marker, 'utf8'), 'evaluated', 'positive control actually imports');
      } else {
        assert.notEqual(checked.code, 0, 'escaped fixture must fail');
        assert.match(checked.stderr, /must remain inside/, 'fails at the containment gate');
        assert.equal(await exists(marker), false, 'outside entry was never evaluated');
      }
    });
  }
});

async function treeEvidence(dir) {
  const out=[];
  async function visit(path,relative) {
    const s=await lstat(path),mode=s.mode&0o777;
    if(s.isSymbolicLink())out.push([relative,'link',mode,await readlink(path)]);
    else if(s.isDirectory()) {out.push([relative,'dir',mode]);for(const name of (await readdir(path)).sort())await visit(join(path,name),relative+'/'+name);}
    else out.push([relative,'file',mode,(await readFile(path)).toString('hex')]);
  }
  await visit(dir,'');return out;
}
async function publicationFixture(t,mode,name='Faravan.app') {
  const w=await work(t),{arm,x64}=await legs(w.dir),out=join(w.dir,'publish out'),app=join(out,name);
  await mkdir(join(app,'nested'),{recursive:true});
  await writeFile(join(app,'nested','sentinel'),Buffer.from([0,1,255,10]));
  await chmod(join(app,'nested','sentinel'),0o751);await chmod(join(app,'nested'),0o750);
  await symlink('nested/sentinel',join(app,'sentinel-link'));
  const before=await treeEvidence(app),inputs=[await treeEvidence(arm),await treeEvidence(x64)];
  const shims=join(w.dir,'fault tools');await mkdir(shims);
  const log=join(w.dir,'operations.jsonl'),gate=join(w.dir,'release'),entered=join(w.dir,'entered');
  const realMv=(await run('sh',['-c','command -v mv'])).stdout.trim();
  const realLipo=join(w.env.PATH.split(delimiter)[0],'lipo');
  for(const tool of ['mv','lipo','node']) {
    const code="\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2),tool=TOOL,mode=MODE,app=APP,log=LOG;\nfs.appendFileSync(log,JSON.stringify([tool,...args])+'\\n');\nif(tool==='mv') {\n  const publication=args[1]===app&&!args[0].endsWith('/rollback/previous.app');\n  const backup=args[0]===app,restore=args[0].endsWith('/rollback/previous.app');\n  if((mode==='publish'||mode==='rollback')&&publication || mode==='backup'&&backup || mode==='rollback'&&restore)process.exit(71);\n}\nif(tool==='lipo'&&mode==='lipo')process.exit(72);\nif(tool==='node'&&args[1]==='verify'&&mode==='verify')process.exit(73);\nasync function main(){\n  if(tool==='lipo'&&mode==='held'&&!fs.existsSync(GATE)){\n    fs.writeFileSync(ENTERED,args[args.indexOf('-output')+1]);\n    const until=Date.now()+15000;\n    while(!fs.existsSync(GATE)){if(Date.now()>until)process.exit(74);await new Promise(r=>setTimeout(r,10));}\n  }\n  const r=spawnSync(REAL,args,{stdio:'inherit'});\n  if(r.error)throw r.error;\n  process.exit(r.status??1);\n}\nmain().catch(()=>process.exit(75));\n".replace('TOOL',JSON.stringify(tool)).replace('MODE',JSON.stringify(mode)).replace('APP',JSON.stringify(app)).replace('LOG',JSON.stringify(log)).replaceAll('GATE',JSON.stringify(gate)).replace('ENTERED',JSON.stringify(entered)).replace('REAL',JSON.stringify(tool==='mv'?realMv:tool==='lipo'?realLipo:process.execPath));
    await writeFile(join(shims,tool),'#!'+process.execPath+'\n'+code,{mode:0o755});
  }
  const unheldEnv={...w.env,FARAVAN_BUILD_NODE:process.execPath};
  w.env={...w.env,PATH:shims+delimiter+w.env.PATH,FARAVAN_BUILD_NODE:join(shims,'node')};
  const scripts=join(w.dir,'copied packaging');await mkdir(scripts);
  for(const file of ['build-universal.sh','verify-app.sh','bundle-tool.mjs']) {
    await copyFile(join(root,'packaging/macos',file),join(scripts,file));
    await chmod(join(scripts,file),0o755);
  }
  const invoke=(target=app,{held=true}={})=>result(run('bash',[join(scripts,'build-universal.sh'),arm,x64,target],
    {env:held?w.env:unheldEnv,timeout:30000}));
  return {w,arm,x64,out,app,before,inputs,log,gate,entered,invoke};
}
test('universal publication requires a lowercase .app suffix before starting any build',{skip},async t=>{
  const f=await publicationFixture(t,'verify','Faravan.APP'),r=await f.invoke();
  assert.equal(r.code,2,r.stderr);
  assert.match(r.stderr,/output basename must end in lowercase \.app/);
  assert.equal(await exists(f.log),false,'neither comparison nor publication ran');
  assert.deepEqual(await treeEvidence(f.app),f.before);
  assert.deepEqual(await readdir(f.out),['Faravan.APP']);
});

for(const mode of ['publish','backup','verify','lipo','rollback'])test('universal publication preserves complete previous tree on '+mode+' failure',{skip},async t=>{
  const f=await publicationFixture(t,mode),r=await f.invoke();
  assert.notEqual(r.code,0);assert.doesNotMatch(r.stdout,/build-universal: .* is universal/);
  const ops=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
  if(mode==='publish'||mode==='backup'||mode==='rollback') {
    const verifyAt=ops.findIndex(a=>a[0]==='node'&&a[2]==='verify'),moveAt=ops.findIndex(a=>a[0]==='mv');
    assert.ok(verifyAt>=0&&moveAt>verifyAt,'publication follows real staged verification');
    assert.equal(ops.filter(a=>a[0]==='lipo').length,6);
  } else assert.equal(ops.filter(a=>a[0]==='mv').length,0);
  if(mode==='rollback') {
    const backupMove=ops.find(a=>a[0]==='mv'&&a[1]===f.app),backup=backupMove[2];
    assert.ok(r.stderr.includes(backup),'recovery location is reported');
    assert.deepEqual(await treeEvidence(backup),f.before);assert.equal(await exists(f.app),false);
    await run('mv',[backup,f.app]);
    await rm(dirname(dirname(backup)),{recursive:true,force:true});
  }
  assert.deepEqual(await treeEvidence(f.app),f.before);
  assert.deepEqual(await readdir(f.out),['Faravan.app'],'only owned lock/stage were removed');
  assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs);
});
test('second universal publisher refuses held output lock without touching the first owned stage',{skip},async t=>{
  const f=await publicationFixture(t,'held'),first=f.invoke();
  try {
    const deadline=Date.now()+10000;
    while(!await exists(f.entered)){assert.ok(Date.now()<deadline,'first publisher entered lipo');await new Promise(r=>setTimeout(r,10));}
    const stage=dirname(await readFile(f.entered,'utf8')),beforeStage=await treeEvidence(stage);
    const second=await f.invoke();
    assert.notEqual(second.code,0);assert.match(second.stderr,/another build owns/);
    assert.deepEqual(await treeEvidence(stage),beforeStage);assert.deepEqual(await treeEvidence(f.app),f.before);
    await writeFile(f.gate,'release');
    const r=await first;assert.equal(r.code,0,r.stderr);
    assert.deepEqual(await readdir(f.out),['Faravan.app']);
    assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs);
    const beforeRetry=(await readFile(f.log,'utf8')).trim().split('\n').length;
    const retry=await f.invoke();
    assert.equal(retry.code,0,retry.stderr);
    const retryOps=(await readFile(f.log,'utf8')).trim().split('\n').slice(beforeRetry).map(JSON.parse);
    assert.ok(retryOps.some(op=>op[0]==='mv'&&op[2]===f.app),'retry publishes to the same destination');
    await verifyApp(f.app,{arch:'universal'});
    assert.deepEqual(await readdir(f.out),['Faravan.app'],'retry removes its owned lock and scratch');
    assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs);
  } finally {await writeFile(f.gate,'release');await first;}
});

test('single-leg publisher refuses the universal publisher’s exact lock without staging',{skip},async t=>{
  const f=await publicationFixture(t,'held');
  // An exported scratch source tree supplies exactly the files needed to reach the lock.
  const repo=join(f.w.dir,'single-leg source'),mac=join(repo,'packaging','macos'),tools=join(repo,'tools');
  await mkdir(join(mac,'launcher'),{recursive:true});
  await mkdir(join(repo,'lib'),{recursive:true});await mkdir(tools);
  for(const path of ['packaging/macos/build-app.sh','packaging/macos/launcher/main.swift','lib/channel-identity.mjs'])
    await copyFile(join(root,path),join(repo,path));
  const forbidden=join(repo,'contender staging attempted');
  const deny='#!/bin/sh\nprintf "%s\\n" forbidden > "$CONTENDER_STAGE_MARKER"\nexit 97\n';
  for(const path of [join(repo,'packaging','stage-app.sh'),join(tools,'mktemp')])
    await writeFile(path,deny,{mode:0o755});
  await writeFile(join(tools,'uname'),'#!/bin/sh\n[ "$1" = "-m" ] || exit 98\nprintf "%s\\n" x86_64\n',{mode:0o755});
  const lock=join(f.out,'.Faravan.build.lock'),first=f.invoke();
  try {
    const deadline=Date.now()+10000;
    while(!await exists(f.entered)){
      assert.ok(Date.now()<deadline,'universal publisher reached held fake lipo');
      await new Promise(r=>setTimeout(r,10));
    }
    const stage=dirname(await readFile(f.entered,'utf8'));
    const stageBefore=await treeEvidence(stage),lockBefore=await lstat(lock);
    const outBefore=(await readdir(f.out)).sort();
    const contender=await result(run('bash',[join(mac,'build-app.sh'),f.out],{timeout:5000,env:{
      PATH:tools+delimiter+f.w.env.PATH,HOME:repo,PACKAGE_SOURCE_SHA:'3'.repeat(40),PACKAGE_VERSION:'1.0.0',
      ARCH:'x64',FARAVAN_NODE_BIN:process.execPath,CONTENDER_STAGE_MARKER:forbidden,
    }}));
    assert.equal(contender.code,2,contender.stderr);
    assert.ok(contender.stderr.includes('build-app: another build owns '+lock+'; leave it alone until that build exits'));
    assert.equal(await exists(forbidden),false,'the contender never reached mktemp or staging');
    assert.deepEqual((await readdir(f.out)).sort(),outBefore);
    assert.deepEqual(await treeEvidence(f.app),f.before);
    assert.deepEqual(await treeEvidence(stage),stageBefore);
    const lockAfter=await lstat(lock);
    assert.deepEqual([lockAfter.dev,lockAfter.ino],[lockBefore.dev,lockBefore.ino]);
    assert.deepEqual(await readdir(lock),[]);
    await writeFile(f.gate,'release');
    const r=await first;
    assert.equal(r.code,0,r.stderr);
    assert.match(r.stdout,/build-universal: .* is universal/);
    assert.deepEqual(await readdir(f.out),['Faravan.app']);
    const checked=await result(run('bash',[verify,f.app,'--arch','universal'],{env:f.w.env}));
    assert.equal(checked.code,0,checked.stderr);
    assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs);
  } finally {await writeFile(f.gate,'release');await first;}
});

test('universal publisher refuses the single-leg publisher lock',{skip},async t=>{
  const f=await publicationFixture(t,'single-leg'),repo=join(f.w.dir,'single-leg source');
  for(const dir of ['packaging/macos/launcher','lib'])await mkdir(join(repo,dir),{recursive:true});
  for(const file of ['packaging/macos/build-app.sh','packaging/macos/launcher/main.swift','lib/channel-identity.mjs'])
    await copyFile(join(root,file),join(repo,file));
  const shim=`#!/usr/bin/env bash
set -eu
printf '%s' "$1" > "${f.entered}.tmp"
mv "${f.entered}.tmp" "${f.entered}"
for ((i=0; i<1500; i++)); do
  [ ! -f "${f.gate}" ] || exit 77
  sleep 0.01
done
exit 78
`;
  await writeFile(join(repo,'packaging/stage-app.sh'),shim,{mode:0o755});
  const env={PATH:f.w.env.PATH,PACKAGE_SOURCE_SHA:'1'.repeat(40),FARAVAN_NODE_BIN:process.execPath};
  const first=result(run('bash',[join(repo,'packaging/macos/build-app.sh'),f.out],{env,timeout:30000}));
  const lock=join(f.out,'.Faravan.build.lock');
  try {
    const deadline=Date.now()+10000;
    while(!await exists(f.entered)){assert.ok(Date.now()<deadline,'single-leg publisher entered stage-app');await new Promise(r=>setTimeout(r,10));}
    const stage=join(await readFile(f.entered,'utf8'),'../../../..'),beforeStage=await treeEvidence(stage);
    const beforeOut=(await readdir(f.out)).sort();
    assert.ok(await exists(lock));
    const second=await f.invoke();
    assert.equal(second.code,2,second.stderr);assert.match(second.stderr,/build-universal: another build owns/);
    assert.ok(second.stderr.includes(lock));
    assert.deepEqual((await readdir(f.out)).sort(),beforeOut);
    assert.deepEqual(await treeEvidence(stage),beforeStage);
    assert.deepEqual(await treeEvidence(f.app),f.before);
    assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs);
  } finally {await writeFile(f.gate,'release');await first;}
  const stopped=await first;assert.equal(stopped.code,77,stopped.stderr);
  assert.deepEqual(await readdir(f.out),['Faravan.app']);
  assert.deepEqual(await treeEvidence(f.app),f.before);
  assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs);
});

test('universal publisher follows case behavior of the owned output volume',{skip},async t=>{
  const f=await publicationFixture(t,'held','CaseProbe.app'),other=join(f.out,'caseprobe.app');
  const sentinel=join(f.out,'CaseVolumeWitness'),alternate=join(f.out,'casevolumewitness');
  const bytes=Buffer.from([39,0,255,10]);
  await writeFile(sentinel,bytes,{flag:'wx'});
  let aliases;
  try {
    aliases=await readFile(alternate).then(value=>{
      assert.deepEqual(value,bytes,'alternate spelling reads the owned sentinel');
      return true;
    },error=>{
      if(error.code==='ENOENT')return false;
      throw error;
    });
  } finally {await rm(sentinel);}
  t.diagnostic('Output volume is case-'+(aliases?'insensitive (alternate spelling aliases)':'sensitive (distinct spellings)'));
  if(!aliases){
    await mkdir(other);
    await writeFile(join(other,'predecessor'),bytes);
  }
  const lock=join(f.out,'.CaseProbe.build.lock'),first=f.invoke();
  try {
    const deadline=Date.now()+10000;
    while(!await exists(f.entered)){
      assert.ok(Date.now()<deadline,'first publisher entered held fake lipo');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const heldOutput=await readFile(f.entered,'utf8'),stage=dirname(heldOutput);
    assert.equal(dirname(stage),await realpath(f.out),'stage is directly under the owned output directory');
    assert.match(stage.slice(dirname(stage).length+1),/^\.CaseProbe\.build\.[A-Za-z0-9]+$/);
    assert.equal(heldOutput,join(stage,'merged.lipo'),'witness points at that stage’s lipo scratch');
    assert.ok((await lstat(stage)).isDirectory(),'stage itself is a real directory');
    const candidate=join(stage,'payload','CaseProbe.app');
    const candidateBefore=await treeEvidence(candidate);
    assert.deepEqual(candidateBefore,f.inputs[0],'held first merge has the full copied input tree');
    const stageBefore=await treeEvidence(stage),lockBefore=await lstat(lock);
    const second=await f.invoke(other,{held:false});
    if(aliases){
      assert.notEqual(second.code,0);
      assert.match(second.stderr,/another build owns/);
      assert.deepEqual(await treeEvidence(other),f.before,'aliased predecessor stays intact');
    }else{
      assert.equal(second.code,0,second.stderr);
      await verifyApp(other,{arch:'universal'});
      assert.equal(await exists(join(other,'predecessor')),false);
    }
    assert.deepEqual(await treeEvidence(f.app),f.before,'first predecessor unchanged before release');
    assert.deepEqual(await treeEvidence(candidate),candidateBefore,'full candidate including launcher siblings is unchanged');
    assert.deepEqual(await treeEvidence(stage),stageBefore,'first stage is unchanged before release');
    assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs,'both input legs are untouched during contention');
    const lockAfter=await lstat(lock);
    assert.equal(lockAfter.ino,lockBefore.ino,'first still owns the same lock');
    assert.equal(lockAfter.dev,lockBefore.dev);
    assert.deepEqual(await readdir(lock),[]);
    await writeFile(f.gate,'release');
    const done=await first;assert.equal(done.code,0,done.stderr);
    await verifyApp(f.app,{arch:'universal'});
    assert.deepEqual((await readdir(f.out)).sort(),aliases?['CaseProbe.app']:['CaseProbe.app','caseprobe.app']);
    assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs);
  } finally {await writeFile(f.gate,'release');await first;}
});

for(const mode of ['success','verify','publish'])test('universal previous.app output has isolated candidate and rollback on '+mode,{skip},async t=>{
  const f=await publicationFixture(t,mode,'previous.app'),r=await f.invoke();
  const ops=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
  const verifyAt=ops.findIndex(a=>a[0]==='node'&&a[2]==='verify');
  assert.ok(verifyAt>=0,'the real copied verifier is reached');
  assert.equal(ops.filter(a=>a[0]==='lipo').length,6);
  if(mode==='success') {
    assert.equal(r.code,0,r.stderr);
    assert.match(r.stdout,/build-universal: .* is universal/);
    const expectedDir=join(f.w.dir,'expected');await mkdir(expectedDir);
    const expected=await makeApp(expectedDir,{arch:'universal'});
    assert.deepEqual(await treeEvidence(f.app),await treeEvidence(expected),'exact new tree, with no nested previous artifact');
    await assert.doesNotReject(verifyApp(f.app,{arch:'universal'}));
  } else {
    assert.notEqual(r.code,0);
    assert.doesNotMatch(r.stdout,/build-universal: .* is universal/);
    assert.deepEqual(await treeEvidence(f.app),f.before,'restore exact old bytes, modes and symlink');
  }
  const moves=ops.filter(a=>a[0]==='mv');
  if(mode==='verify')assert.equal(moves.length,0,'verification failure cannot move old output');
  else {
    assert.ok(ops.findIndex(a=>a[0]==='mv')>verifyAt,'verify before moving old output');
    assert.equal(moves.length,mode==='publish'?3:2);
    assert.equal(moves[0][1],f.app,'backup moves the old output');
    assert.equal(moves[1][2],f.app,'publication targets requested basename');
    assert.notEqual(moves[0][2],moves[1][1],'backup and candidate never alias');
    if(mode==='publish')assert.deepEqual(moves[2],['mv',moves[0][2],f.app],'failed final rename restores old tree');
  }
  assert.deepEqual(await readdir(f.out),['previous.app'],'no owned stage or lock leak');
  assert.deepEqual([await treeEvidence(f.arm),await treeEvidence(f.x64)],f.inputs,'input trees remain untouched');
});
