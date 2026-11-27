import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runV1Command} from '../lib/v1/cli.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = process.env.TEST_INSTALLER ?? join(root, 'bin', 'faravan-install.sh');

test('portable bash install updates interactive and existing login profiles, then uninstall restores both', async t => {
  const home = await mkdtemp(join(tmpdir(), 'faravan-path-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const tools = join(home, 'test-tools');
  const source = join(home, 'source');
  const scratch = join(home, 'tmp');
  const bin = join(home, '.local', 'bin');
  await mkdir(join(source, 'usr', 'lib', 'faravan', 'runtime', 'bin'), {recursive: true});
  await mkdir(tools, {recursive: true});
  await mkdir(scratch);
  const originalBashrc = '# user bashrc\nexport TEST_BASHRC_VALUE=kept\n';
  const originalProfile = '# user profile\nexport TEST_PROFILE_VALUE=kept\n';
  await writeFile(join(home, '.bashrc'), originalBashrc);
  await writeFile(join(home, '.profile'), originalProfile);
  await writeFile(join(source, 'usr', 'lib', 'faravan', 'runtime', 'bin', 'node'), '#!/bin/sh\nexit 0\n');
  await chmod(join(source, 'usr', 'lib', 'faravan', 'runtime', 'bin', 'node'), 0o755);
  await mkdir(join(source, 'usr', 'lib', 'faravan', 'bin'), {recursive: true});
  await writeFile(join(source, 'usr', 'lib', 'faravan', 'bin', 'faravan'), '#!/bin/sh\n[ "$1" = --readiness ] || [ "$1" = --version ]\n');
  const tarball = join(home, 'bundle.tar.gz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', source, 'usr'], {encoding: 'utf8'});
  assert.equal(tar.status, 0, tar.stderr);
  await writeFile(join(tools, 'curl'), `#!/bin/sh\ncase "$*" in\n  *faravan_amd64.deb*) exit 22 ;;\n  *faravan_linux_amd64.tar.gz*) if [ "$3" = -o ]; then cp '${tarball}' "$4"; else exit 0; fi ;;\n  *) exit 22 ;;\nesac\n`);
  await chmod(join(tools, 'curl'), 0o755);

  const env = {...process.env, HOME: home, SHELL: '/bin/bash', PATH: `${tools}:/usr/bin:/bin`, TMPDIR: scratch, FARAVAN_CHANNEL: 'stable', FARAVAN_DOWNLOAD_BASE: 'https://example.invalid', FARAVAN_NO_TRAY_LAUNCH: '1', FARAVAN_ALLOW_UNVERIFIED: '1', XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config')};
  const install = () => spawnSync('/bin/sh', [installer], {env, encoding: 'utf8'});
  const first = install();
  assert.equal(first.status, 0, first.stderr);
  const resolveInLoginShell = () => spawnSync('/usr/bin/env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', '/bin/bash', '-lc', 'command -v faravan'], {encoding: 'utf8'});
  const resolved = resolveInLoginShell();
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), join(bin, 'faravan'));
  const resolveInInteractiveShell = spawnSync('/bin/bash', ['--noprofile', '--rcfile', join(home, '.bashrc'), '-ic', 'command -v faravan'], {env: {...env, PATH: '/usr/bin:/bin'}, encoding: 'utf8'});
  assert.equal(resolveInInteractiveShell.stdout.trim(), join(bin, 'faravan'), resolveInInteractiveShell.stderr);
  assert.match(first.stdout, /Open a new terminal/);

  const afterFirst = await readFile(join(home, '.bashrc'), 'utf8');
  const profileAfterFirst = await readFile(join(home, '.profile'), 'utf8');
  await assert.rejects(access(join(home, '.bash_profile')), {code: 'ENOENT'});
  assert.match(first.stdout, /Open a new terminal/);
  const second = install();
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = await readFile(join(home, '.bashrc'), 'utf8');
  const profileAfterSecond = await readFile(join(home, '.profile'), 'utf8');
  assert.equal(afterSecond, afterFirst);
  assert.equal(profileAfterSecond, profileAfterFirst);
  for (const content of [afterSecond, profileAfterSecond]) {
    assert.equal((content.match(/^# Faravan command path$/gm) ?? []).length, 1);
    assert.ok(content.includes('case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'));
  }
  const fishInstall = spawnSync('/bin/sh', [installer], {env: {...env, SHELL: '/usr/bin/fish'}, encoding: 'utf8'});
  assert.equal(fishInstall.status, 0, fishInstall.stderr);
  assert.match(fishInstall.stdout, /fish_add_path/);
  assert.ok(fishInstall.stdout.includes(bin));
  const edited = afterSecond.replace('# Faravan command path\n', '# Faravan command path\n# user note\n');
  await writeFile(join(home, '.bashrc'), edited);
  assert.equal(install().status, 0);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), edited);
  await writeFile(join(home, '.bashrc'), afterSecond);

  const stdout = {write() {}};
  const stderr = {write() {}};
  const run = async (command, args) => command === 'systemctl' && args.includes('is-active')
    ? {code: 3, stdout: '', stderr: ''}
    : command === 'pgrep' ? {code: 1, stdout: '', stderr: ''} : {code: 0, stdout: '', stderr: ''};
  const uninstalled = await runV1Command(['uninstall', '--yes'], {
    home: join(home, '.faravan'), userHome: home, platform: 'linux', run, sleep: async () => {}, env: {SHELL: '/bin/bash'}, uid: 1000,
    installDir: join(home, '.local', 'lib', 'faravan'), stdout, stderr,
    device: {listCircles: async () => [], leaveCircle: async () => ({left: true})},
  });
  assert.equal(uninstalled, 0);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), originalBashrc);
  assert.equal(await readFile(join(home, '.profile'), 'utf8'), originalProfile);

  const foreign = '#!/bin/sh\nprintf foreign\n';
  await mkdir(bin, {recursive: true});
  await writeFile(join(bin, 'faravan'), foreign);
  const rejected = install();
  assert.notEqual(rejected.status, 0, 'a foreign faravan command blocks installation');
  assert.equal(await readFile(join(bin, 'faravan'), 'utf8'), foreign, 'the foreign command stays byte-for-byte intact');

  const foreignRoot = join(home, 'foreign-install');
  await mkdir(join(foreignRoot, 'bin'), {recursive: true});
  const foreignFaravan = '#!/bin/sh\nprintf foreign faravan\n';
  await writeFile(join(foreignRoot, 'bin', 'faravan'), foreignFaravan);
  const faravanRejected = spawnSync('/bin/sh', [installer], {env: {...env, FARAVAN_INSTALL_ROOT: foreignRoot}, encoding: 'utf8'});
  assert.notEqual(faravanRejected.status, 0, 'a foreign faravan command blocks installation');
  assert.equal(await readFile(join(foreignRoot, 'bin', 'faravan'), 'utf8'), foreignFaravan);

  const customRoot = join(home, 'custom-install');
  const customInstall = spawnSync('/bin/sh', [installer], {env: {...env, FARAVAN_INSTALL_ROOT: customRoot}, encoding: 'utf8'});
  assert.equal(customInstall.status, 0, customInstall.stderr);
  const customResolved = spawnSync('/usr/bin/env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', '/bin/bash', '-lc', 'command -v faravan'], {encoding: 'utf8'});
  assert.equal(customResolved.status, 0, customResolved.stderr);
  assert.equal(customResolved.stdout.trim(), join(customRoot, 'bin', 'faravan'));
  const customLine = `case ":$PATH:" in *":${customRoot}/bin:"*) ;; *) export PATH="${customRoot}/bin:$PATH" ;; esac`;
  assert.match(await readFile(join(home, '.profile'), 'utf8'), new RegExp(customLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await writeFile(join(home, '.profile'), `before profile line\n# Faravan command path\n${customLine}\nafter profile line\n`);
  const customUninstalled = await runV1Command(['uninstall', '--yes'], {
    home: join(home, '.faravan'), userHome: home, platform: 'linux', run, sleep: async () => {}, env: {...env, FARAVAN_INSTALL_ROOT: customRoot}, uid: 1000,
    installDir: join(customRoot, 'lib', 'faravan'), stdout, stderr,
    device: {listCircles: async () => [], leaveCircle: async () => ({left: true})},
  });
  assert.equal(customUninstalled, 0);
  assert.equal(await readFile(join(home, '.profile'), 'utf8'), 'before profile line\nafter profile line\n');
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), originalBashrc);
});

test('portable zsh install writes both ZDOTDIR startup files and uninstall restores them', async t => {
  const home = await mkdtemp(join(tmpdir(), 'faravan-zsh-path-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const zdotdir = join(home, 'zsh-config');
  const tools = join(home, 'test-tools'), source = join(home, 'source'), scratch = join(home, 'tmp');
  await mkdir(zdotdir); await mkdir(tools); await mkdir(scratch);
  await mkdir(join(source, 'usr', 'lib', 'faravan', 'runtime', 'bin'), {recursive: true});
  await mkdir(join(source, 'usr', 'lib', 'faravan', 'bin'), {recursive: true});
  await writeFile(join(zdotdir, '.zshrc'), '# user zshrc\n');
  await writeFile(join(zdotdir, '.zprofile'), '# user zprofile\n');
  await writeFile(join(source, 'usr', 'lib', 'faravan', 'runtime', 'bin', 'node'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  await writeFile(join(source, 'usr', 'lib', 'faravan', 'bin', 'faravan'), '#!/bin/sh\n[ "$1" = --readiness ] || [ "$1" = --version ]\n');
  const tarball = join(home, 'bundle.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', source, 'usr'], {encoding: 'utf8'}).status, 0);
  await writeFile(join(tools, 'curl'), `#!/bin/sh\ncase "$*" in\n  *faravan_amd64.deb*) exit 22 ;;\n  *faravan_linux_amd64.tar.gz*) if [ "$3" = -o ]; then cp '${tarball}' "$4"; else exit 0; fi ;;\n  *) exit 22 ;;\nesac\n`, {mode: 0o755});
  const env = {...process.env, HOME: home, ZDOTDIR: zdotdir, SHELL: '/bin/zsh', PATH: `${tools}:/usr/bin:/bin`, TMPDIR: scratch, FARAVAN_CHANNEL: 'stable', FARAVAN_DOWNLOAD_BASE: 'https://example.invalid', FARAVAN_NO_TRAY_LAUNCH: '1', FARAVAN_ALLOW_UNVERIFIED: '1', XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config')};
  const install = () => spawnSync('/bin/sh', [installer], {env, encoding: 'utf8'});
  const first = install(); assert.equal(first.status, 0, first.stderr);
  const originals = ['# user zshrc\n', '# user zprofile\n'];
  for (const name of ['.zshrc', '.zprofile']) assert.match(await readFile(join(zdotdir, name), 'utf8'), /^# user/);
  const run = async (command, args) => command === 'systemctl' && args.includes('is-active') ? {code: 3} : command === 'pgrep' ? {code: 1} : {code: 0};
  assert.equal(await runV1Command(['uninstall', '--yes'], {home: join(home, '.faravan'), userHome: home, platform: 'linux', run, sleep: async () => {}, env, uid: 1000, installDir: join(home, '.local', 'lib', 'faravan'), stdout: {write() {}}, stderr: {write() {}}, device: {listCircles: async () => [], leaveCircle: async () => ({left: true})}}), 0);
  for (let index = 0; index < 2; index++) assert.equal(await readFile(join(zdotdir, ['.zshrc', '.zprofile'][index]), 'utf8'), originals[index]);
});

test('Windows MSIX declares the faravan execution alias and CLI executable', async () => {
  const manifest = join(root, 'packaging/windows/AppxManifest.template.xml');
  const parsed = spawnSync('python3', ['-c', `import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
ns = {'a':'http://schemas.microsoft.com/appx/manifest/foundation/windows10', 'u3':'http://schemas.microsoft.com/appx/manifest/uap/windows10/3', 'd':'http://schemas.microsoft.com/appx/manifest/desktop/windows10'}
extension = root.find('.//u3:Extension[@Category="windows.appExecutionAlias"]', ns)
alias = extension.find('.//d:ExecutionAlias', ns) if extension is not None else None
print(json.dumps({'executable': extension.get('Executable') if extension is not None else None, 'alias': alias.get('Alias') if alias is not None else None}))`, manifest], {encoding: 'utf8'});
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout), {executable: 'faravan.exe', alias: 'faravan.exe'});
});
