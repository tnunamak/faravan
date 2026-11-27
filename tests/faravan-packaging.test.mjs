import './helpers/no-browser.mjs';
// Every package ships the CLI under its new name, bin/faravan, beside the faravan shim. stage-app.sh is the staging
// step that the deb, tarball, macOS and Windows builds share, so the first test checks a tree it actually stages.
// The other tests check each format's own launcher; those builds need tools that not every host has.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {plistSedReplacement} from '../lib/channel-identity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
function filesUnder(directory, prefix = '') {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) return filesUnder(join(directory, entry.name), relativePath);
    return entry.isFile() ? [relativePath] : [];
  });
}
// Give the real stager and validator a disposable checkout with an independently
// pinned guest archive. A no-op npm cannot build the checked-in guest payload,
// and these tests exercise staging, not the Linux-only guest dependency build.
function stagingFixture(work) {
  const checkout = join(work, 'checkout');
  for (const path of [
    'packaging/stage-app.sh', 'packaging/check-staged-runtime.mjs',
    'bin', 'lib', 'kits', 'public', 'docs/protocol',
    'docs/security/credential-proxy-evidence.json', 'profiles/faravan-docker.json',
    'package.json', 'package-lock.json', 'LICENSE.md',
  ]) {
    const destination = join(checkout, path);
    mkdirSync(dirname(destination), {recursive: true});
    cpSync(join(root, path), destination, {recursive: true, verbatimSymlinks: true});
  }
  const vendor = join(root, 'vendor');
  if (existsSync(vendor)) {
    cpSync(vendor, join(checkout, 'vendor'), {recursive: true, verbatimSymlinks: true});
  }

  const guest = join(work, 'guest');
  const module = join(guest, 'node_modules', 'fixture-pi');
  mkdirSync(module, {recursive: true});
  writeFileSync(join(module, 'package.json'), '{"name":"fixture-pi","version":"0.0.0"}\n');
  const payload = join(work, 'pi-payload.tgz');
  execFileSync('tar', ['-czf', payload, '-C', guest, 'node_modules'], {stdio: 'pipe'});
  const digest = createHash('sha256').update(readFileSync(payload)).digest('hex');
  writeFileSync(join(checkout, 'kits/wf-pi/files/home/.faravan/pi-payload.sha256'), digest + '\n');
  return {stage: join(checkout, 'packaging/stage-app.sh'), payload};
}


test('the staged tree holds bin/faravan beside the faravan shim', t => {
  const work = mkdtempSync(join(tmpdir(), 'faravan-stage-'));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const {stage, payload} = stagingFixture(work);
  // Staging runs `npm ci` for production dependencies. A stub keeps the test off the network; the copy steps are real.
  mkdirSync(join(work, 'stub'));
  writeFileSync(join(work, 'stub/npm'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const dest = join(work, 'app');
  execFileSync('bash', [stage, dest, '0.0.0-test'], {
    env: {...process.env, PATH: `${join(work, 'stub')}:${process.env.PATH}`,
      FARAVAN_PI_PAYLOAD: payload, FARAVAN_REFRESH_PRICES: '0'},
    stdio: 'pipe',
  });
  assert.deepEqual(readFileSync(join(dest, 'kits/wf-pi/files/home/.faravan/pi-payload.tgz')),
    readFileSync(payload), 'the verified guest archive is staged byte-for-byte');
  for (const name of ['faravan', 'faravan']) {
    assert.ok(existsSync(join(dest, 'bin', name)), `bin/${name} is missing from the staged tree`);
    assert.ok(statSync(join(dest, 'bin', name)).mode & 0o111, `bin/${name} is not executable`);
  }
  assert.equal(readFileSync(join(dest, 'bin/faravan'), 'utf8'), readFileSync(join(dest, 'bin/faravan'), 'utf8'),
    'bin/faravan runs the same program as the shim');
  const sourceFiles = filesUnder(join(root, 'public/v1')).sort();
  const stagedFiles = filesUnder(join(dest, 'public/v1')).sort();
  assert.deepEqual(stagedFiles, sourceFiles, 'the staged app contains every public/v1 file and no extras');
  for (const name of sourceFiles) {
    assert.deepEqual(readFileSync(join(dest, 'public/v1', name)), readFileSync(join(root, 'public/v1', name)),
      `public/v1/${name} differs in the staged tree`);
  }
});

test('each package format launches the same command under the new name', () => {
  assert.match(read('packaging/build.sh'), /usr\/bin\/faravan/, 'the deb launcher');
  assert.match(read('packaging/nfpm.yaml'), /dst: \/usr\/bin\/faravan/, 'the deb contents');
  assert.match(read('packaging/smoke.sh'), /test -x \/usr\/bin\/faravan/, 'the deb smoke test');
  assert.match(read('bin/faravan-install.sh'), /bin\/faravan/, 'the tarball installer');
  assert.match(read('packaging/macos/build-app.sh'), /Contents\/MacOS\/faravan/, 'the macOS command');
  assert.match(read('packaging/macos/launcher/cli.sh'), /exec "\$root\/runtime\/bin\/node"/, 'the macOS commands use the bundled runtime');
  assert.doesNotMatch(read('packaging/macos/launcher/cli.sh'), /env\s+node/);
  assert.match(read('packaging/macos/bundle-tool.mjs'), /MACOS_ENTRIES = \[[^\]]*'faravan'/, 'the macOS allowlist');
  assert.match(read('packaging/brew/faravan.rb'), /\(bin\/"faravan"\)\.write/, 'the Homebrew command');
  assert.match(read('packaging/windows/build-layout.ps1'), /'faravan\.cmd'/, 'the Windows command');
  assert.match(read('packaging/windows/build-layout.ps1'), /-o "\$layout\\faravan\.exe" \.\/cmd\/faravan-cli/, 'the Windows execution-alias launcher');
  assert.match(read('packaging/windows/AppxManifest.template.xml'), /Category="windows\.appExecutionAlias"[\s\S]*Alias="faravan\.exe"/, 'the Windows CLI alias');
  assert.match(read('tray/cmd/faravan-cli/main.go'), /app", "runtime", "node\.exe"[\s\S]*app", "bin", "faravan"/, 'the Windows alias uses the packaged Node runtime');
  assert.match(read('packaging/build.sh'), /exec "\$root\/runtime\/bin\/node"/, 'the Linux command uses the packaged Node runtime');
});

test('macOS channel preflight failures preserve the previous app artifact', t => {
  const work = mkdtempSync(join(tmpdir(), 'faravan-macos-preflight-'));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  const out = join(work, 'out');
  const app = join(out, 'Faravan.app');
  mkdirSync(app, {recursive:true});
  const sentinel = join(app, 'keep.txt');
  writeFileSync(sentinel, 'previous build');
  const stub = join(work, 'stub');
  mkdirSync(stub);
  writeFileSync(join(stub, 'uname'), '#!/bin/sh\necho x86_64\n', {mode:0o755});
  const runInvalid = env => spawnSync('bash', [join(root, 'packaging/macos/build-app.sh'), out], {
    encoding:'utf8', env:{...process.env, PATH:`${stub}:${process.env.PATH}`, ARCH:'x64', ...env},
  });
  const cases = [
    ['conflicting channel flags', {FARAVAN_PREVIEW_LABEL:'preview', FARAVAN_CHANNEL_FILE:sentinel}],
    ['invalid label', {FARAVAN_PREVIEW_LABEL:'bad label'}],
    ['malformed channel file', {FARAVAN_CHANNEL_FILE:sentinel}],
    ['missing channel file', {FARAVAN_CHANNEL_FILE:join(work, 'missing.json')}],
    ['extra positional argument', {}],
  ];
  for (const [name, env] of cases) {
    const args = name === 'extra positional argument'
      ? ['bash', join(root, 'packaging/macos/build-app.sh'), out, 'unexpected']
      : null;
    const result = args
      ? spawnSync(args[0], args.slice(1), {encoding:'utf8', env:{...process.env, PATH:`${stub}:${process.env.PATH}`, ARCH:'x64'}})
      : runInvalid(env);
    assert.notEqual(result.status, 0, `${name} is rejected`);
    assert.equal(readFileSync(sentinel, 'utf8'), 'previous build', `${name} leaves the previous app intact`);
  }
  const invalidIdentifier = join(work, 'invalid-bundle.json');
  writeFileSync(invalidIdentifier, JSON.stringify({id:'preview', name:'Preview', dataFolder:'Preview', bundleId:'com.example#bad', helperBundleId:'com.example.preview.notify', launchAgentLabel:'com.example.preview.agent', linuxPrefix:'preview'}));
  const invalidBundle = runInvalid({FARAVAN_CHANNEL_FILE:invalidIdentifier});
  assert.notEqual(invalidBundle.status, 0, 'unsafe bundle identifier is rejected during preflight');
  assert.equal(readFileSync(sentinel, 'utf8'), 'previous build', 'invalid bundle identifier preserves prior output');
});

test('plist substitutions preserve XML text and escape sed replacement syntax', () => {
  const replacement = plistSedReplacement('R&D# <café> \\');
  const output = execFileSync('sed', ['s#@@VALUE@@#' + replacement + '#g'], {encoding:'utf8', input:'<string>@@VALUE@@</string>\n'});
  assert.equal(output, '<string>R&amp;D# &lt;café&gt; \\</string>\n');
});


test('staging requires offline npm even when the environment permits network access', t => {
  const work = mkdtempSync(join(tmpdir(), 'faravan-stage-offline-'));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  const {stage, payload} = stagingFixture(work);
  const stub = join(work, 'stub'), capture = join(work, 'npm-args');
  mkdirSync(stub);
  writeFileSync(join(stub, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$NPM_ARGS"\n', {mode:0o755});
  execFileSync('bash', [stage, join(work, 'app'), '0.0.0-test'], {
    env:{...process.env, PATH:`${stub}:${process.env.PATH}`, NPM_ARGS:capture,
      FARAVAN_PI_PAYLOAD:payload, FARAVAN_REFRESH_PRICES:'0', npm_config_offline:'false'}, stdio:'pipe',
  });
  const args = readFileSync(capture, 'utf8').trim().split('\n');
  assert.equal(args[0], 'ci');
  assert.ok(args.includes('--offline'), 'staging must explicitly prohibit npm registry fetching');
  assert.ok(args.includes('--ignore-scripts'));
});


test('Homebrew Gozar smoke payload checks the installed identity and callable export offline', async t => {
  // Execute the formula's source, not a second implementation of its assertions.
  // Keep the quoted heredoc: Ruby interpolation must not change the JS payload.
  const formula = read('packaging/brew/faravan.rb');
  const payloads = [...formula.matchAll(
    /^[ \t]*system Formula\["node"\]\.opt_bin\/"node", "--input-type=module", "--eval", <<~'JS'\r?\n([\s\S]*?)^[ \t]*JS[ \t]*\r?$/gm,
  )];
  assert.equal(payloads.length, 1, 'expected exactly one quoted Node ESM smoke payload');
  const payload = payloads[0][1];
  const cases = [
    {name:'matching identity and callable export', evaluated:true},
    {name:'matching vendored candidate', pin:'file:vendor/tnunamak-gozar-0.5.1.tgz', version:'0.5.1', evaluated:true},
    {name:'installed version differs from vendored candidate', pin:'file:vendor/tnunamak-gozar-0.5.1.tgz', error:/installed Gozar must match the production pin/},
    {name:'file pin outside vendor', pin:'file:../tnunamak-gozar-0.5.1.tgz', error:/Gozar must be exactly pinned/},
    {name:'absent dependency', absent:true, error:/ENOENT/},
    {name:'wrong installed package name', packageName:'@tnunamak/not-gozar', source:'throw new Error("ENTRY_EVALUATED_BEFORE_IDENTITY");', error:/installed Gozar package name/},
    {name:'wrong installed version', version:'0.5.1', error:/installed Gozar must match the production pin/},
    {name:'dependency range', pin:'^0.5.0', error:/Gozar must be exactly pinned/},
    {name:'non-callable export', evaluated:true, source:'export const createGozar = 42;\n', error:/Gozar factory export must be callable/},
    {name:'broken import after valid identity', evaluated:true, source:'throw new Error("BROKEN_SDK_IMPORT");', error:/BROKEN_SDK_IMPORT/},
    ...['package', 'metadata', 'entry', 'entry-sibling', 'manifest'].map(escape => ({
      name:'external ' + escape, escape, error:/must remain inside/,
    })),
  ];
  for (const scenario of cases) await t.test(scenario.name,
    {skip:process.platform === 'win32' && Boolean(scenario.escape) ? 'requires unprivileged POSIX symlinks' : false}, t => {
    const work = mkdtempSync(join(tmpdir(), 'faravan-brew-smoke-'));
    t.after(() => rmSync(work, {recursive:true, force:true}));
    const libexec = join(work, 'libexec');
    mkdirSync(libexec);
    writeFileSync(join(libexec, 'package.json'), JSON.stringify({
      name:'faravan-brew-smoke-fixture', private:true, type:'module',
      dependencies:{'@tnunamak/gozar':scenario.pin ?? '0.5.0'},
    }));
    const marker = join(work, 'evaluated');
    if (!scenario.absent) {
      const sdk = join(libexec, 'node_modules/@tnunamak/gozar');
      mkdirSync(sdk, {recursive:true});
      writeFileSync(join(sdk, 'package.json'), JSON.stringify({
        name:scenario.packageName ?? '@tnunamak/gozar', version:scenario.version ?? '0.5.0',
        type:'module', exports:{import:'./index.mjs', default:'./unused.mjs'},
      }));
      // The oracle checks callability only. Invoking a factory is not this smoke test.
      const entry = 'import {writeFileSync} from "node:fs"; writeFileSync(' +
        JSON.stringify(marker) + ', "evaluated");\n' + (scenario.source ??
        'export function createGozar() { throw new Error("fixture factory must not be invoked"); }\n');
      writeFileSync(join(sdk, 'index.mjs'), entry);
      if (scenario.escape) {
        const outside = scenario.escape === 'entry-sibling' ? sdk + '-outside' : libexec + '-outside';
        mkdirSync(outside, {recursive:true});
        if (scenario.escape === 'package') {
          writeFileSync(join(outside, 'package.json'), readFileSync(join(sdk, 'package.json')));
          writeFileSync(join(outside, 'index.mjs'), entry);
          rmSync(sdk, {recursive:true});
          symlinkSync(outside, sdk);
        } else {
          const destination = scenario.escape === 'manifest' ? join(libexec, 'package.json') :
            scenario.escape === 'metadata' ? join(sdk, 'package.json') : join(sdk, 'index.mjs');
          const target = join(outside, scenario.escape === 'manifest' || scenario.escape === 'metadata' ?
            'package.json' : 'index.mjs');
          writeFileSync(target, readFileSync(destination));
          rmSync(destination);
          symlinkSync(target, destination);
        }
      }
    }
    // Do not inherit preload hooks or package search overrides from the host.
    const env = {...process.env};
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', payload], {
      cwd:libexec, env, encoding:'utf8', timeout:10000, killSignal:'SIGKILL', maxBuffer:1024 * 1024,
    });
    assert.equal(result.error, undefined, 'spawn errors and timeouts are not negative-control evidence');
    assert.equal(result.signal, null, 'a killed subprocess is not negative-control evidence');
    assert.equal(result.status, scenario.error ? 1 : 0, result.stderr || scenario.name);
    assert.equal(existsSync(marker), Boolean(scenario.evaluated), 'only identity-valid contained entries may be evaluated');
    if (scenario.error) assert.match(result.stderr, scenario.error);
    else assert.equal(result.stderr, '');
  });
});
